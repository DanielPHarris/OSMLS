/*
 * A member suspended while one of their listing or attachment writes is
 * already under way. The request was allowed when it began; by the time it
 * saves, the member is suspended. Nothing is saved.
 *
 * The overlap is made certain: another connection holds the member's row as a
 * suspension does, the write is started and seen to be waiting for it, the
 * member is suspended and that committed, and only then does the write go on.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { historyTransactional, media, member, property, type Member } from "../src/db/schema";
import { addDocument, removeDocument, replaceDocument, updateDocument } from "../src/lib/documents";
import { addPhoto, createListing, removePhoto, updateListing } from "../src/lib/listings";
import { overlapping } from "./overlap";

const run = Date.now();
let agent: Member;
let staff: Member;
let serial = 0;

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const form = (changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-15",
  StreetNumber: String(++serial), StreetName: "Suspension Race Rd", City: `Racetown${run}`, StateOrProvince: "WA", PostalCode: "98999",
  BedroomsTotal: "3", BathroomsTotalInteger: "2", ...changes,
});
const rowOf = (m: Member) => `select 1 from "Member" where "MemberKey" = '${m.MemberKey}' for update`;
const suspend = (m: Member) => `update "Member" set "MemberStatus" = 'Inactive' where "MemberKey" = '${m.MemberKey}'`;
/** Everything recorded about a listing, to show that nothing changed. */
const recorded = async (listingKey: string) => ({
  listing: (await db.select().from(property).where(eq(property.ListingKey, listingKey)))[0],
  media: await db.select().from(media).where(eq(media.ResourceRecordKey, listingKey)).orderBy(media.MediaKey),
  history: (await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, listingKey))).length,
});

beforeAll(async () => {
  const members = await db.select().from(member);
  agent = members.find((m) => m.MemberMlsId === "AG1003")!;
  staff = members.find((m) => m.MemberMlsId === "ST0002")!;
});
afterEach(async () => {
  for (const m of [agent, staff]) await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, m.MemberKey));
});
afterAll(() => pool.end());

/** A listing of the agent's with a photo and a document, made while the agent is active. */
async function listed() {
  const fields = form();
  const listing = await createListing(agent, fields);
  const photo = await addPhoto(agent, listing.ListingKey, png());
  const document = await addDocument(agent, listing.ListingKey, { bytes: pdf("first"), name: "Disclosure.pdf", permission: "Private" });
  return { fields, listing, photo, document };
}
type Listed = Awaited<ReturnType<typeof listed>>;

const WRITES: Record<string, (who: Member, l: Listed, reason?: string) => Promise<unknown>> = {
  "changing the price": (who, l, reason) => updateListing(who, l.listing.ListingKey, { ...l.fields, ListPrice: "480000" }, reason),
  "adding a photo": (who, l, reason) => addPhoto(who, l.listing.ListingKey, png(), reason),
  "removing a photo": (who, l, reason) => removePhoto(who, l.photo.MediaKey, reason),
  "adding a document": (who, l, reason) => addDocument(who, l.listing.ListingKey, { bytes: pdf("second"), name: "Second.pdf", permission: "Private" }, reason),
  "replacing a document": (who, l, reason) => replaceDocument(who, l.document.MediaKey, pdf("replacement"), reason),
  "renaming a document": (who, l, reason) => updateDocument(who, l.document.MediaKey, { name: "Renamed.pdf", permission: "Private" }, reason),
  "removing a document": (who, l, reason) => removeDocument(who, l.document.MediaKey, reason),
};

describe("an agent suspended while their write is under way", () => {
  for (const [what, write] of Object.entries(WRITES)) {
    it(`${what} saves nothing`, async () => {
      const l = await listed();
      const before = await recorded(l.listing.ListingKey);
      const result = await overlapping(rowOf(agent), suspend(agent), () => write(agent, l));
      expect(result.status).toBe("rejected");
      // A document's existence is not confirmed to a suspended member, as before.
      const told = /a document/.test(what) && what !== "adding a document" ? "Document not found." : "Your account is suspended. Nothing was saved.";
      expect(String((result as PromiseRejectedResult).reason)).toContain(told);
      expect(await recorded(l.listing.ListingKey)).toEqual(before);
    });
  }

  it("entering a listing saves nothing", async () => {
    const fields = form();
    const result = await overlapping(rowOf(agent), suspend(agent), () => createListing(agent, fields));
    expect(result.status).toBe("rejected");
    expect(String((result as PromiseRejectedResult).reason)).toContain("Your account is suspended.");
    expect(await db.select().from(property).where(and(eq(property.City, fields.City), eq(property.StreetNumber, fields.StreetNumber)))).toEqual([]);
  });
});

describe("staff suspended while their correction is under way", () => {
  for (const [what, write] of Object.entries(WRITES)) {
    it(`${what} saves nothing`, async () => {
      const l = await listed();
      const before = await recorded(l.listing.ListingKey);
      const result = await overlapping(rowOf(staff), suspend(staff), () => write(staff, l, "A correction, begun before the suspension."));
      expect(result.status).toBe("rejected");
      expect(await recorded(l.listing.ListingKey)).toEqual(before);
    });
  }
});

describe("a member who is not suspended", () => {
  it("is not held up or refused: each write still saves", async () => {
    for (const write of Object.values(WRITES)) {
      const l = await listed();
      await write(agent, l);
      expect(await recorded(l.listing.ListingKey)).not.toEqual(await recorded((await listed()).listing.ListingKey));
    }
  });
});
