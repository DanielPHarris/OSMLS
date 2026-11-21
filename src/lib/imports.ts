import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import { listingImport, listingImportRow, member, office, property, type ListingImport, type ListingImportRow, type Member } from "../db/schema";
import { can } from "./access";
import type { ListingInput } from "./listing-input";
import { ListingError, createListingIn, mlsDate, propertyTurnKeys, takePropertyTurns, validatedNewListing } from "./listings";
import { currentSettings, normalizeParcel, sameProperty, withOneSettingsVersion } from "./market-time";
import { actingStaff, takeAuthorityTurn } from "./members";
import { IMPORT_COLUMNS, IMPORT_PREVIEW_HOURS, LISTING_COLUMNS, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, REQUIRED_IMPORT_COLUMNS } from "./rules/imports";
import type { MarketTimeSettings } from "./rules/market-time";
import { isTerminal } from "./rules/status";
import type { StandardStatus } from "./lookups";

/*
 * Importing new listings from a file. Staff who hold "Import listings" upload
 * a CSV file; nothing is created until they have seen what it would create and
 * confirmed.
 *
 * An imported listing is made by the one creation step every listing is made
 * by (createListingIn in src/lib/listings.ts), after the one validation
 * (validatedNewListing). So it starts as Coming Soon or Active, dated when the
 * import is committed. This is not a way to migrate an MLS's history: ended
 * listings, past changes, and earlier dates cannot come in.
 *
 * A row is judged the same way at preview and at commit, by `assess`. A commit
 * creates exactly the rows the preview accepted, in one transaction, or
 * nothing.
 */

const notFound = () => new ListingError("Not found.");
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

/** A source system's name as it is compared: trimmed, single-spaced, and without regard to case. */
export const normalizeSource = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

// ---- Reading the file ----

/** Splits CSV text into rows of cells: quoted cells, doubled quotes, and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new ListingError("The file is not valid CSV: a quoted value is never closed.");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // A line with nothing on it is not a row.
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

type FileRow = { rowNumber: number; content: Record<string, string>; malformed?: string };

/**
 * The rows of a file, each as its cells by column name. The header is checked
 * as a whole: a column that is not one an import takes, a column given twice,
 * or a required column missing refuses the file, so nothing in it is silently
 * ignored.
 */
export function readImportFile(text: string): FileRow[] {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) throw new ListingError(`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
  if (text.includes("\u0000")) throw new ListingError("The file is not a CSV text file.");
  const [header, ...lines] = parseCsv(text);
  if (!header) throw new ListingError("The file is empty.");
  const columns = header.map((c) => c.trim());
  const unknown = columns.filter((c) => !(IMPORT_COLUMNS as readonly string[]).includes(c));
  if (unknown.length > 0) throw new ListingError(`The file has ${unknown.length === 1 ? "a column" : "columns"} an import does not take: ${unknown.map((c) => `"${c}"`).join(", ")}. Remove ${unknown.length === 1 ? "it" : "them"} and upload again.`);
  const repeated = columns.filter((c, i) => columns.indexOf(c) !== i);
  if (repeated.length > 0) throw new ListingError(`The file has a column more than once: ${[...new Set(repeated)].join(", ")}.`);
  const missing = REQUIRED_IMPORT_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) throw new ListingError(`The file is missing ${missing.length === 1 ? "a required column" : "required columns"}: ${missing.join(", ")}.`);
  if (lines.length === 0) throw new ListingError("The file has a header and no rows.");
  if (lines.length > MAX_IMPORT_ROWS) throw new ListingError(`The file has ${lines.length} rows. An import takes at most ${MAX_IMPORT_ROWS}.`);
  return lines.map((cells, i) => ({
    rowNumber: i + 1,
    content: Object.fromEntries(columns.map((c, n) => [c, cells[n] ?? ""])),
    malformed: cells.length === columns.length ? undefined : `The row has ${cells.length} values and the header has ${columns.length} columns.`,
  }));
}

// ---- Judging rows ----

export type RowOutcome = "Accepted" | "Refused" | "Duplicate";
type Assessed = {
  rowNumber: number;
  sourceListingId: string;
  content: Record<string, string>;
  outcome: RowOutcome;
  reasons: string[];
  /** The row could not be read as the header describes, so nothing else about it is judged. */
  malformed: boolean;
  /** Set for a row that passed every check of the row itself. */
  input?: ListingInput;
  agent?: Member;
};

const identityOf = (v: Pick<ListingInput, "ParcelNumber" | "CountyOrParish" | "StateOrProvince" | "StreetNumber" | "StreetName" | "UnitNumber" | "City" | "PostalCode">) => ({
  parcelNumber: v.ParcelNumber,
  countyOrParish: v.CountyOrParish,
  stateOrProvince: v.StateOrProvince,
  streetNumber: v.StreetNumber,
  streetName: v.StreetName,
  unitNumber: v.UnitNumber,
  city: v.City,
  postalCode: v.PostalCode,
});

/**
 * Judges every row of a file. This is the only judgement there is: a preview
 * shows it, and a commit makes it again inside its transaction and goes ahead
 * only if every row it was going to create is still accepted.
 *
 * Refused: the row itself is not acceptable (its fields, its agent, or its
 * source identifier). Duplicate: the row is acceptable but the property
 * already has a listing that has not ended, or another row of the file is for
 * the same property; it is left out, not created.
 */
async function assess(read: Tx | typeof db, source: string, rows: readonly FileRow[], settings: MarketTimeSettings): Promise<Assessed[]> {
  const out: Assessed[] = rows.map((row) => ({ rowNumber: row.rowNumber, sourceListingId: (row.content.SourceListingId ?? "").trim(), content: row.content, outcome: "Refused", reasons: row.malformed ? [row.malformed] : [], malformed: !!row.malformed }));

  // The row's own fields, by the entry form's validation and the rule on how a listing may start.
  for (const row of out) {
    if (row.malformed) continue;
    if (!row.sourceListingId) row.reasons.push("SourceListingId: The listing's identifier in the source system is required.");
    else if (row.sourceListingId.length > 100) row.reasons.push("SourceListingId: Use 100 characters or fewer.");
    try {
      row.input = validatedNewListing(Object.fromEntries(LISTING_COLUMNS.map((c) => [c, row.content[c] ?? ""])));
    } catch (err) {
      if (!(err instanceof ListingError)) throw err;
      const fields = Object.entries(err.fieldErrors);
      row.reasons.push(...(fields.length > 0 ? fields.map(([field, message]) => `${field}: ${message}`) : [err.message]));
    }
  }

  // The listing agent each row names: an active agent in an active office.
  const ids = [...new Set(out.map((r) => (r.content.ListAgentMlsId ?? "").trim()).filter(Boolean))];
  const agents = ids.length === 0 ? [] : await read.select({ agent: member, officeStatus: office.OfficeStatus }).from(member).leftJoin(office, eq(office.OfficeKey, member.OfficeKey)).where(inArray(member.MemberMlsId, ids));
  for (const row of out) {
    if (row.malformed) continue;
    const id = (row.content.ListAgentMlsId ?? "").trim();
    const found = agents.find((a) => a.agent.MemberMlsId === id);
    if (!id) row.reasons.push("ListAgentMlsId: The listing agent's member ID is required.");
    else if (!found || found.agent.OsmlsRole !== "agent") row.reasons.push(`ListAgentMlsId: No agent has the member ID "${id}".`);
    else if (found.agent.MemberStatus !== "Active") row.reasons.push(`ListAgentMlsId: ${found.agent.MemberFullName} is suspended.`);
    else if (!found.agent.OfficeKey || found.officeStatus !== "Active") row.reasons.push(`ListAgentMlsId: ${found.agent.MemberFullName}'s office is inactive.`);
    else row.agent = found.agent;
  }

  // The same source identifier more than once in the file: none of those rows can be told apart.
  const bySourceId = new Map<string, number[]>();
  for (const row of out) if (row.sourceListingId) bySourceId.set(row.sourceListingId, [...(bySourceId.get(row.sourceListingId) ?? []), row.rowNumber]);
  for (const row of out) {
    const sharing = bySourceId.get(row.sourceListingId) ?? [];
    if (sharing.length > 1) row.reasons.push(`SourceListingId: "${row.sourceListingId}" is in the file more than once (rows ${sharing.join(", ")}).`);
  }

  // A source identifier already imported from this source.
  const sourceIds = [...bySourceId.keys()];
  const imported = sourceIds.length === 0 ? [] : await read
    .select({ sourceListingId: listingImportRow.SourceListingId, listingId: property.ListingId })
    .from(listingImportRow)
    .innerJoin(property, eq(property.ListingKey, listingImportRow.ListingKey))
    .where(and(eq(listingImportRow.Source, source), inArray(listingImportRow.SourceListingId, sourceIds), isNotNull(listingImportRow.ListingKey)));
  for (const row of out) {
    const earlier = imported.find((i) => i.sourceListingId === row.sourceListingId);
    if (earlier) row.reasons.push(`SourceListingId: "${row.sourceListingId}" was already imported from this source, as listing ${earlier.listingId}.`);
  }

  const sound = out.filter((r) => r.reasons.length === 0 && r.input && r.agent);
  for (const row of sound) row.outcome = "Accepted";

  // Two rows of the file for the same property: neither is created.
  for (const row of sound) {
    const others = sound.filter((o) => o !== row && sameProperty(identityOf(row.input!), identityOf(o.input!), settings));
    if (others.length > 0) {
      row.outcome = "Duplicate";
      row.reasons.push(`The same property as row ${others.map((o) => o.rowNumber).join(", ")} of this file.`);
    }
  }

  // A property that already has a listing that has not ended.
  if (sound.length > 0) {
    const parcels = [...new Set(sound.map((r) => normalizeParcel(r.input!.ParcelNumber)).filter((p): p is string => !!p))];
    const zips = [...new Set(sound.map((r) => r.input!.PostalCode.trim().toLowerCase()))];
    const numbers = [...new Set(sound.map((r) => r.input!.StreetNumber.trim().toLowerCase()))];
    const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
    const existing = await read
      .select()
      .from(property)
      .where(
        sql`(${parcels.length > 0 ? sql`upper(regexp_replace(coalesce(${property.ParcelNumber}, ''), '[^A-Za-z0-9]', '', 'g')) in (${list(parcels)})` : sql`false`}
          or (lower(trim(${property.PostalCode})) in (${list(zips)}) and lower(trim(${property.StreetNumber})) in (${list(numbers)})))`,
      );
    const open = existing.filter((l) => !isTerminal(l.StandardStatus as StandardStatus));
    for (const row of sound) {
      const match = open.find((l) => sameProperty(identityOf(row.input!), identityOf(l), settings));
      if (match) {
        row.outcome = "Duplicate";
        row.reasons.push(`The same property as listing ${match.ListingId}, which is ${match.StandardStatus}.`);
      }
    }
  }
  return out;
}

// ---- Preview ----

/**
 * Reads a file and stores what it would do, creating no listing. Returns the
 * key of the preview, which shows each row's outcome and can then be
 * committed.
 */
export async function previewImport(actor: Member | null, upload: { fileName?: unknown; text?: unknown; sourceName?: unknown }): Promise<ListingImport> {
  if (!can(actor, "imports")) throw notFound();
  const sourceName = typeof upload.sourceName === "string" ? upload.sourceName.trim().replace(/\s+/g, " ") : "";
  if (!sourceName) throw new ListingError("Name the system the file came from.", { sourceName: "A source is required." });
  if (sourceName.length > 80) throw new ListingError("Keep the source's name to 80 characters.", { sourceName: "Use 80 characters or fewer." });
  if (typeof upload.text !== "string" || upload.text.trim() === "") throw new ListingError("Choose a CSV file.", { file: "A file is required." });
  const fileName = (typeof upload.fileName === "string" && upload.fileName.trim() ? upload.fileName.trim() : "import.csv").slice(0, 200);
  const rows = readImportFile(upload.text);
  const source = normalizeSource(sourceName);
  const assessed = await assess(db, source, rows, await currentSettings());
  return db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor, "imports");
    const [made] = await tx
      .insert(listingImport)
      .values({ SourceName: sourceName, Source: source, FileName: fileName, FileHash: createHash("sha256").update(upload.text as string).digest("hex"), CreatedByMemberKey: by.MemberKey })
      .returning();
    await tx.insert(listingImportRow).values(
      assessed.map((row) => ({ ImportKey: made.ImportKey, RowNumber: row.rowNumber, Source: source, SourceListingId: row.sourceListingId, Outcome: row.outcome, Reasons: row.reasons, Content: row.content })),
    );
    return made;
  });
}

const stillOpen = sql`(${listingImport.State} = 'Committed' or ${listingImport.OriginalEntryTimestamp} > now() - make_interval(hours => ${IMPORT_PREVIEW_HOURS}))`;

export type ImportView = {
  import: ListingImport & { createdBy: string };
  rows: (Pick<ListingImportRow, "RowNumber" | "SourceListingId" | "Outcome" | "Reasons"> & {
    /** What the row is for, while the import is a preview. */
    address: string | null;
    listAgentMlsId: string | null;
    listingId: string | null;
    listingKey: string | null;
  })[];
  accepted: number;
  refused: number;
  duplicates: number;
};

/** An import and each row's outcome. Null for anyone who may not import, and for a preview that has expired. */
export async function getImport(actor: Member | null, key: unknown): Promise<ImportView | null> {
  if (!can(actor, "imports") || !isKey(key)) return null;
  const [found] = await db
    .select({ import: listingImport, createdBy: member.MemberFullName })
    .from(listingImport)
    .innerJoin(member, eq(member.MemberKey, listingImport.CreatedByMemberKey))
    .where(and(eq(listingImport.ImportKey, key), stillOpen));
  if (!found) return null;
  const rows = await db
    .select({ row: listingImportRow, listingId: property.ListingId })
    .from(listingImportRow)
    .leftJoin(property, eq(property.ListingKey, listingImportRow.ListingKey))
    .where(eq(listingImportRow.ImportKey, key))
    .orderBy(asc(listingImportRow.RowNumber));
  const count = (outcome: RowOutcome) => rows.filter((r) => r.row.Outcome === outcome).length;
  return {
    import: { ...found.import, createdBy: found.createdBy },
    rows: rows.map(({ row, listingId }) => ({
      RowNumber: row.RowNumber,
      SourceListingId: row.SourceListingId,
      Outcome: row.Outcome,
      Reasons: row.Reasons,
      address: row.Content ? [row.Content.StreetNumber, row.Content.StreetName, row.Content.City].filter(Boolean).join(" ") || null : null,
      listAgentMlsId: row.Content?.ListAgentMlsId ?? null,
      listingId,
      listingKey: row.ListingKey,
    })),
    accepted: count("Accepted"),
    refused: count("Refused"),
    duplicates: count("Duplicate"),
  };
}

/** Every import that has not expired, newest first. Null for anyone who may not import. */
export async function listImports(actor: Member | null) {
  if (!can(actor, "imports")) return null;
  return db
    .select({
      importKey: listingImport.ImportKey,
      sourceName: listingImport.SourceName,
      fileName: listingImport.FileName,
      state: listingImport.State,
      createdAt: listingImport.OriginalEntryTimestamp,
      createdBy: member.MemberFullName,
      committedAt: listingImport.CommittedTimestamp,
      created: sql<number>`(select count(*)::int from "OsmlsImportRow" r where r."ImportKey" = "OsmlsImport"."ImportKey" and r."ListingKey" is not null)`,
      accepted: sql<number>`(select count(*)::int from "OsmlsImportRow" r where r."ImportKey" = "OsmlsImport"."ImportKey" and r."Outcome" = 'Accepted')`,
      rows: sql<number>`(select count(*)::int from "OsmlsImportRow" r where r."ImportKey" = "OsmlsImport"."ImportKey")`,
    })
    .from(listingImport)
    .innerJoin(member, eq(member.MemberKey, listingImport.CreatedByMemberKey))
    .where(stillOpen)
    .orderBy(desc(listingImport.OriginalEntryTimestamp));
}

// ---- Commit ----

/** Thrown inside a commit when a row it was going to create is no longer acceptable. Nothing has been created. */
class NoLongerAccepted extends Error {}

const stored = (rows: ListingImportRow[]): FileRow[] => rows.filter((r) => r.Content).map((r) => ({ rowNumber: r.RowNumber, content: r.Content! }));

/**
 * Creates the listings a preview accepted: exactly those, all of them, or
 * none.
 *
 * Everything is decided inside one transaction. It takes the authority turn
 * (so no member is suspended and no capability revoked while it runs) and
 * reads the acting member again; it locks the import (so it is committed
 * once); it lets one import commit at a time; it takes the turn of every
 * property it is about to create a listing for (so a listing entered by hand
 * for one of them is either already there to be seen, or waits); and then it
 * judges the file again. If any row the preview accepted is no longer
 * accepted, it creates nothing, and the preview is brought up to date. A row
 * the preview did not accept is never created, even if it would pass now.
 */
export async function commitImport(actor: Member | null, key: unknown): Promise<{ created: number; stale: boolean }> {
  if (!can(actor, "imports") || !isKey(key)) throw notFound();
  return withOneSettingsVersion(async () => {
    const settings = await currentSettings();
    const now = new Date();
    const today = await mlsDate(now);
    try {
      return await db.transaction(async (tx) => {
        await takeAuthorityTurn(tx);
        const by = await actingStaff(tx, actor, "imports");
        const [found] = await tx.select().from(listingImport).where(and(eq(listingImport.ImportKey, key), stillOpen)).for("update");
        if (!found) throw notFound();
        if (found.State !== "Previewed") throw new ListingError("This import has already been committed. Nothing more was created.");
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('osmls:import:commit'))`);
        const rows = await tx.select().from(listingImportRow).where(eq(listingImportRow.ImportKey, key)).orderBy(asc(listingImportRow.RowNumber));
        const wanted = rows.filter((r) => r.Outcome === "Accepted");
        if (wanted.length === 0) throw new ListingError("No row of this file was accepted, so there is nothing to create.");

        // The turn of every property about to be given a listing, before anything is looked at.
        const turns: string[] = [];
        for (const row of wanted) {
          try {
            turns.push(...propertyTurnKeys(validatedNewListing(Object.fromEntries(LISTING_COLUMNS.map((c) => [c, row.Content?.[c] ?? ""])))));
          } catch (err) {
            if (err instanceof ListingError) throw new NoLongerAccepted();
            throw err;
          }
        }
        await takePropertyTurns(tx, turns);

        const judged = await assess(tx, found.Source, stored(rows), settings);
        const creating = wanted.map((row) => judged.find((j) => j.rowNumber === row.RowNumber));
        if (creating.some((j) => !j || j.outcome !== "Accepted")) throw new NoLongerAccepted();

        for (const row of creating) {
          const created = await createListingIn(tx, {
            input: row!.input!,
            listingAgent: row!.agent!,
            actor: by,
            now,
            today,
            origin: { note: `Imported from ${found.SourceName} (file ${found.FileName}, row ${row!.rowNumber}), on behalf of the listing agent.` },
          });
          await tx.update(listingImportRow).set({ ListingKey: created.ListingKey }).where(and(eq(listingImportRow.ImportKey, key), eq(listingImportRow.RowNumber, row!.rowNumber)));
        }
        // The record of the import stays; what its rows held does not.
        await tx.update(listingImportRow).set({ Content: null }).where(eq(listingImportRow.ImportKey, key));
        await tx.update(listingImport).set({ State: "Committed", CommittedByMemberKey: by.MemberKey, CommittedTimestamp: now }).where(eq(listingImport.ImportKey, key));
        return { created: creating.length, stale: false };
      });
    } catch (err) {
      if (!(err instanceof NoLongerAccepted)) throw err;
      // Nothing was created. The preview is judged again, so that what is shown is what is now true.
      await db.transaction(async (tx) => {
        const [found] = await tx.select().from(listingImport).where(eq(listingImport.ImportKey, key)).for("update");
        if (!found || found.State !== "Previewed") return;
        const rows = await tx.select().from(listingImportRow).where(eq(listingImportRow.ImportKey, key));
        for (const row of await assess(tx, found.Source, stored(rows), settings)) {
          await tx.update(listingImportRow).set({ Outcome: row.outcome, Reasons: row.reasons }).where(and(eq(listingImportRow.ImportKey, key), eq(listingImportRow.RowNumber, row.rowNumber)));
        }
      });
      return { created: 0, stale: true };
    }
  });
}

/** Deletes previews that were never committed and are past keeping, with what their rows held. */
export async function cleanUpImports(): Promise<{ previewsDeleted: number }> {
  const deleted = await db
    .delete(listingImport)
    .where(sql`${listingImport.State} = 'Previewed' and ${listingImport.OriginalEntryTimestamp} <= now() - make_interval(hours => ${IMPORT_PREVIEW_HOURS})`)
    .returning({ key: listingImport.ImportKey });
  return { previewsDeleted: deleted.length };
}
