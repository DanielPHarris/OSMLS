import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { dataConsumer, dataRequest, media, member, type DataConsumer, type Member } from "../db/schema";
import { can } from "./access";
import { ListingError } from "./listings";
import { appUrl } from "./mail";
import { getMarketTime, withOneSettingsVersion } from "./market-time";
import { actingStaff, takeAuthorityTurn } from "./members";
import { ODataError, parseCount, parseFilter, parseOrderBy, parseSelect, type Filter, type Literal } from "./odata";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, SERVED_RESOURCES, servedResource, type ServedField, type ServedResource } from "./rules/data-exchange";

/*
 * The data exchange feed: a read-only RESO Web API (OData) endpoint for outside
 * systems. What it may carry is the export allowlist in
 * src/lib/rules/data-exchange.ts, and nothing else: every query here is built
 * from that list, column by column, so a field that is not on it cannot be
 * selected, filtered on, sorted by, or returned.
 *
 * A reader is a data consumer: a named record staff make, holding a bearer
 * token. Only a hash of the token is kept, so it can be shown once and never
 * read back.
 */

const notFound = () => new ListingError("Not found.");
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Where the feed lives. The metadata document and every link in a response are under it. */
export const serviceRoot = () => `${appUrl()}/api/reso`;
export const photoUrl = (mediaKey: string) => `${appUrl()}/api/reso-photo/${mediaKey}`;

// ---- Data consumers ----

/**
 * Makes a data consumer and its bearer token. The token is returned here once
 * and cannot be read again: only its hash is stored.
 */
export async function createDataConsumer(actor: Member | null, input: { name?: unknown; expiresInDays?: unknown }): Promise<{ consumer: DataConsumer; token: string }> {
  if (!can(actor, "data")) throw notFound();
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ListingError("Give the data consumer a name.", { name: "A name is required." });
  if (name.length > 120) throw new ListingError("Keep the name to 120 characters.", { name: "Use 120 characters or fewer." });
  const days = input.expiresInDays == null || input.expiresInDays === "" ? null : Number(input.expiresInDays);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    throw new ListingError("Give the expiry as a whole number of days, or leave it blank.", { expiresInDays: "Enter 1 to 3650 days, or nothing." });
  }
  const token = randomBytes(32).toString("base64url");
  const consumer = await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor, "data");
    const [row] = await tx
      .insert(dataConsumer)
      .values({
        ConsumerName: name,
        OsmlsTokenHash: hashToken(token),
        CreatedByMemberKey: by.MemberKey,
        ExpirationTimestamp: days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      })
      .returning();
    return row;
  });
  return { consumer, token };
}

/** Ends a data consumer's access. Its token is refused from the next request. Revoking twice changes nothing. */
export async function revokeDataConsumer(actor: Member | null, consumerKey: unknown): Promise<void> {
  if (!can(actor, "data") || !isKey(consumerKey)) throw notFound();
  await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor, "data");
    const [found] = await tx.select().from(dataConsumer).where(eq(dataConsumer.ConsumerKey, consumerKey)).for("update");
    if (!found) throw notFound();
    if (found.RevokedTimestamp) return;
    await tx.update(dataConsumer).set({ RevokedTimestamp: new Date(), RevokedByMemberKey: by.MemberKey }).where(eq(dataConsumer.ConsumerKey, consumerKey));
  });
}

/** Every data consumer, newest first, without its token hash. Null for anyone who does not manage data access. */
export async function listDataConsumers(actor: Member | null) {
  if (!can(actor, "data")) return null;
  return db
    .select({
      consumerKey: dataConsumer.ConsumerKey,
      name: dataConsumer.ConsumerName,
      createdAt: dataConsumer.OriginalEntryTimestamp,
      createdBy: member.MemberFullName,
      expiresAt: dataConsumer.ExpirationTimestamp,
      revokedAt: dataConsumer.RevokedTimestamp,
      requests: sql<number>`(select count(*)::int from "OsmlsDataRequest" r where r."ConsumerKey" = "OsmlsDataConsumer"."ConsumerKey")`,
      lastRequestAt: sql<Date | null>`(select max(r."RequestTimestamp") from "OsmlsDataRequest" r where r."ConsumerKey" = "OsmlsDataConsumer"."ConsumerKey")`,
    })
    .from(dataConsumer)
    .innerJoin(member, eq(member.MemberKey, dataConsumer.CreatedByMemberKey))
    .orderBy(desc(dataConsumer.OriginalEntryTimestamp));
}

/**
 * The data consumer a request's Authorization header belongs to, or null. A
 * token that is unknown, revoked, or past its expiry is no token: the caller
 * answers all three alike.
 */
export async function consumerFor(authorization: string | null): Promise<DataConsumer | null> {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(authorization ?? "");
  if (!match) return null;
  const [found] = await db
    .select()
    .from(dataConsumer)
    .where(and(eq(dataConsumer.OsmlsTokenHash, hashToken(match[1])), isNull(dataConsumer.RevokedTimestamp)));
  if (!found || (found.ExpirationTimestamp && found.ExpirationTimestamp.getTime() <= Date.now())) return null;
  return found;
}

/** Records what a data consumer asked for and how many records it was given. */
export const logRequest = (consumer: DataConsumer, resource: string, query: string, status: number, records: number) =>
  db.insert(dataRequest).values({ ConsumerKey: consumer.ConsumerKey, ResourceName: resource, Query: query.slice(0, 2000), Status: status, RecordCount: records });

// ---- Reading records ----

const column = (f: ServedField) => sql.identifier(f.name);

/** A stored field as the feed gives it: numbers as numbers, dates and times in ISO form, read in SQL so nothing depends on the driver. */
function output(f: ServedField): SQL {
  switch (f.type) {
    case "Edm.Decimal":
      return sql`${column(f)}::float8`;
    case "Edm.Date":
      return sql`${column(f)}::text`;
    case "Edm.DateTimeOffset":
      return sql`to_char(${column(f)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case "Edm.Int32":
      return sql`${column(f)}`;
    default:
      return sql`${column(f)}::text`;
  }
}

function value(f: ServedField, v: Exclude<Literal, { kind: "null" }>): SQL {
  if (f.type === "Edm.Date") return sql`${v.value}::date`;
  if (f.type === "Edm.DateTimeOffset") return sql`${v.value}::timestamptz`;
  if (f.type === "Edm.String") return sql`${v.value}::text`;
  return sql`${v.value}::numeric`;
}

function condition(filter: Filter): SQL {
  if ("left" in filter) {
    return filter.op === "and" ? sql`(${condition(filter.left)} and ${condition(filter.right)})` : sql`(${condition(filter.left)} or ${condition(filter.right)})`;
  }
  if ("operand" in filter) return sql`(not coalesce(${condition(filter.operand)}, false))`;
  const { field, value: v } = filter;
  // Compared as its own type; keys are stored as uuid and compared as text.
  const left = field.type === "Edm.String" ? sql`${column(field)}::text` : column(field);
  if (v.kind === "null") return filter.op === "eq" ? sql`${left} is null` : sql`${left} is not null`;
  const operator = { eq: sql`=`, ne: sql`<>`, gt: sql`>`, ge: sql`>=`, lt: sql`<`, le: sql`<=` }[filter.op];
  return sql`${left} ${operator} ${value(field, v)}`;
}

export type Page = {
  context: string;
  count?: number;
  value: Record<string, unknown>[];
  nextLink?: string;
};

/** Fills in the fields that are worked out, for the records on one page. */
async function derive(resource: ServedResource, wanted: readonly ServedField[], rows: Record<string, unknown>[]) {
  const names = new Set(wanted.filter((f) => f.derived).map((f) => f.name));
  if (names.size === 0 || rows.length === 0) return;
  if (resource.name === "Property") {
    const marketTime = await getMarketTime(rows.map((r) => String(r.__key)));
    for (const row of rows) {
      const found = marketTime.get(String(row.__key));
      if (names.has("DaysOnMarket")) row.DaysOnMarket = found?.daysOnMarket ?? 0;
      if (names.has("CumulativeDaysOnMarket")) row.CumulativeDaysOnMarket = found?.cumulativeDaysOnMarket ?? 0;
    }
  }
  if (resource.name === "Media" && names.has("MediaURL")) for (const row of rows) row.MediaURL = photoUrl(String(row.__key));
}

const contextFor = (resource: ServedResource, selected: readonly ServedField[], all: boolean, one = false) =>
  `${serviceRoot()}/$metadata#${resource.name}${all ? "" : `(${selected.map((f) => f.name).join(",")})`}${one ? "/$entity" : ""}`;

/**
 * Answers one read of a served resource: a page of records, or one record when
 * `key` is given. Everything the request names is checked against the
 * allowlist first; an unknown resource, field or option is refused.
 */
export async function readResource(resourceName: string, params: URLSearchParams, key?: string): Promise<Page | Record<string, unknown>> {
  const resource = servedResource(resourceName);
  if (!resource) throw new ODataError(`There is no resource "${resourceName}".`, 404, "NotFound");
  for (const name of params.keys()) {
    if (!["$select", "$filter", "$orderby", "$top", "$skip", "$count", "$format"].includes(name)) throw new ODataError(`The query option "${name}" is not supported.`);
  }
  const selected = parseSelect(resource, params.get("$select"));
  const all = !params.get("$select") || params.get("$select")!.trim() === "*";
  const filter = key === undefined ? parseFilter(resource, params.get("$filter")) : null;
  const order = key === undefined ? parseOrderBy(resource, params.get("$orderby")) : [];
  const top = Math.min(parseCount("$top", params.get("$top"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const skip = parseCount("$skip", params.get("$skip"), 0);
  const wantsCount = params.get("$count") === "true";
  if (params.get("$count") && !["true", "false"].includes(params.get("$count")!)) throw new ODataError("$count must be true or false.");

  const keyField = resource.fields.find((f) => f.name === resource.key)!;
  const table = sql.identifier(resource.table);
  const where = sql.join(
    [
      resource.only ? sql.raw(`(${resource.only})`) : sql`true`,
      filter ? condition(filter) : sql`true`,
      key === undefined ? sql`true` : isKey(key) ? sql`${column(keyField)} = ${key}::uuid` : sql`false`,
    ],
    sql` and `,
  );
  const columns = sql.join(
    [sql`${column(keyField)}::text as "__key"`, ...selected.filter((f) => !f.derived).map((f) => sql`${output(f)} as ${sql.identifier(f.name)}`)],
    sql`, `,
  );
  // Always ending in the key, so the order is the same from one page to the next.
  const ordering = sql.join(
    [...order.map((o) => (o.descending ? sql`${column(o.field)} desc nulls last` : sql`${column(o.field)} asc nulls first`)), sql`${column(keyField)} asc`],
    sql`, `,
  );

  return withOneSettingsVersion(async () => {
    // One more than the page, to know whether there is another.
    const found = (await db.execute(sql`select ${columns} from ${table} where ${where} order by ${ordering} limit ${top + 1} offset ${skip}`)).rows as Record<string, unknown>[];
    const rows = found.slice(0, top);
    await derive(resource, selected, rows);
    const shaped = rows.map((row) => Object.fromEntries(selected.map((f) => [f.name, row[f.name] ?? null])));
    if (key !== undefined) {
      if (shaped.length === 0) throw new ODataError(`There is no ${resource.name} with that key.`, 404, "NotFound");
      return { "@odata.context": contextFor(resource, selected, all, true), ...shaped[0] };
    }
    const page: Page = { context: contextFor(resource, selected, all), value: shaped };
    if (wantsCount) page.count = Number((await db.execute(sql`select count(*)::int as n from ${table} where ${where}`)).rows[0].n);
    if (found.length > top) {
      const next = new URLSearchParams(params);
      next.set("$skip", String(skip + top));
      next.set("$top", String(top));
      page.nextLink = `${serviceRoot()}/${resource.name}?${next.toString().replace(/%24/g, "$")}`;
    }
    return page;
  });
}

/** A photo's record, for the feed's photo route. Null for a document, another kind of record, or no record: all alike. */
export async function servedPhoto(mediaKey: string) {
  if (!isKey(mediaKey)) return null;
  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.MediaKey, mediaKey), eq(media.MediaCategory, "Photo"), eq(media.ResourceName, "Property")));
  return row ?? null;
}

// ---- Describing the feed ----

const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The OData metadata document, written from the allowlist and from nothing else. */
export function metadataDocument(): string {
  const types = SERVED_RESOURCES.map((r) => {
    const properties = r.fields
      .map((f) => {
        const facets = f.type === "Edm.DateTimeOffset" ? ` Precision="27"` : f.type === "Edm.Decimal" ? ` Scale="variable"` : "";
        return `        <Property Name="${xml(f.name)}" Type="${f.type}"${f.name === r.key ? ` Nullable="false"` : ""}${facets}/>`;
      })
      .join("\n");
    return `      <EntityType Name="${xml(r.name)}">\n        <Key><PropertyRef Name="${xml(r.key)}"/></Key>\n${properties}\n      </EntityType>`;
  }).join("\n");
  const sets = SERVED_RESOURCES.map((r) => `        <EntitySet Name="${xml(r.name)}" EntityType="org.reso.metadata.${xml(r.name)}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="org.reso.metadata">
${types}
      <EntityContainer Name="Default">
${sets}
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;
}

/** The service document: the resources the feed has. */
export const serviceDocument = () => ({
  "@odata.context": `${serviceRoot()}/$metadata`,
  value: SERVED_RESOURCES.map((r) => ({ name: r.name, kind: "EntitySet", url: r.name })),
});
