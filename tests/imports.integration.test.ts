/*
 * Importing new listings from a file, against the test database (issue #35).
 * This is the first proof; the fuller set comes with the rest of the slice.
 */
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { historyTransactional, listingImport, listingImportRow, member, property, type Member } from "../src/db/schema";
import { commitImport, getImport, listImports, parseCsv, previewImport } from "../src/lib/imports";
import { listingInputSchema } from "../src/lib/listing-input";
import { searchListings } from "../src/lib/listings";
import { createMember, setCapabilities, setMemberStatus } from "../src/lib/members";
import { IMPORT_COLUMNS, LISTING_COLUMNS } from "../src/lib/rules/imports";
import { DEFAULT_CRITERIA, criteriaToFilters } from "../src/lib/search-criteria";

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
