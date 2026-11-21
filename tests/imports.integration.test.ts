/*
 * Importing new listings from a file, against the test database (issue #35).
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { historyTransactional, listingImport, listingImportRow, member, property, savedSearch, type Member } from "../src/db/schema";
import { getActivity } from "../src/lib/activity";
import { cleanUpImports, commitImport, getImport, listImports, parseCsv, previewImport } from "../src/lib/imports";
import { listingInputSchema } from "../src/lib/listing-input";
import { ListingError, createListing, propertyTurnKeys, searchListings, updateListing, validatedNewListing } from "../src/lib/listings";
import { createMember, setCapabilities, setMemberStatus } from "../src/lib/members";
import { createOffice, setOfficeStatus } from "../src/lib/offices";
import { IMPORT_COLUMNS, IMPORT_PREVIEW_HOURS, LISTING_COLUMNS, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "../src/lib/rules/imports";
import { createSavedSearch } from "../src/lib/saved-work";
import { DEFAULT_CRITERIA, criteriaToFilters } from "../src/lib/search-criteria";
import { AUTHORITY_TURN, overlapping } from "./overlap";

const run = Date.now();
const CITY = `Imported${run}`;
let admin: Member;
let agent: Member;
let office: string;
let serial = 0;
const smtp = process.env.SMTP_URL;

const HEADER = ["SourceListingId", "ListAgentMlsId", "StandardStatus", "PropertyType", "ListPrice", "ListingContractDate", "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode", "BedroomsTotal", "BathroomsTotalInteger", "ParcelNumber", "CountyOrParish", "PublicRemarks"];
type Row = Partial<Record<(typeof HEADER)[number], string>>;
/** A row for a property of its own, unless told otherwise. */
const row = (changes: Row = {}): Row => {
  const n = ++serial;
  return {
    SourceListingId: `SRC-${run}-${n}`, ListAgentMlsId: agent.MemberMlsId, StandardStatus: "Active", PropertyType: "Residential", ListPrice: "450000", ListingContractDate: "2026-01-01",
    StreetNumber: String(n), StreetName: `Import Rd ${run}`, City: CITY, StateOrProvince: "WA", PostalCode: "98984", BedroomsTotal: "3", BathroomsTotalInteger: "2",
    ParcelNumber: `I${run}-${n}`, CountyOrParish: "Test County", PublicRemarks: "Imported, with a comma",
    ...changes,
  };
};
const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (rows: Row[]) => [HEADER.join(","), ...rows.map((r) => HEADER.map((h) => cell(r[h] ?? "")).join(","))].join("\r\n");
const upload = (rows: Row[], sourceName = `Source ${run}`, by: Member | null = admin) => previewImport(by, { fileName: "listings.csv", sourceName, text: csv(rows) });
const outcomes = async (key: string) => (await getImport(admin, key))!.rows.map((r) => [r.RowNumber, r.Outcome] as const);
const listingsIn = async (street: string) => db.select().from(property).where(eq(property.StreetName, street));
const newAgent = async () =>
  (await createMember(admin, { firstName: "Import", lastName: `Agent${++serial}`, email: `import-${run}-${serial}@osmls.example`, memberId: `IM${run}-${serial}`, role: "agent", officeKey: office, phone: "" })).member;

beforeAll(async () => {
  delete process.env.SMTP_URL;
  const members = await db.select().from(member);
  admin = members.find((m) => m.MemberMlsId === "ST0001")!;
  agent = members.find((m) => m.MemberMlsId === "AG1001")!;
  office = agent.OfficeKey!;
});
afterAll(async () => {
  process.env.SMTP_URL = smtp;
  await db.update(member).set({ MemberStatus: "Inactive", OsmlsCapabilities: [] }).where(like(member.MemberMlsId, `IM${run}-%`));
  await pool.end();
});

describe("the file", () => {
  it("has the entry form's fields as its listing columns, and no others", () => {
    expect([...LISTING_COLUMNS].sort()).toEqual(Object.keys(listingInputSchema.shape).sort());
    expect(IMPORT_COLUMNS.filter((c) => !(LISTING_COLUMNS as readonly string[]).includes(c))).toEqual(["ListAgentMlsId", "SourceListingId"]);
  });

  it("is read as CSV, with quoted values, doubled quotes, and line breaks inside quotes", () => {
    expect(parseCsv('﻿a,b\r\n"1,5","say ""hi"""\n"two\nlines",\r\n\r\n')).toEqual([["a", "b"], ["1,5", 'say "hi"'], ["two\nlines", ""]]);
    expect(() => parseCsv('a\n"never closed')).toThrow(/never closed/);
  });
});

describe("the first proof of importing", () => {
  it("shows what each row would do and creates nothing until it is committed", async () => {
    const first = row();
    const preview = await upload([first, row({ ListPrice: "-5", StandardStatus: "Closed" }), row({ SourceListingId: first.SourceListingId })]);
    const view = (await getImport(admin, preview.ImportKey))!;
    expect(view.import.State).toBe("Previewed");
    // The same source identifier twice refuses both rows: they cannot be told apart.
    expect(view.rows.map((r) => r.Outcome)).toEqual(["Refused", "Refused", "Refused"]);
    expect(view.rows[0].Reasons[0]).toMatch(/is in the file more than once \(rows 1, 3\)/);
    expect(view.rows[1].Reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^StandardStatus: A new listing must start as Coming Soon or Active\./)]));
    expect(view).toMatchObject({ accepted: 0, refused: 3, duplicates: 0 });
    expect(await listingsIn(`Import Rd ${run}`)).toEqual([]);
    await expect(commitImport(admin, preview.ImportKey)).rejects.toThrow("No row of this file was accepted, so there is nothing to create.");
    expect(await listingsIn(`Import Rd ${run}`)).toEqual([]);
  });

  it("creates the accepted row as an ordinary new listing, under its agent, recorded as made by the staff member", async () => {
    const one = row();
    const preview = await upload([one, row({ BedroomsTotal: "many" })]);
    expect(await outcomes(preview.ImportKey)).toEqual([[1, "Accepted"], [2, "Refused"]]);
    expect(await listingsIn(`Import Rd ${run}`)).toEqual([]);

    // A file with a refused row can still be committed: exactly the accepted row is created.
    expect(await commitImport(admin, preview.ImportKey)).toEqual({ created: 1, stale: false });
    const [created] = await listingsIn(`Import Rd ${run}`);
    expect(await listingsIn(`Import Rd ${run}`)).toHaveLength(1);
    expect(created).toMatchObject({ ListAgentKey: agent.MemberKey, ListOfficeKey: agent.OfficeKey, StandardStatus: "Active", ListPrice: 450000, OriginalListPrice: 450000, ParcelNumber: one.ParcelNumber });
    expect(created.ListingId).toMatch(/^OS\d+$/);
    expect(Date.now() - created.OriginalEntryTimestamp.getTime()).toBeLessThan(60_000);

    const history = await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, created.ListingKey));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      FieldName: "StandardStatus", NewValue: "Active", ChangeType: "New Listing", ChangedByMemberKey: admin.MemberKey, ChangedByMemberID: admin.MemberMlsId, OsmlsStaffCorrection: false,
      OsmlsCorrectionReason: `Imported from Source ${run} (file listings.csv, row 1), on behalf of the listing agent.`,
    });

    // The record of the import is kept; what its rows held is not.
    const view = (await getImport(admin, preview.ImportKey))!;
    expect(view.import).toMatchObject({ State: "Committed", CommittedByMemberKey: admin.MemberKey });
    expect(view.rows.map((r) => [r.RowNumber, r.Outcome, r.listingId])).toEqual([[1, "Accepted", created.ListingId], [2, "Refused", null]]);
    const kept = await db.select().from(listingImportRow).where(eq(listingImportRow.ImportKey, preview.ImportKey));
    expect(kept.map((r) => r.Content)).toEqual([null, null]);

    // The agent finds it like any listing.
    const found = await searchListings(criteriaToFilters({ ...DEFAULT_CRITERIA, city: CITY, statuses: [] }, agent));
    expect(found.rows.map((r) => r.listing.ListingKey)).toContain(created.ListingKey);

    // Committed once: a second commit creates nothing.
    await expect(commitImport(admin, preview.ImportKey)).rejects.toThrow("This import has already been committed. Nothing more was created.");
    expect(await listingsIn(`Import Rd ${run}`)).toHaveLength(1);

    // The same file again, with the source typed differently: already imported.
    const again = await upload([one], `  source   ${run} `.toUpperCase());
    const refused = (await getImport(admin, again.ImportKey))!.rows[0];
    expect(refused.Outcome).toBe("Refused");
    expect(refused.Reasons[0]).toBe(`SourceListingId: "${one.SourceListingId}" was already imported from this source, as listing ${created.ListingId}.`);
    // From another source, the same identifier is another listing's; here it is the same property, so it is left out.
    const elsewhere = await upload([one], `Other ${run}`);
    expect((await getImport(admin, elsewhere.ImportKey))!.rows[0]).toMatchObject({ Outcome: "Duplicate", Reasons: [`The same property as listing ${created.ListingId}, which is Active.`] });
  });

  it("creates nothing when a row that was going to be created no longer passes at commit", async () => {
    const second = await newAgent();
    const street = `Stale Rd ${run}`;
    const preview = await upload([row({ StreetName: street }), row({ StreetName: street, ListAgentMlsId: second.MemberMlsId })]);
    expect(await outcomes(preview.ImportKey)).toEqual([[1, "Accepted"], [2, "Accepted"]]);

    await setMemberStatus(admin, second.MemberKey, "Inactive", "suspended after the preview");
    expect(await commitImport(admin, preview.ImportKey)).toEqual({ created: 0, stale: true });
    // Neither listing exists: not the one whose agent was suspended, and not the one that was fine.
    expect(await listingsIn(street)).toEqual([]);
    expect(await db.select().from(historyTransactional).where(and(eq(historyTransactional.ChangedByMemberKey, admin.MemberKey), like(historyTransactional.OsmlsCorrectionReason, `%row 1), on behalf%`), eq(historyTransactional.ResourceRecordID, "none")))).toEqual([]);
    // The preview is still a preview, and now says what is true.
    const view = (await getImport(admin, preview.ImportKey))!;
    expect(view.import.State).toBe("Previewed");
    expect(view.rows.map((r) => r.Outcome)).toEqual(["Accepted", "Refused"]);
    expect(view.rows[1].Reasons[0]).toMatch(/is suspended\.$/);

    // Committing now creates exactly what the preview now shows.
    expect(await commitImport(admin, preview.ImportKey)).toEqual({ created: 1, stale: false });
    expect((await listingsIn(street)).map((l) => l.ListAgentKey)).toEqual([agent.MemberKey]);
  });

  it("is for staff who hold Import listings, and for no one else", async () => {
    const without = (await createMember(admin, { firstName: "No", lastName: "Imports", email: `noimport-${run}@osmls.example`, memberId: `IM${run}-x`, role: "staff", officeKey: "", phone: "" })).member;
    await setCapabilities(admin, without.MemberKey, ["members", "offices", "settings", "compliance", "data", "staff"], "everything but imports");
    const [staffWithout] = await db.select().from(member).where(eq(member.MemberKey, without.MemberKey));
    const preview = await upload([row({ StreetName: `Refused Rd ${run}` })]);
    for (const viewer of [staffWithout, agent, null]) {
      await expect(upload([row()], `Source ${run}`, viewer)).rejects.toThrow("Not found.");
      await expect(commitImport(viewer, preview.ImportKey)).rejects.toThrow("Not found.");
      expect(await getImport(viewer, preview.ImportKey)).toBeNull();
      expect(await listImports(viewer)).toBeNull();
    }
    expect(await listingsIn(`Refused Rd ${run}`)).toEqual([]);
    expect((await db.select().from(listingImport).where(eq(listingImport.ImportKey, preview.ImportKey)))[0].State).toBe("Previewed");
  });
});

describe("a row is checked exactly as a listing entered by hand", () => {
  it("gives the same message for the same mistake, by either route", async () => {
    const header = [...IMPORT_COLUMNS];
    const good = { ...row(), UnitNumber: "", LivingArea: "1500", LotSizeAcres: "0.25", YearBuilt: "1990" } as Record<string, string>;
    const mistakes: Record<string, string>[] = [
      { ListPrice: "-5" }, { ListPrice: "" }, { BedroomsTotal: "many" }, { BathroomsTotalInteger: "-1" }, { PostalCode: "abc" }, { StateOrProvince: "Washington" },
      { ListingContractDate: "2026-02-31" }, { StreetName: "" }, { City: "" }, { PropertyType: "Castle" }, { StandardStatus: "Sold" }, { StandardStatus: "Pending" },
      { YearBuilt: "1200" }, { Latitude: "47.6" }, { Latitude: "95", Longitude: "-122" }, { ClosePrice: "400000" }, { LivingArea: "big" }, { LockBoxType: "Vault" },
      { ListPrice: "-5", PostalCode: "abc", StandardStatus: "Closed" },
    ];
    const text = [header.join(","), ...mistakes.map((m) => header.map((h) => cell(({ ...good, SourceListingId: `PAR-${run}-${++serial}`, ...m } as Record<string, string>)[h] ?? "")).join(","))].join("\n");
    const preview = await previewImport(admin, { fileName: "parity.csv", sourceName: `Parity ${run}`, text });
    const view = (await getImport(admin, preview.ImportKey))!;
    for (const [i, mistake] of mistakes.entries()) {
      // The same fields, typed into the entry form by the agent.
      const byHand = await createListing(agent, { ...good, ...mistake }).then(() => null, (err: ListingError) => err.fieldErrors);
      expect(byHand, JSON.stringify(mistake)).not.toBeNull();
      expect(view.rows[i].Outcome, JSON.stringify(mistake)).toBe("Refused");
      expect([...view.rows[i].Reasons].sort(), JSON.stringify(mistake)).toEqual(Object.entries(byHand!).map(([field, message]) => `${field}: ${message}`).sort());
    }
    // And what the form accepts, an import accepts: a Coming Soon listing, not yet on the market.
    const soon = row({ StandardStatus: "Coming Soon", StreetName: `Parity Rd ${run}` });
    const accepted = await upload([soon]);
    expect(await commitImport(admin, accepted.ImportKey)).toEqual({ created: 1, stale: false });
    expect((await listingsIn(`Parity Rd ${run}`))[0]).toMatchObject({ StandardStatus: "Coming Soon", OnMarketDate: null });
  });

  it("refuses a row whose agent is unknown, is MLS staff, is suspended, or is in an inactive office, and a row that is not whole", async () => {
    const suspended = await newAgent();
    await setMemberStatus(admin, suspended.MemberKey, "Inactive", "test");
    const closedOffice = await createOffice(admin, { name: `Import Office ${run}`, officeId: `IO${run}`, phone: "", mainOfficeKey: "" });
    const stranded = (await createMember(admin, { firstName: "Stranded", lastName: `Agent${run}`, email: `stranded-${run}@osmls.example`, memberId: `IM${run}-s`, role: "agent", officeKey: closedOffice.OfficeKey, phone: "" })).member;
    await setMemberStatus(admin, stranded.MemberKey, "Inactive", "test");
    await setOfficeStatus(admin, closedOffice.OfficeKey, "Inactive", "test");
    await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, stranded.MemberKey));
    const text = `${csv([row({ ListAgentMlsId: "NOBODY" }), row({ ListAgentMlsId: "ST0001" }), row({ ListAgentMlsId: suspended.MemberMlsId }), row({ ListAgentMlsId: stranded.MemberMlsId }), row({ ListAgentMlsId: "" }), row({ SourceListingId: "" })])}\r\nonly,three,cells`;
    const view = (await getImport(admin, (await previewImport(admin, { fileName: "agents.csv", sourceName: `Source ${run}`, text })).ImportKey))!;
    expect(view.rows.map((r) => r.Outcome)).toEqual(Array(7).fill("Refused"));
    expect(view.rows.map((r) => r.Reasons[0])).toEqual([
      'ListAgentMlsId: No agent has the member ID "NOBODY".',
      'ListAgentMlsId: No agent has the member ID "ST0001".',
      expect.stringMatching(/^ListAgentMlsId: Import Agent\d+ is suspended\.$/),
      expect.stringMatching(/^ListAgentMlsId: Stranded Agent\d+'s office is inactive\.$/),
      "ListAgentMlsId: The listing agent's member ID is required.",
      "SourceListingId: The listing's identifier in the source system is required.",
      `The row has 3 values and the header has ${HEADER.length} columns.`,
    ]);
  });
});

describe("a file that cannot be read as an import is refused whole", () => {
  it("names what is wrong and stores nothing", async () => {
    const before = (await db.select().from(listingImport)).length;
    const good = csv([row()]);
    const withHeader = (header: string) => [header, good.split("\r\n")[1]].join("\r\n");
    const cases: [string, RegExp][] = [
      [withHeader(`${HEADER.join(",")},OriginalListPrice`), /a column an import does not take: "OriginalListPrice"/],
      [withHeader(`${HEADER.join(",")},ListingKey,Photos`), /columns an import does not take: "ListingKey", "Photos"/],
      [withHeader(HEADER.join(",").replace("PublicRemarks", "City")), /a column more than once: City/],
      [withHeader(HEADER.filter((h) => h !== "ListAgentMlsId" && h !== "ListPrice").join(",")), /missing required columns: ListPrice, ListAgentMlsId/],
      ["", /Choose a CSV file/],
      [HEADER.join(","), /a header and no rows/],
      [`${HEADER.join(",")}\n"never closed`, /a quoted value is never closed/],
      [`${good}\u0000`, /not a CSV text file/],
      [[HEADER.join(","), ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => good.split("\r\n")[1])].join("\n"), new RegExp(`has ${MAX_IMPORT_ROWS + 1} rows. An import takes at most ${MAX_IMPORT_ROWS}`)],
      [`${HEADER.join(",")}\n${"x".repeat(MAX_IMPORT_BYTES)}`, /larger than 2 MB/],
    ];
    for (const [text, message] of cases) await expect(previewImport(admin, { fileName: "bad.csv", sourceName: `Source ${run}`, text }), String(message)).rejects.toThrow(message);
    await expect(previewImport(admin, { fileName: "bad.csv", sourceName: "   ", text: good })).rejects.toThrow("Name the system the file came from.");
    await expect(previewImport(admin, { fileName: "bad.csv", sourceName: "x".repeat(81), text: good })).rejects.toThrow(/80 characters/);
    expect((await db.select().from(listingImport)).length).toBe(before);
  });
});

describe("duplicates", () => {
  it("leaves out two rows for one property, and a row for a property with a listing that has not ended", async () => {
    const street = `Duplicate Rd ${run}`;
    const twin = { StreetName: street, StreetNumber: "7", ParcelNumber: `D${run}-twin` };
    const existing = await createListing(agent, { ...row({ StreetName: street, StreetNumber: "9", ParcelNumber: `D${run}-open` }) });
    const ended = await createListing(agent, { ...row({ StreetName: street, StreetNumber: "11", ParcelNumber: `D${run}-ended` }) });
    await updateListing(agent, ended.ListingKey, { ...row({ StreetName: street, StreetNumber: "11", ParcelNumber: `D${run}-ended` }), StandardStatus: "Canceled" });
    const preview = await upload([
      row(twin),
      row({ ...twin, ListPrice: "999000" }),
      // The same parcel as an open listing, typed with other punctuation and another address.
      row({ StreetName: `Elsewhere Rd ${run}`, ParcelNumber: `d ${run} open`.toUpperCase().replace("D ", "D").replace(" OPEN", "-OPEN") }),
      // A property whose only listing has ended may be listed again.
      row({ StreetName: street, StreetNumber: "11", ParcelNumber: `D${run}-ended` }),
    ]);
    const view = (await getImport(admin, preview.ImportKey))!;
    expect(view.rows.map((r) => r.Outcome)).toEqual(["Duplicate", "Duplicate", "Duplicate", "Accepted"]);
    expect(view.rows[0].Reasons).toEqual(["The same property as row 2 of this file."]);
    expect(view.rows[1].Reasons).toEqual(["The same property as row 1 of this file."]);
    expect(view.rows[2].Reasons).toEqual([`The same property as listing ${existing.ListingId}, which is Active.`]);
    expect(view).toMatchObject({ accepted: 1, refused: 0, duplicates: 3 });
    expect(await commitImport(admin, preview.ImportKey)).toEqual({ created: 1, stale: false });
    // Only the accepted row was created: neither twin, and nothing over the open listing.
    expect((await listingsIn(street)).map((l) => l.StreetNumber).sort()).toEqual(["11", "11", "9"]);
    expect(await listingsIn(`Elsewhere Rd ${run}`)).toEqual([]);
  });

  it("cannot store the same source identifier twice for one source, whatever a check may have missed", async () => {
    const one = row({ StreetName: `Once Rd ${run}` });
    const preview = await upload([one], `Once ${run}`);
    await commitImport(admin, preview.ImportKey);
    const [created] = await listingsIn(`Once Rd ${run}`);
    const other = await upload([row({ StreetName: `Once Rd ${run}`, StreetNumber: "500" })], `Once ${run}`);
    await expect(
      db.update(listingImportRow).set({ SourceListingId: one.SourceListingId!, ListingKey: created.ListingKey }).where(eq(listingImportRow.ImportKey, other.ImportKey)),
    ).rejects.toThrow();
  });
});

describe("imports, commits and hand entry at the same moment", () => {
  it("creates a property's listing once when two imports of it are committed together", async () => {
    for (let round = 0; round < 4; round++) {
      const street = `Together Rd ${run}-${round}`;
      const same = { StreetName: street, StreetNumber: "1", ParcelNumber: `T${run}-${round}` };
      const a = await upload([row(same)], `Together A ${run}`);
      const b = await upload([row(same)], `Together B ${run}`);
      // Neither exists yet, so each preview accepts its row.
      expect([...(await outcomes(a.ImportKey)), ...(await outcomes(b.ImportKey))].map(([, o]) => o)).toEqual(["Accepted", "Accepted"]);
      const results = await Promise.all([commitImport(admin, a.ImportKey), commitImport(admin, b.ImportKey)]);
      expect(results.map((r) => r.created).sort()).toEqual([0, 1]);
      expect(results.find((r) => r.created === 0)).toEqual({ created: 0, stale: true });
      expect(await listingsIn(street)).toHaveLength(1);
    }
  });

  it("commits a preview once when commit is asked for twice at the same moment", async () => {
    for (let round = 0; round < 4; round++) {
      const street = `Twice Rd ${run}-${round}`;
      const preview = await upload([row({ StreetName: street }), row({ StreetName: street })]);
      const results = await Promise.allSettled([commitImport(admin, preview.ImportKey), commitImport(admin, preview.ImportKey)]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toBe("This import has already been committed. Nothing more was created.");
      expect(await listingsIn(street)).toHaveLength(2);
    }
  });

  it("takes a property's turn before creating its listing, by the form and by an import alike", async () => {
    const input = row({ StreetName: `Turn Rd ${run}` });
    const lock = `select pg_advisory_xact_lock(1330860364, hashtext(k)) from unnest(array[${propertyTurnKeys(validatedNewListing(input)).map((k) => `'${k.replace(/'/g, "''")}'`).join(", ")}]) as k`;
    // While another transaction holds the property's turn, a listing entered by hand waits for it.
    const byHand = await overlapping(lock, "select 1", () => createListing(agent, input));
    expect(byHand.status).toBe("fulfilled");
    // Hand entry is otherwise unchanged: an agent can still enter another listing for the same property.
    await createListing(agent, input);
    expect(await listingsIn(`Turn Rd ${run}`)).toHaveLength(2);
  });

  it("does not create a listing over one entered by hand while the commit was waiting for the property's turn", async () => {
    const street = `Race Rd ${run}`;
    const input = row({ StreetName: street });
    const preview = await upload([input, row({ StreetName: street })]);
    expect((await outcomes(preview.ImportKey)).map(([, o]) => o)).toEqual(["Accepted", "Accepted"]);
    // Another transaction holds the first row's property and, while the commit waits, a listing for it appears,
    // exactly as one entered by hand would: written by a transaction that held the turn.
    const columns = ((await db.execute(sql`select column_name from information_schema.columns where table_name = 'Property' and column_name not in ('ListingKey', 'ListingId', 'StreetName', 'StreetNumber', 'ParcelNumber')`)).rows as { column_name: string }[]).map((c) => `"${c.column_name}"`).join(", ");
    const [template] = await listingsIn(`Import Rd ${run}`);
    const lock = `select pg_advisory_xact_lock(1330860364, hashtext(k)) from unnest(array[${propertyTurnKeys(validatedNewListing(input)).map((k) => `'${k.replace(/'/g, "''")}'`).join(", ")}]) as k`;
    const arrives = `insert into "Property" (${columns}, "StreetName", "StreetNumber", "ParcelNumber") select ${columns}, '${street}', '${input.StreetNumber}', '${input.ParcelNumber}' from "Property" where "ListingKey" = '${template.ListingKey}'`;
    const result = await overlapping(lock, arrives, () => commitImport(admin, preview.ImportKey));
    expect(result).toMatchObject({ status: "fulfilled", value: { created: 0, stale: true } });
    // Only the listing that arrived exists: the import created neither of its rows.
    expect(await listingsIn(street)).toHaveLength(1);
    const view = (await getImport(admin, preview.ImportKey))!;
    expect(view.rows.map((r) => r.Outcome)).toEqual(["Duplicate", "Accepted"]);
    expect(view.rows[0].Reasons[0]).toMatch(/^The same property as listing OS\d+, which is Active\.$/);
  });

  it("creates nothing when the capability is revoked between preview and commit, or while the commit waits", async () => {
    const importer = (await createMember(admin, { firstName: "Importing", lastName: `Staff${++serial}`, email: `importer-${run}-${serial}@osmls.example`, memberId: `IM${run}-${serial}`, role: "staff", officeKey: "", phone: "" })).member;
    await setCapabilities(admin, importer.MemberKey, ["imports"], "test");
    const [holder] = await db.select().from(member).where(eq(member.MemberKey, importer.MemberKey));
    const street = `Revoked Rd ${run}`;
    const waiting = await upload([row({ StreetName: street })], `Source ${run}`, holder);
    // Revoked while the commit is waiting for the authority turn.
    const late = await overlapping(AUTHORITY_TURN, `update "Member" set "OsmlsCapabilities" = '{}' where "MemberKey" = '${holder.MemberKey}'`, () => commitImport(holder, waiting.ImportKey));
    expect(late).toMatchObject({ status: "rejected", reason: { message: "Not found." } });
    // Revoked beforehand: the session still says it holds the capability.
    await expect(commitImport(holder, waiting.ImportKey)).rejects.toThrow("Not found.");
    await expect(upload([row({ StreetName: street })], `Source ${run}`, holder)).rejects.toThrow("Not found.");
    expect(await listingsIn(street)).toEqual([]);
    expect((await db.select().from(listingImport).where(eq(listingImport.ImportKey, waiting.ImportKey)))[0].State).toBe("Previewed");
  });
});

describe("what is kept, and for how long", () => {
  it("stops offering a preview after its time, and deletes what it held at the next clean-up", async () => {
    const street = `Expired Rd ${run}`;
    const old = await upload([row({ StreetName: street })]);
    const recent = await upload([row({ StreetName: street })]);
    const done = await upload([row({ StreetName: `Kept Rd ${run}` })]);
    await commitImport(admin, done.ImportKey);
    const longAgo = new Date(Date.now() - (IMPORT_PREVIEW_HOURS + 1) * 60 * 60 * 1000);
    await db.update(listingImport).set({ OriginalEntryTimestamp: longAgo }).where(inArray(listingImport.ImportKey, [old.ImportKey, done.ImportKey]));

    // Past its time: not shown, not listed, and not committable. Nothing has been deleted yet.
    expect(await getImport(admin, old.ImportKey)).toBeNull();
    expect((await listImports(admin))!.map((i) => i.importKey)).not.toContain(old.ImportKey);
    await expect(commitImport(admin, old.ImportKey)).rejects.toThrow("Not found.");
    expect(await listingsIn(street)).toEqual([]);
    expect((await db.select().from(listingImportRow).where(eq(listingImportRow.ImportKey, old.ImportKey)))[0].Content).not.toBeNull();

    // The scheduled clean-up deletes it, with what its rows held. A recent preview and a committed import are untouched.
    expect((await cleanUpImports()).previewsDeleted).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(listingImport).where(eq(listingImport.ImportKey, old.ImportKey))).toEqual([]);
    expect(await db.select().from(listingImportRow).where(eq(listingImportRow.ImportKey, old.ImportKey))).toEqual([]);
    expect(await getImport(admin, recent.ImportKey)).not.toBeNull();
    const kept = (await getImport(admin, done.ImportKey))!;
    expect(kept.import.State).toBe("Committed");
    expect(kept.rows[0].listingId).toMatch(/^OS\d+$/);
  });

  it("shows an imported listing as new activity on a saved search, like any new listing", async () => {
    const city = `ImportActivity${run}`;
    const saved = await createSavedSearch(agent, `Imports ${run}`, { ...DEFAULT_CRITERIA, city, statuses: [] });
    expect((await getActivity(agent, saved.SavedSearchKey))!.matching).toEqual([]);
    const preview = await upload([row({ City: city, StreetName: `Activity Rd ${run}` })]);
    await commitImport(admin, preview.ImportKey);
    const [created] = await listingsIn(`Activity Rd ${run}`);
    expect((await getActivity(agent, saved.SavedSearchKey))!.matching.map((l) => l.ListingId)).toEqual([created.ListingId]);
    await db.delete(savedSearch).where(eq(savedSearch.SavedSearchKey, saved.SavedSearchKey));
  });
});

