import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { dataConsumer, dataRequest, media, member, type DataConsumer, type Member } from "../db/schema";
import { can } from "./access";
import { ListingError } from "./listings";
import { appUrl } from "./mail";
import { getMarketTime, withOneSettingsVersion } from "./market-time";
import { actingStaff, takeAuthorityTurn } from "./members";
import { ODataError, parseCount, parseExpand, parseFilter, parseOrderBy, parseSelect, type Filter, type Literal, type Order } from "./odata";
import {
  DEFAULT_PAGE_SIZE,
  DESCRIPTION_CHANGED,
  FIXED_LOOKUPS,
  FOUND_LOOKUPS,
  MAX_PAGE_SIZE,
  MAX_REQUESTS_PER_MINUTE,
  SERVED_RESOURCES,
  servedResource,
  type EdmType,
  type ServedField,
  type ServedResource,
} from "./rules/data-exchange";

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
      // Decided by the database's clock, the same one a request's token is checked against.
      state: sql<"Active" | "Expired" | "Revoked">`case when ${dataConsumer.RevokedTimestamp} is not null then 'Revoked' when ${dataConsumer.ExpirationTimestamp} <= now() then 'Expired' else 'Active' end`,
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
    .where(
      and(
        eq(dataConsumer.OsmlsTokenHash, hashToken(match[1])),
        isNull(dataConsumer.RevokedTimestamp),
        sql`(${dataConsumer.ExpirationTimestamp} is null or ${dataConsumer.ExpirationTimestamp} > now())`,
      ),
    );
  return found ?? null;
}

/** Whether a data consumer has made as many requests in the last minute as it may. */
export async function overLimit(consumer: DataConsumer): Promise<boolean> {
  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(dataRequest)
    .where(and(eq(dataRequest.ConsumerKey, consumer.ConsumerKey), sql`${dataRequest.RequestTimestamp} > now() - interval '1 minute'`));
  return recent >= MAX_REQUESTS_PER_MINUTE;
}

/** Records what a data consumer asked for and how many records it was given. */
export const logRequest = (consumer: DataConsumer, resource: string, query: string, status: number, records: number) =>
  db.insert(dataRequest).values({ ConsumerKey: consumer.ConsumerKey, ResourceName: resource, Query: query.slice(0, 2000), Status: status, RecordCount: records });

// ---- Reading records ----

/*
 * Every read is one SQL query over one relation, built from the allowlist:
 *
 * - a table, for records OSMLS stores;
 * - a table joined to the days-on-market figures, when a query filters or
 *   sorts on them (they are not stored, so they are worked out for every
 *   listing first, by the one calculation the screens use);
 * - a relation made from the allowlist itself, for Field and Lookup.
 *
 * Filtering, ordering, counting and paging are then the same for all three.
 */

const PG_TYPE: Record<EdmType, string> = { "Edm.String": "text", "Edm.Int32": "integer", "Edm.Decimal": "numeric", "Edm.Date": "date", "Edm.DateTimeOffset": "timestamptz" };

/** A relation given to the database as one JSON value, with the columns named and typed from the allowlist. */
const relationOf = (alias: string, columns: readonly { name: string; type: EdmType }[], rows: unknown[]): SQL =>
  sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as ${sql.identifier(alias)}(${sql.join(
    columns.map((c) => sql`${sql.identifier(c.name)} ${sql.raw(PG_TYPE[c.type])}`),
    sql`, `,
  )})`;

const column = (f: ServedField) => sql.identifier(f.name);

/**
 * A field as it is compared, sorted, and paged by. A time is taken to the
 * millisecond, which is how it is served, so that a filter on a served value
 * finds the record it came from; what is stored keeps its full precision.
 * Text includes keys, so one expression serves every use.
 */
function comparableColumn(f: ServedField): SQL {
  if (f.type === "Edm.DateTimeOffset") return sql`date_trunc('milliseconds', ${column(f)})`;
  if (f.type === "Edm.String") return sql`${column(f)}::text`;
  return sql`${column(f)}`;
}

/** A field as the feed gives it: numbers as numbers, dates and times in ISO form, read in SQL so nothing depends on the driver. */
function output(f: ServedField): SQL {
  switch (f.type) {
    case "Edm.Decimal":
      return sql`${column(f)}::float8`;
    case "Edm.Date":
      return sql`${column(f)}::text`;
    case "Edm.DateTimeOffset":
      return sql`to_char(${comparableColumn(f)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case "Edm.Int32":
      return sql`${column(f)}`;
    default:
      return sql`${column(f)}::text`;
  }
}

function comparableValue(f: ServedField, v: string | number): SQL {
  if (f.type === "Edm.Date") return sql`${v}::date`;
  if (f.type === "Edm.DateTimeOffset") return sql`date_trunc('milliseconds', ${v}::timestamptz)`;
  if (f.type === "Edm.String") return sql`${v}::text`;
  return sql`${v}::numeric`;
}

function condition(filter: Filter): SQL {
  if ("left" in filter) {
    return filter.op === "and" ? sql`(${condition(filter.left)} and ${condition(filter.right)})` : sql`(${condition(filter.left)} or ${condition(filter.right)})`;
  }
  if ("operand" in filter) return sql`(not coalesce(${condition(filter.operand)}, false))`;
  const { field, value: v } = filter;
  const left = comparableColumn(field);
  if (v.kind === "null") return filter.op === "eq" ? sql`${left} is null` : sql`${left} is not null`;
  const operator = { eq: sql`=`, ne: sql`<>`, gt: sql`>`, ge: sql`>=`, lt: sql`<`, le: sql`<=` }[filter.op];
  return sql`${left} ${operator} ${comparableValue(field, (v as Exclude<Literal, { kind: "null" }>).value)}`;
}

const keyOrder = (keyField: ServedField) => sql`${column(keyField)}::text collate "C"`;

/**
 * Where the next page starts: after the last record of the page before, in the
 * order asked for. A page link carries that record's place (its values of the
 * order fields, and its key) and not a count of records to skip, so a record
 * added or moved while a consumer is reading cannot make it repeat or miss one.
 */
function after(order: readonly Order[], keyField: ServedField, place: (string | null)[]): SQL {
  const same = (i: number) =>
    place[i] === null ? sql`${comparableColumn(order[i].field)} is null` : sql`${comparableColumn(order[i].field)} = ${comparableValue(order[i].field, place[i]!)}`;
  const beyond = (i: number): SQL => {
    const { field, descending } = order[i];
    const v = place[i];
    // Ascending puts empty values first; descending puts them last.
    if (!descending) return v === null ? sql`${comparableColumn(field)} is not null` : sql`${comparableColumn(field)} > ${comparableValue(field, v)}`;
    return v === null ? sql`false` : sql`(${comparableColumn(field)} < ${comparableValue(field, v)} or ${comparableColumn(field)} is null)`;
  };
  const alternatives: SQL[] = [];
  for (let i = 0; i <= order.length; i++) {
    const ties = Array.from({ length: i }, (_, j) => same(j));
    const then = i === order.length ? sql`${keyOrder(keyField)} > ${place[i]!}` : beyond(i);
    alternatives.push(sql`(${sql.join([...ties, then], sql` and `)})`);
  }
  return sql`(${sql.join(alternatives, sql` or `)})`;
}

const encodePlace = (place: (string | null)[]) => Buffer.from(JSON.stringify(place)).toString("base64url");
function decodePlace(token: string, length: number): (string | null)[] {
  try {
    const place: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (Array.isArray(place) && place.length === length && place.every((v) => v === null || typeof v === "string") && typeof place[length - 1] === "string") return place;
  } catch {
    // Falls through to the refusal below.
  }
  throw new ODataError("$skiptoken is not one this service gave for this query.");
}

// ---- The two resources that describe the feed ----

const spaced = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2");
const described = SERVED_RESOURCES.filter((r) => !r.described);

/** One record per served field of the resources that carry data. */
const fieldRecords = () =>
  described.flatMap((r) =>
    r.fields.map((f) => ({ FieldKey: `${r.name}.${f.name}`, ResourceName: r.name, FieldName: f.name, DisplayName: spaced(f.name), ModificationTimestamp: DESCRIPTION_CHANGED })),
  );

const lookupKey = (name: string, value: string) => createHash("sha256").update(`${name}\n${value}`).digest("hex").slice(0, 32);

/**
 * One record per value of each lookup a served field holds. A fixed list is
 * given whole, each value marked as the standard value it is. A lookup OSMLS
 * does not fix is given as the values found in served records, and only
 * those; such a value is called standard only where the allowlist gives a
 * list to check it against, and it is on that list.
 */
async function lookupRecords() {
  const fixed = Object.entries(FIXED_LOOKUPS).flatMap(([name, values]) =>
    values.map((value) => ({ LookupKey: lookupKey(name, value), LookupName: name, LookupValue: value, StandardLookupValue: value, LegacyODataValue: null, ModificationTimestamp: DESCRIPTION_CHANGED })),
  );
  const found: typeof fixed = [];
  for (const [name, { sources, standard }] of Object.entries(FOUND_LOOKUPS)) {
    const values = new Map<string, string>();
    for (const source of sources) {
      const resource = servedResource(source.resource)!;
      // Only records the feed serves are looked at: the same fixed condition every read of the resource carries.
      const rows = (
        await db.execute(sql`
          select ${sql.identifier(source.field)}::text as value,
            to_char(max(date_trunc('milliseconds', "ModificationTimestamp")) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as changed
          from ${sql.identifier(resource.table)}
          where ${resource.only ? sql.raw(`(${resource.only})`) : sql`true`} and ${sql.identifier(source.field)} is not null
          group by 1`)
      ).rows as { value: string; changed: string }[];
      for (const row of rows) if (!values.has(row.value) || values.get(row.value)! < row.changed) values.set(row.value, row.changed);
    }
    for (const [value, changed] of values) {
      // Standard only if it is on the list given for this lookup; otherwise a local value, with no standard value claimed.
      const standardValue = standard?.includes(value) ? value : null;
      found.push({ LookupKey: lookupKey(name, value), LookupName: name, LookupValue: value, StandardLookupValue: standardValue as string, LegacyODataValue: null, ModificationTimestamp: changed });
    }
  }
  return [...fixed, ...found];
}

// ---- Answering a read ----

export type Page = {
  context: string;
  count?: number;
  value: Record<string, unknown>[];
  nextLink?: string;
};

const contextFor = (resource: ServedResource, selected: readonly ServedField[], all: boolean, one = false) =>
  `${serviceRoot()}/$metadata#${resource.name}${all ? "" : `(${selected.map((f) => f.name).join(",")})`}${one ? "/$entity" : ""}`;

const mentions = (filter: Filter | null, test: (f: ServedField) => boolean): boolean =>
  filter === null ? false : "left" in filter ? mentions(filter.left, test) || mentions(filter.right, test) : "operand" in filter ? mentions(filter.operand, test) : test(filter.field);

/** The relation a read is made over, and which of its derived fields that relation already holds. */
async function relationFor(resource: ServedResource, needsFigures: boolean, asOf: Date): Promise<{ from: SQL; holds: (f: ServedField) => boolean }> {
  if (resource.described === "fields") return { from: relationOf(resource.table, resource.fields, fieldRecords()), holds: () => true };
  if (resource.described === "lookups") return { from: relationOf(resource.table, resource.fields, await lookupRecords()), holds: () => true };
  const table = sql.identifier(resource.table);
  if (!needsFigures) return { from: sql`${table}`, holds: (f) => !f.derived };
  // Filtering or sorting on the figures needs them for every served listing, not only for one page.
  const keyField = resource.fields.find((f) => f.name === resource.key)!;
  const keys = (
    await db.execute(sql`select ${column(keyField)}::text as key from ${table} where ${resource.only ? sql.raw(`(${resource.only})`) : sql`true`}`)
  ).rows.map((r) => String(r.key));
  const marketTime = await getMarketTime(keys, { asOf });
  const figures = keys.map((key) => ({ __listing: key, DaysOnMarket: marketTime.get(key)?.daysOnMarket ?? 0, CumulativeDaysOnMarket: marketTime.get(key)?.cumulativeDaysOnMarket ?? 0 }));
  const columns = [{ name: "__listing", type: "Edm.String" as const }, ...resource.fields.filter((f) => f.derived && f.queryable)];
  return {
    from: sql`${table} join ${relationOf("__figures", columns, figures)} on "__figures"."__listing" = ${column(keyField)}::text`,
    holds: (f) => !f.derived || !!f.queryable,
  };
}

/** Fills in, for the records on one page, the derived fields the relation did not hold. */
async function derive(resource: ServedResource, missing: readonly ServedField[], rows: Record<string, unknown>[], asOf: Date) {
  const names = new Set(missing.map((f) => f.name));
  if (names.size === 0 || rows.length === 0) return;
  if (resource.name === "Property") {
    const marketTime = await getMarketTime(rows.map((r) => String(r.__key)), { asOf });
    for (const row of rows) {
      const found = marketTime.get(String(row.__key));
      if (names.has("DaysOnMarket")) row.DaysOnMarket = found?.daysOnMarket ?? 0;
      if (names.has("CumulativeDaysOnMarket")) row.CumulativeDaysOnMarket = found?.cumulativeDaysOnMarket ?? 0;
    }
  }
  if (resource.name === "Media" && names.has("MediaURL")) for (const row of rows) row.MediaURL = photoUrl(String(row.__key));
}

/** The records of another served resource that belong to the records on a page, held to that resource's own allowlist and condition. */
async function expanded(expand: NonNullable<ServedResource["expand"]>, parentKeys: string[], asOf: Date): Promise<Map<string, Record<string, unknown>[]>> {
  const resource = servedResource(expand.resource)!;
  const out = new Map<string, Record<string, unknown>[]>();
  if (parentKeys.length === 0) return out;
  const keyField = resource.fields.find((f) => f.name === resource.key)!;
  const on = resource.fields.find((f) => f.name === expand.on)!;
  const by = resource.fields.find((f) => f.name === expand.orderBy)!;
  const stored = resource.fields.filter((f) => !f.derived);
  const rows = (
    await db.execute(sql`
      select ${column(keyField)}::text as "__key", ${column(on)}::text as "__parent", ${sql.join(stored.map((f) => sql`${output(f)} as ${sql.identifier(f.name)}`), sql`, `)}
      from ${sql.identifier(resource.table)}
      where ${resource.only ? sql.raw(`(${resource.only})`) : sql`true`} and ${column(on)}::text in (${sql.join(parentKeys.map((k) => sql`${k}`), sql`, `)})
      order by ${column(by)}, ${keyOrder(keyField)}`)
  ).rows as Record<string, unknown>[];
  await derive(resource, resource.fields.filter((f) => f.derived), rows, asOf);
  for (const row of rows) {
    const shaped = Object.fromEntries(resource.fields.map((f) => [f.name, row[f.name] ?? null]));
    out.set(String(row.__parent), [...(out.get(String(row.__parent)) ?? []), shaped]);
  }
  return out;
}

const OPTIONS = ["$select", "$filter", "$orderby", "$top", "$skip", "$skiptoken", "$count", "$expand", "$format"];

/**
 * Answers one read of a served resource: a page of records, or one record when
 * `key` is given. Everything the request names is checked against the
 * allowlist first; an unknown resource, field or option is refused.
 *
 * $top is the most records the consumer wants. A page holds that many, or the
 * server's own limit if that is fewer (the consumer may ask for a lower limit
 * with `maxPageSize`), and only a page the server cut short carries a link to
 * the next.
 */
export async function readResource(resourceName: string, params: URLSearchParams, key?: string, options: { maxPageSize?: number | null } = {}): Promise<Page | Record<string, unknown>> {
  const resource = servedResource(resourceName);
  if (!resource) throw new ODataError(`There is no resource "${resourceName}".`, 404, "NotFound");
  for (const name of params.keys()) if (!OPTIONS.includes(name)) throw new ODataError(`The query option "${name}" is not supported.`);
  const selected = parseSelect(resource, params.get("$select"));
  const all = !params.get("$select") || params.get("$select")!.trim() === "*";
  const expands = parseExpand(resource, params.get("$expand"));
  const filter = key === undefined ? parseFilter(resource, params.get("$filter")) : null;
  const order = key === undefined ? parseOrderBy(resource, params.get("$orderby")) : [];
  const wanted = params.get("$top") === null ? null : parseCount("$top", params.get("$top"), 0);
  const skip = parseCount("$skip", params.get("$skip"), 0);
  const token = key === undefined ? params.get("$skiptoken") : null;
  if (token !== null && params.get("$skip") !== null) throw new ODataError("Use $skip or $skiptoken, not both.");
  if (params.get("$count") && !["true", "false"].includes(params.get("$count")!)) throw new ODataError("$count must be true or false.");
  const wantsCount = params.get("$count") === "true";
  const limit = Math.min(options.maxPageSize ?? (wanted === null ? DEFAULT_PAGE_SIZE : MAX_PAGE_SIZE), MAX_PAGE_SIZE);
  const pageSize = wanted === null ? limit : Math.min(wanted, limit);

  const keyField = resource.fields.find((f) => f.name === resource.key)!;
  const isFigure = (f: ServedField) => !!f.derived && !!f.queryable;
  const needsFigures = mentions(filter, isFigure) || order.some((o) => isFigure(o.field));

  return withOneSettingsVersion(async () => {
    // One moment for the whole answer, so every figure in it is as of the same time.
    const asOf = new Date();
    const { from, holds } = await relationFor(resource, needsFigures, asOf);
    // What the result is, without regard to which page of it is wanted.
    const matching = sql.join(
      [
        resource.only && !resource.described ? sql.raw(`(${resource.only})`) : sql`true`,
        filter ? condition(filter) : sql`true`,
        key === undefined ? sql`true` : sql`${column(keyField)}::text = ${key}`,
      ],
      sql` and `,
    );
    const where = token === null ? matching : sql`${matching} and ${after(order, keyField, decodePlace(token, order.length + 1))}`;
    const columns = sql.join(
      [
        sql`${column(keyField)}::text as "__key"`,
        // Each record's place in the order, for the link to the page after it.
        ...order.map((o, i) => sql`${comparableColumn(o.field)}::text as ${sql.identifier(`__place${i}`)}`),
        ...selected.filter(holds).map((f) => sql`${output(f)} as ${sql.identifier(f.name)}`),
      ],
      sql`, `,
    );
    // Always ending in the key, so no two records share a place and the order never varies.
    const ordering = sql.join(
      [...order.map((o) => (o.descending ? sql`${comparableColumn(o.field)} desc nulls last` : sql`${comparableColumn(o.field)} asc nulls first`)), sql`${keyOrder(keyField)} asc`],
      sql`, `,
    );
    // One more than the page, to know whether there is another.
    const found = (await db.execute(sql`select ${columns} from ${from} where ${where} order by ${ordering} limit ${pageSize + 1} offset ${skip}`)).rows as Record<string, unknown>[];
    const rows = found.slice(0, pageSize);
    await derive(resource, selected.filter((f) => !holds(f)), rows, asOf);
    const shaped = rows.map((row) => Object.fromEntries(selected.map((f) => [f.name, row[f.name] ?? null])) as Record<string, unknown>);
    for (const expand of expands) {
      const children = await expanded(expand, rows.map((r) => String(r.__key)), asOf);
      rows.forEach((row, i) => (shaped[i][expand.name] = children.get(String(row.__key)) ?? []));
    }
    if (key !== undefined) {
      if (shaped.length === 0) throw new ODataError(`There is no ${resource.name} with that key.`, 404, "NotFound");
      return { "@odata.context": contextFor(resource, selected, all, true), ...shaped[0] };
    }
    const page: Page = { context: contextFor(resource, selected, all), value: shaped };
    // The count is of the whole result, whichever page this is.
    if (wantsCount) page.count = Number((await db.execute(sql`select count(*)::int as n from ${from} where ${matching}`)).rows[0].n);
    const stillWanted = wanted === null ? null : wanted - rows.length;
    if (found.length > pageSize && rows.length > 0 && (stillWanted === null || stillWanted > 0)) {
      const last = rows[rows.length - 1];
      const next = new URLSearchParams(params);
      next.delete("$skip");
      next.delete("$top");
      if (stillWanted !== null) next.set("$top", String(stillWanted));
      next.set("$skiptoken", encodePlace([...order.map((_, i) => (last[`__place${i}`] as string | null) ?? null), String(last.__key)]));
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
        const facets = f.type === "Edm.DateTimeOffset" ? ` Precision="27"` : "";
        const open = `        <Property Name="${xml(f.name)}" Type="${f.type}"${f.name === r.key ? ` Nullable="false"` : ""}${facets}`;
        // A field that holds one of a list of values says which list, so its values can be read from the Lookup resource.
        return f.lookup ? `${open}>\n          <Annotation Term="RESO.OData.Metadata.LookupName" String="${xml(f.lookup)}"/>\n        </Property>` : `${open}/>`;
      })
      .join("\n");
    const navigation = r.expand ? `\n        <NavigationProperty Name="${xml(r.expand.name)}" Type="Collection(org.reso.metadata.${xml(r.expand.resource)})"/>` : "";
    return `      <EntityType Name="${xml(r.name)}">\n        <Key><PropertyRef Name="${xml(r.key)}"/></Key>\n${properties}${navigation}\n      </EntityType>`;
  }).join("\n");
  const sets = SERVED_RESOURCES.map((r) => {
    const open = `        <EntitySet Name="${xml(r.name)}" EntityType="org.reso.metadata.${xml(r.name)}"`;
    return r.expand ? `${open}>\n          <NavigationPropertyBinding Path="${xml(r.expand.name)}" Target="${xml(r.expand.resource)}"/>\n        </EntitySet>` : `${open}/>`;
  }).join("\n");
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
