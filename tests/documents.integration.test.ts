/*
 * Runs against the test database. Covers document storage, validation, history,
 * and the rule that restricted content is left out for viewers not allowed it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepUnreferencedFiles } from "../src/lib/backup";
import { db, pool } from "../src/db";
import { historyTransactional, media, member, type Member } from "../src/db/schema";
import {
  addDocument,
  documentPath,
  documentsDir,
  getDocumentForViewer,
  removeDocument,
  replaceDocument,
  sniffDocumentType,
  updateDocument,
} from "../src/lib/documents";
import {
  ListingError,
  addPhoto,
  createListing,
  getListing,
  getPhoto,
  removePhoto,
  searchListings,
  updateListing,
  mediaDir,
} from "../src/lib/listings";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS_PER_LISTING } from "../src/lib/rules/local";

let who: Record<"listingAgent" | "sameOffice" | "otherOffice" | "staff" | "suspendedAgent" | "suspendedStaff", Member>;

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const SHOWING = {
  ShowingInstructions: "Ring twice; the dog is friendly.",
  ShowingRequirements: "Appointment Only|Call Listing Agent",
  ShowingContactName: "Pat Seller",
  ShowingContactPhone: "555-0142",
  ShowingContactType: "Owner",
  LockBoxType: "Supra",
  LockBoxLocation: "Side gate",
};

const input = (changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active",
  PropertyType: "Residential",
  ListPrice: "500000",
  ListingContractDate: "2026-01-15",
  StreetNumber: "5",
  StreetName: "Document Test Ct",
  City: "Testville",
  StateOrProvince: "WA",
  PostalCode: "98999",
  BedroomsTotal: "3",
  BathroomsTotalInteger: "2",
  ...changes,
});

const newListing = (changes: Record<string, unknown> = {}) => createListing(who.listingAgent, input(changes));
const documentHistory = async (listingKey: string) =>
  (await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, listingKey))).filter((r) =>
    r.FieldName.startsWith("Document"),
  );

beforeAll(async () => {
  const members = await db.select().from(member);
  const byId = (id: string) => {
    const m = members.find((x) => x.MemberMlsId === id);
    if (!m) throw new Error(`Seed data missing member ${id}. Run pnpm test:db.`);
    return m;
  };
  who = {
    listingAgent: byId("AG1001"),
    sameOffice: byId("AG1002"),
    otherOffice: byId("AG2001"),
    staff: byId("ST0001"),
    suspendedAgent: byId("AG1099"),
    suspendedStaff: byId("ST0099"),
  };
  // The seed must provide what these tests rely on.
  expect(who.sameOffice.OfficeKey).toBe(who.listingAgent.OfficeKey);
  expect(who.suspendedAgent.OfficeKey).toBe(who.listingAgent.OfficeKey);
  expect(who.otherOffice.OfficeKey).not.toBe(who.listingAgent.OfficeKey);
  expect([who.suspendedAgent.MemberStatus, who.suspendedStaff.MemberStatus]).toEqual(["Inactive", "Inactive"]);
});

afterAll(() => pool.end());

/*
 * A file is not deleted when its record is removed or replaced: a backup being
 * taken may refer to it (src/lib/backup.ts). It is deleted by the sweep, once
 * no record refers to it. These tests run the sweep as the scheduled command
 * would.
 */
const sweep = () => sweepUnreferencedFiles({ databaseUrl: process.env.DATABASE_URL!, mediaDir: mediaDir() });

describe("file validation", () => {
  it("identifies PDF, JPEG, and PNG by content", () => {
    expect(sniffDocumentType(pdf("x"))?.mime).toBe("application/pdf");
    expect(sniffDocumentType(png())?.mime).toBe("image/png");
    expect(sniffDocumentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
  });

  it.each([
    ["a Windows program", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0])],
    ["a web page", new TextEncoder().encode("<html><script>alert(1)</script></html>")],
    ["a Word file (zip)", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])],
    ["text that mentions PDF later", new TextEncoder().encode("hello %PDF-1.4")],
  ])("refuses %s, whatever it is called", async (_label, bytes) => {
    const listing = await newListing();
    await expect(
      addDocument(who.listingAgent, listing.ListingKey, { bytes, name: "Disclosure.pdf", permission: "Private" }),
    ).rejects.toThrow(/must be PDF, JPEG, or PNG/);
    expect(await db.select().from(media).where(eq(media.ResourceRecordKey, listing.ListingKey))).toHaveLength(0);
  });

  it("refuses an empty file and one over the size limit", async () => {
    const listing = await newListing();
    const add = (bytes: Uint8Array) =>
      addDocument(who.listingAgent, listing.ListingKey, { bytes, name: "Big", permission: "Private" });
    await expect(add(new Uint8Array())).rejects.toThrow(/Choose a file/);
    const tooBig = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    tooBig.set(pdf("big"));
    await expect(add(tooBig)).rejects.toThrow(/larger than 15 MB/);
  });

  it("requires a name and a known permission", async () => {
    const listing = await newListing();
    const add = (name: unknown, permission: unknown) =>
      addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name, permission });
    await expect(add("   ", "Private")).rejects.toThrow(/Give the document a name/);
    await expect(add("x".repeat(121), "Private")).rejects.toThrow(/too long/);
    await expect(add("Fine", "Public")).rejects.toThrow(/Choose who can see/);
    await expect(add("Fine", "IDX")).rejects.toThrow(/Choose who can see/);
  });

  it("enforces the per-listing limit", async () => {
    const listing = await newListing();
    for (let i = 1; i <= MAX_DOCUMENTS_PER_LISTING; i++)
      await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf(`n${i}`), name: `Doc ${i}`, permission: "Private" });
    await expect(
      addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("one more"), name: "One more", permission: "Private" }),
    ).rejects.toThrow(/at most 25 documents/);
  });
});

describe("storing and changing documents", () => {
  it("stores a new document privately, restricted by default, and records it", async () => {
    const listing = await newListing();
    const bytes = pdf("listing agreement");
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes, name: "  Listing   agreement ", permission: undefined });

    expect(doc).toMatchObject({
      MediaCategory: "Document",
      MediaType: "application/pdf",
      ShortDescription: "Listing agreement",
      Permission: "Agent Only",
      OsmlsFileSize: bytes.length,
      OsmlsFileHash: sha(bytes),
    });
    // Stored under a generated name that owes nothing to the name given.
    expect(doc.OsmlsStoragePath).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(true);
    expect(statSync(documentPath(doc.OsmlsStoragePath)).mode & 0o077).toBe(0);

    const [row] = await documentHistory(listing.ListingKey);
    expect(row.NewValue).toContain("Listing agreement");
    expect(row.NewValue).toContain(sha(bytes));
    expect(row.NewValue).toContain(`${bytes.length} bytes`);
    expect(row.NewValue).toContain("Agent Only");
    expect(row).toMatchObject({ PreviousValue: null, ChangedByMemberID: "AG1001", OsmlsStaffCorrection: false });
  });

  it("replaces the file, keeps name and permission, leaves the old file for the sweep to destroy, and keeps a record of it", async () => {
    const listing = await newListing();
    const first = pdf("first version");
    const second = png();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: first, name: "Floor plan", permission: "Office Only" });
    const replaced = await replaceDocument(who.listingAgent, doc.MediaKey, second);

    expect(replaced).toMatchObject({
      MediaKey: doc.MediaKey,
      ShortDescription: "Floor plan",
      Permission: "Office Only",
      MediaType: "image/png",
      OsmlsFileHash: sha(second),
    });
    // The record now points at the new file, so the old one is served to no one. It stays on disk until the sweep.
    expect(replaced.OsmlsStoragePath).not.toBe(doc.OsmlsStoragePath);
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(true);
    await sweep();
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(false);
    expect(existsSync(documentPath(replaced.OsmlsStoragePath))).toBe(true);

    const row = (await documentHistory(listing.ListingKey)).find((r) => r.PreviousValue?.startsWith("Replaced"));
    expect(row?.PreviousValue).toContain(sha(first));
    expect(row?.NewValue).toContain(sha(second));
  });

  it("refuses a replacement of the wrong type and leaves the original in place", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("keep me"), name: "Survey", permission: "Private" });
    await expect(replaceDocument(who.listingAgent, doc.MediaKey, new TextEncoder().encode("not a pdf"))).rejects.toThrow(ListingError);
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(true);
    expect(await documentHistory(listing.ListingKey)).toHaveLength(1);
  });

  it("records a rename and a permission change, and nothing when nothing changes", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name: "Disclosure", permission: "Agent Only" });
    expect((await updateDocument(who.listingAgent, doc.MediaKey, { name: "Disclosure", permission: "Agent Only" })).changed).toBe(false);
    await updateDocument(who.listingAgent, doc.MediaKey, { name: "Seller disclosure", permission: "Private" });

    const rows = (await documentHistory(listing.ListingKey)).map((r) => [r.FieldName, r.PreviousValue, r.NewValue]);
    expect(rows).toContainEqual(["Document name", "Disclosure", "Seller disclosure"]);
    expect(rows).toContainEqual(["Document permission", "Seller disclosure: Agent Only", "Seller disclosure: Private"]);
    expect(rows).toHaveLength(3);
    await expect(updateDocument(who.listingAgent, doc.MediaKey, { name: "Seller disclosure", permission: "" })).rejects.toThrow(
      /Choose who can see/,
    );
  });

  it("deletes the record at once and the file at the next sweep, and keeps a record of what it was", async () => {
    const listing = await newListing();
    const bytes = pdf("to be deleted");
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes, name: "Old inspection", permission: "Private" });
    await removeDocument(who.listingAgent, doc.MediaKey);

    expect(await db.select().from(media).where(eq(media.MediaKey, doc.MediaKey))).toHaveLength(0);
    // Gone from the application at once: no one is served it. Its file goes at the sweep.
    expect(await getDocumentForViewer(who.listingAgent, doc.MediaKey)).toBeNull();
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(true);
    await sweep();
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(false);
    const row = (await documentHistory(listing.ListingKey)).find((r) => r.PreviousValue?.startsWith("Deleted"));
    expect(row?.PreviousValue).toContain("Old inspection");
    expect(row?.PreviousValue).toContain(sha(bytes));
    expect(row?.NewValue).toBeNull();
  });

  it("keeps one file and a truthful history when two replacements overlap", async () => {
    // Repeated, because the outcome depends on which request gets the listing first.
    for (let round = 0; round < 6; round++) {
      const listing = await newListing();
      const original = pdf(`original ${round}`);
      const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: original, name: "Contested", permission: "Private" });
      const a = pdf(`replacement A ${round}`);
      const b = pdf(`replacement B ${round}`);
      const [first, second] = await Promise.all([
        replaceDocument(who.listingAgent, doc.MediaKey, a),
        replaceDocument(who.listingAgent, doc.MediaKey, b),
      ]);

      const [final] = await db.select().from(media).where(eq(media.MediaKey, doc.MediaKey));
      expect([sha(a), sha(b)]).toContain(final.OsmlsFileHash);
      // Once the sweep has run, only the file the record points at is left on disk.
      const paths = [doc.OsmlsStoragePath, first.OsmlsStoragePath, second.OsmlsStoragePath];
      await sweep();
      expect(paths.filter((p) => existsSync(documentPath(p)))).toEqual([final.OsmlsStoragePath]);

      // History is a chain: original -> one replacement -> the other, ending at the stored file.
      const rows = (await documentHistory(listing.ListingKey)).filter((r) => r.PreviousValue?.startsWith("Replaced"));
      expect(rows).toHaveLength(2);
      const hashIn = (value: string | null) => value!.match(/SHA-256 ([0-9a-f]{64})/)![1];
      const links = rows.map((r) => [hashIn(r.PreviousValue), hashIn(r.NewValue)]);
      const fromOriginal = links.find(([from]) => from === sha(original))!;
      const fromMiddle = links.find(([from]) => from !== sha(original))!;
      expect(fromOriginal).toBeDefined();
      expect(fromMiddle[0]).toBe(fromOriginal[1]);
      expect(fromMiddle[1]).toBe(final.OsmlsFileHash);

      // Deleting afterwards leaves nothing behind, once the sweep has run.
      await removeDocument(who.listingAgent, doc.MediaKey);
      await sweep();
      expect(paths.filter((p) => existsSync(documentPath(p)))).toEqual([]);
    }
  });

  it("leaves no file behind after the sweep when a replacement and a deletion overlap", async () => {
    for (let round = 0; round < 6; round++) {
      const listing = await newListing();
      const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf(`o${round}`), name: "Going", permission: "Private" });
      const before = new Set(readdirSync(documentsDir()));
      const [replaced, removed] = await Promise.allSettled([
        replaceDocument(who.listingAgent, doc.MediaKey, pdf(`r${round}`)),
        removeDocument(who.listingAgent, doc.MediaKey),
      ]);
      expect(removed.status).toBe("fulfilled");
      // The replacement either happened first, or found the document already gone.
      if (replaced.status === "rejected") expect(String(replaced.reason)).toContain("Document not found.");

      expect(await db.select().from(media).where(eq(media.MediaKey, doc.MediaKey))).toHaveLength(0);
      await sweep();
      expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(false);
      // No new file survives either, whichever order they ran in.
      expect(readdirSync(documentsDir()).filter((f) => !before.has(f))).toEqual([]);
      // Exactly one deletion is recorded, and it names the file that was actually stored last.
      const deletions = (await documentHistory(listing.ListingKey)).filter((r) => r.PreviousValue?.startsWith("Deleted"));
      expect(deletions).toHaveLength(1);
    }
  });

  it("records a photo's removal once when two removals overlap", async () => {
    const listing = await newListing();
    const photo = await addPhoto(who.listingAgent, listing.ListingKey, png());
    const results = await Promise.allSettled([
      removePhoto(who.listingAgent, photo.MediaKey),
      removePhoto(who.listingAgent, photo.MediaKey),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rows = await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, listing.ListingKey));
    expect(rows.filter((r) => r.FieldName === "Media" && r.NewValue === null)).toHaveLength(1);
  });

  it("is refused by the database if a document has no permission, name, or hash", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name: "Check", permission: "Private" });
    const set = (assignment: string) =>
      db.execute(sql.raw(`update "Media" set ${assignment} where "MediaKey" = '${doc.MediaKey}'`));
    await expect(set(`"Permission" = null`)).rejects.toBeTruthy();
    await expect(set(`"Permission" = 'Public'`)).rejects.toBeTruthy();
    await expect(set(`"ShortDescription" = ' '`)).rejects.toBeTruthy();
    await expect(set(`"ShortDescription" = null`)).rejects.toBeTruthy();
    await expect(set(`"OsmlsFileHash" = null`)).rejects.toBeTruthy();
    await expect(set(`"MediaCategory" = 'Video'`)).rejects.toBeTruthy();
  });
});

describe("who may manage documents", () => {
  it("refuses everyone but the listing agent and MLS staff", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name: "Mine", permission: "Private" });
    for (const outsider of [who.sameOffice, who.otherOffice]) {
      const refused = /Only the listing agent or MLS staff/;
      await expect(addDocument(outsider, listing.ListingKey, { bytes: pdf("y"), name: "Theirs", permission: "Private" })).rejects.toThrow(refused);
      await expect(replaceDocument(outsider, doc.MediaKey, pdf("y"))).rejects.toThrow(refused);
      await expect(updateDocument(outsider, doc.MediaKey, { name: "Renamed", permission: "Private" })).rejects.toThrow(refused);
      await expect(removeDocument(outsider, doc.MediaKey)).rejects.toThrow(refused);
    }
    const [unchanged] = await db.select().from(media).where(eq(media.MediaKey, doc.MediaKey));
    expect(unchanged).toMatchObject({ ShortDescription: "Mine", OsmlsFileHash: doc.OsmlsFileHash });
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(true);
    expect(await documentHistory(listing.ListingKey)).toHaveLength(1);
  });

  it("tells someone who may not see a document only that it was not found", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name: "Hidden", permission: "Agent Only" });
    for (const outsider of [who.sameOffice, who.otherOffice, who.suspendedAgent, who.suspendedStaff]) {
      await expect(replaceDocument(outsider, doc.MediaKey, pdf("y"))).rejects.toThrow("Document not found.");
      await expect(updateDocument(outsider, doc.MediaKey, { name: "Seen", permission: "Private" })).rejects.toThrow("Document not found.");
      await expect(removeDocument(outsider, doc.MediaKey)).rejects.toThrow("Document not found.");
    }
    await expect(removeDocument(who.otherOffice, "00000000-0000-4000-8000-000000000000")).rejects.toThrow("Document not found.");
    expect(existsSync(documentPath(doc.OsmlsStoragePath))).toBe(true);
  });

  it("requires a reason from staff and marks their change as a correction", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name: "Agreement", permission: "Agent Only" });
    await expect(updateDocument(who.staff, doc.MediaKey, { name: "Agreement", permission: "Private" }, " ")).rejects.toThrow(/needs a reason/);
    await expect(removeDocument(who.staff, doc.MediaKey)).rejects.toThrow(/needs a reason/);
    await updateDocument(who.staff, doc.MediaKey, { name: "Agreement", permission: "Office Only" }, "Agent asked for office access.");
    const row = (await documentHistory(listing.ListingKey)).find((r) => r.FieldName === "Document permission");
    expect(row).toMatchObject({ ChangedByMemberID: "ST0001", OsmlsStaffCorrection: true, OsmlsCorrectionReason: "Agent asked for office access." });
  });

  it("locks documents for the agent once the listing is closed", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name: "Final", permission: "Private" });
    await updateListing(who.listingAgent, listing.ListingKey, input({ StandardStatus: "Pending" }));
    await updateListing(who.listingAgent, listing.ListingKey, input({ StandardStatus: "Closed", ClosePrice: "490000", CloseDate: "2026-02-01" }));
    await expect(removeDocument(who.listingAgent, doc.MediaKey)).rejects.toThrow(/only be changed by MLS staff/);
    await expect(addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("y"), name: "Late", permission: "Private" })).rejects.toThrow(
      /only be changed by MLS staff/,
    );
  });
});

describe("who may read documents", () => {
  it("gives each viewer only the documents their permission allows", async () => {
    const listing = await newListing();
    const add = (name: string, permission: string) =>
      addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf(name), name, permission });
    const docs = {
      "Agent Only": await add("Agent-only file", "Agent Only"),
      "Office Only": await add("Office-only file", "Office Only"),
      Private: await add("Members file", "Private"),
    };
    const expected: Record<keyof typeof who, string[]> = {
      listingAgent: ["Agent Only", "Office Only", "Private"],
      sameOffice: ["Office Only", "Private"],
      otherOffice: ["Private"],
      staff: ["Agent Only", "Office Only", "Private"],
      suspendedAgent: [],
      suspendedStaff: [],
    };

    for (const [name, viewer] of Object.entries(who) as [keyof typeof who, Member][]) {
      // By direct request for each document...
      for (const [permission, doc] of Object.entries(docs)) {
        const got = await getDocumentForViewer(viewer, doc.MediaKey);
        expect(got?.MediaKey ?? null, `${name} / ${permission}`).toBe(expected[name].includes(permission) ? doc.MediaKey : null);
      }
      // ...and in the listing as that viewer receives it.
      const seen = (await getListing(listing.ListingKey, viewer))!.documents.map((d) => d.Permission).sort();
      expect(seen, name).toEqual([...expected[name]].sort());
    }
    for (const doc of Object.values(docs)) expect(await getDocumentForViewer(null, doc.MediaKey)).toBeNull();
    expect((await getListing(listing.ListingKey, null))!.documents).toEqual([]);
  });

  it("answers the same for a document that is forbidden and one that does not exist", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: pdf("x"), name: "Secret", permission: "Agent Only" });
    expect(await getDocumentForViewer(who.otherOffice, doc.MediaKey)).toBeNull();
    expect(await getDocumentForViewer(who.otherOffice, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await getDocumentForViewer(who.otherOffice, "not-a-key")).toBeNull();
  });

  it("never serves or removes a document through the photo functions", async () => {
    const listing = await newListing();
    const doc = await addDocument(who.listingAgent, listing.ListingKey, { bytes: png(), name: "Scan", permission: "Agent Only" });
    expect(await getPhoto(doc.MediaKey)).toBeNull();
    await expect(removePhoto(who.listingAgent, doc.MediaKey)).rejects.toThrow(/Photo not found/);
    expect((await getListing(listing.ListingKey, who.listingAgent))!.photos).toEqual([]);
    const found = await searchListings({ listingId: listing.ListingId });
    expect(found.rows[0].firstPhotoKey).toBeNull();
  });
});

describe("photo thumbnails in search results", () => {
  it("gives each listing its own first photo, and none to a listing without one", async () => {
    const street = `Thumbnail St ${Date.now()}`;
    const [withPhoto, without, other] = [await newListing({ StreetName: street }), await newListing({ StreetName: street }), await newListing({ StreetName: street })];
    const first = await addPhoto(who.listingAgent, withPhoto.ListingKey, png());
    await addPhoto(who.listingAgent, withPhoto.ListingKey, png());
    const theirs = await addPhoto(who.listingAgent, other.ListingKey, png());
    const { rows } = await searchListings({ address: street });
    const thumbnails = Object.fromEntries(rows.map((r) => [r.listing.ListingKey, r.firstPhotoKey]));
    expect(thumbnails).toEqual({ [withPhoto.ListingKey]: first.MediaKey, [without.ListingKey]: null, [other.ListingKey]: theirs.MediaKey });
  });
});

describe("who may read showing instructions", () => {
  const showingOf = async (listingKey: string, viewer: Member | null) => {
    const found = (await getListing(listingKey, viewer))!;
    return { visible: found.showingVisible, text: JSON.stringify(found.listing) };
  };

  it("records showing changes in history like any other field", async () => {
    const listing = await newListing();
    const { changedFields } = await updateListing(who.listingAgent, listing.ListingKey, input(SHOWING));
    expect(changedFields.sort()).toEqual(Object.keys(SHOWING).sort());
    const rows = await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, listing.ListingKey));
    expect(rows.find((r) => r.FieldName === "ShowingRequirements")).toMatchObject({
      PreviousValue: null,
      NewValue: "Appointment Only, Call Listing Agent",
    });
  });

  it("refuses choices that are not on the lists", async () => {
    await expect(newListing({ ShowingRequirements: "Appointment Only|Bring Snacks" })).rejects.toThrow(ListingError);
    await expect(newListing({ LockBoxType: "Combo|1234" })).rejects.toThrow(ListingError);
    await expect(newListing({ ShowingContactName: "x".repeat(41) })).rejects.toThrow(ListingError);
  });

  it("shows them to every active member while the listing is on the market, and to no suspended account", async () => {
    const listing = await newListing(SHOWING);
    for (const name of ["listingAgent", "sameOffice", "otherOffice", "staff"] as const) {
      const got = await showingOf(listing.ListingKey, who[name]);
      expect(got.visible, name).toBe(true);
      expect(got.text, name).toContain("the dog is friendly");
    }
    for (const viewer of [who.suspendedAgent, who.suspendedStaff, null]) {
      const got = await showingOf(listing.ListingKey, viewer);
      expect(got.visible).toBe(false);
      for (const secret of ["dog is friendly", "Pat Seller", "555-0142", "Side gate", "Supra", "Appointment Only"])
        expect(got.text).not.toContain(secret);
    }
  });

  it("restricts them to the listing side once the listing is closed", async () => {
    const listing = await newListing(SHOWING);
    await updateListing(who.listingAgent, listing.ListingKey, input({ ...SHOWING, StandardStatus: "Pending" }));
    await updateListing(
      who.listingAgent,
      listing.ListingKey,
      input({ ...SHOWING, StandardStatus: "Closed", ClosePrice: "490000", CloseDate: "2026-02-01" }),
    );
    for (const name of ["listingAgent", "sameOffice", "staff"] as const)
      expect((await showingOf(listing.ListingKey, who[name])).visible, name).toBe(true);
    const outsider = await showingOf(listing.ListingKey, who.otherOffice);
    expect(outsider.visible).toBe(false);
    for (const secret of ["dog is friendly", "Pat Seller", "555-0142", "Side gate", "Supra", "Appointment Only"])
      expect(outsider.text).not.toContain(secret);
  });

  it("never includes them in search results, even for the listing agent", async () => {
    const listing = await newListing(SHOWING);
    const { rows } = await searchListings({ listingId: listing.ListingId });
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    for (const secret of ["dog is friendly", "Pat Seller", "555-0142", "Side gate", "Supra", "Appointment Only"])
      expect(text).not.toContain(secret);
  });
});
