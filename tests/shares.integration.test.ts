/*
 * Links shared with clients, against the test database and the mail catcher:
 * what a link shows, every way access ends for the page and for photos, who may
 * make and revoke links, the limits, and what becomes of a recipient's address.
 */
import { eq, like, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { collection, mailBlock, member, share, type Member, type Property } from "../src/db/schema";
import { addPhoto, createListing } from "../src/lib/listings";
import {
  MAX_ACTIVE_SHARES_PER_MEMBER,
  MAX_LISTINGS_PER_REPORT,
  MAX_SHARE_EMAILS_PER_DAY,
  MAX_SHARE_NOTE_LENGTH,
  SHARE_RECORD_RETENTION_DAYS,
} from "../src/lib/rules/local";
import { addToCollection, createCollection, deleteCollection } from "../src/lib/saved-work";
import { canStopEmail, cleanUpShares, createShare, getSharedPage, getSharedPhoto, listShares, revokeShare, stopEmail } from "../src/lib/shares";

const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const SHOWING_MARK = `showing-mark-${run}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let owner: Member;
let other: Member;
let serial = 0;

const fields = (changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
  StreetNumber: String(++serial), StreetName: "Shared Ave", City: `Shares${run}`, StateOrProvince: "WA", PostalCode: "96563",
  BedroomsTotal: "3", BathroomsTotalInteger: "2", ShowingInstructions: SHOWING_MARK, ...changes,
});
const make = (changes: Record<string, unknown> = {}, by: Member = owner) => createListing(by, fields(changes));
const setStatus = (listing: Property, status: string) =>
  db.execute(sql`update "Property" set "StandardStatus" = ${status} where "ListingKey" = ${listing.ListingKey}`);
const photoOf = async (listing: Property) => (await addPhoto(owner, listing.ListingKey, png)).MediaKey;
const tokenOf = (link: string) => link.split("/").pop()!;
const link = async (target: Parameters<typeof createShare>[1], by: Member = owner, input: Record<string, unknown> = {}) =>
  tokenOf((await createShare(by, target, input)).link);
const address = (label: string) => `${label}-${run}@clients.example`;
const rowFor = async (token: string) => {
  const { createHash } = await import("node:crypto");
  return (await db.select().from(share).where(eq(share.OsmlsTokenHash, createHash("sha256").update(token).digest("hex"))))[0];
};
const names = (n: number) => `Shares ${run} ${n}`;
let collections = 0;
const collect = async (listings: Property[], by: Member = owner) => {
  const made = await createCollection(by, names(++collections));
  if (listings.length) await addToCollection(by, made.CollectionKey, listings.map((l) => l.ListingKey));
  return made.CollectionKey;
};
const forget = async () => {
  await db.delete(share).where(or(eq(share.MemberKey, owner.MemberKey), eq(share.MemberKey, other.MemberKey)));
  await db.delete(collection).where(like(collection.CollectionName, `Shares ${run}%`));
};

beforeAll(async () => {
  const members = await db.select().from(member);
  owner = members.find((m) => m.MemberMlsId === "AG1001")!;
  other = members.find((m) => m.MemberMlsId === "AG2001")!;
});
afterAll(async () => {
  await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, owner.MemberKey));
  await forget();
  await pool.end();
});

describe("what a link shows", () => {
  it("shows one listing as the client copy, with photos addressed through the link", async () => {
    const listing = await make();
    const photo = await photoOf(listing);
    const token = await link({ listing: listing.ListingKey });
    const page = (await getSharedPage(token))!;
    expect(page.kind).toBe("listing");
    expect(page.sharedBy).toMatchObject({ name: owner.MemberFullName, email: owner.MemberEmail });
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0].photoUrls).toEqual([`/share/${token}/media/${photo}`]);
    expect(JSON.stringify(page).includes(SHOWING_MARK)).toBe(false);
    expect(JSON.stringify(page).includes(listing.ListingKey)).toBe(false);
    expect((await getSharedPhoto(token, photo))!.MediaKey).toBe(photo);
    // Only a hash of the link is stored.
    expect(JSON.stringify(await rowFor(token)).includes(token)).toBe(false);
  });

  it("shows a collection's current contents: later additions appear, and other statuses are left out and counted", async () => {
    const first = await make();
    const comingSoon = await make({ StandardStatus: "Coming Soon" });
    const key = await collect([first, comingSoon]);
    const token = await link({ collection: key });
    let page = (await getSharedPage(token))!;
    expect(page.kind).toBe("collection");
    expect(page.listings.map((l) => l.ListingId)).toEqual([first.ListingId]);
    expect(page.notes).toEqual([
      "1 listing in this collection is not included: client copies include only Active, Active Under Contract, Pending, Closed listings.",
    ]);
    // The collection's name is the member's own note, and is not given to the client.
    expect(JSON.stringify(page).includes(names(collections))).toBe(false);
    expect(JSON.stringify(page).includes(SHOWING_MARK)).toBe(false);

    // Added after the link was made: visible through it.
    const added = await make();
    await addToCollection(owner, key, [added.ListingKey]);
    page = (await getSharedPage(token))!;
    expect(page.listings.map((l) => l.ListingId)).toEqual([first.ListingId, added.ListingId]);
  });

  it("fills a collection page with eligible listings before cutting it short, and says so", async () => {
    const ineligible = await make({ StandardStatus: "Coming Soon" });
    const eligible: Property[] = [];
    for (let i = 0; i < MAX_LISTINGS_PER_REPORT + 1; i++) eligible.push(await make());
    const token = await link({ collection: await collect([ineligible, ...eligible]) });
    const page = (await getSharedPage(token))!;
    expect(page.listings).toHaveLength(MAX_LISTINGS_PER_REPORT);
    expect(page.listings[0].ListingId).toBe(eligible[0].ListingId);
    expect(page.notes[0]).toBe(`Showing the first ${MAX_LISTINGS_PER_REPORT} of ${MAX_LISTINGS_PER_REPORT + 1} listings.`);
    expect(page.notes).toHaveLength(2);
  });

  it("says nothing about a listing that has left the statuses given to clients, and withholds its photos", async () => {
    const listing = await make();
    const photo = await photoOf(listing);
    const token = await link({ listing: listing.ListingKey });
    await setStatus(listing, "Withdrawn");
    const page = (await getSharedPage(token))!;
    expect(page.listings).toEqual([]);
    expect(JSON.stringify(page).includes(listing.ListingId)).toBe(false);
    expect(await getSharedPhoto(token, photo)).toBeNull();
    // Back in an eligible status, the same link shows it again.
    await setStatus(listing, "Pending");
    expect((await getSharedPage(token))!.listings).toHaveLength(1);
    expect(await getSharedPhoto(token, photo)).not.toBeNull();
  });
});

describe("photos", () => {
  it("gives only the photos the link's page shows", async () => {
    const shown = await make();
    const first = await photoOf(shown);
    const second = await photoOf(shown);
    const elsewhere = await make();
    const foreign = await photoOf(elsewhere);
    const comingSoon = await make({ StandardStatus: "Coming Soon" });
    const hidden = await photoOf(comingSoon);

    const single = await link({ listing: shown.ListingKey });
    expect(await getSharedPhoto(single, first)).not.toBeNull();
    expect(await getSharedPhoto(single, second)).not.toBeNull();
    // Another listing's photo, through this link.
    expect(await getSharedPhoto(single, foreign)).toBeNull();
    expect(await getSharedPhoto(single, NO_SUCH_KEY)).toBeNull();
    expect(await getSharedPhoto(single, "not-a-key")).toBeNull();

    // A collection page shows each listing's first photo, so that is all its link gives.
    const list = await link({ collection: await collect([shown, comingSoon]) });
    expect(await getSharedPhoto(list, first)).not.toBeNull();
    expect(await getSharedPhoto(list, second)).toBeNull();
    expect(await getSharedPhoto(list, hidden)).toBeNull();
    expect(await getSharedPhoto(list, foreign)).toBeNull();
  });
});

describe("every way access ends", () => {
  const gone = async (token: string, photo: string) => {
    expect(await getSharedPage(token)).toBeNull();
    expect(await getSharedPhoto(token, photo)).toBeNull();
  };
  const works = async (token: string, photo: string) => {
    expect(await getSharedPage(token)).not.toBeNull();
    expect(await getSharedPhoto(token, photo)).not.toBeNull();
  };
  async function shared() {
    const listing = await make();
    const photo = await photoOf(listing);
    const key = await collect([listing]);
    return { listing, photo, key, single: await link({ listing: listing.ListingKey }), list: await link({ collection: key }) };
  }

  it("ends when the owner revokes it, and only that link", async () => {
    const { photo, single, list } = await shared();
    await revokeShare(owner, (await rowFor(single)).ShareKey);
    await gone(single, photo);
    await works(list, photo);
    // Revoking again changes nothing and is not an error.
    const first = (await rowFor(single)).OsmlsRevokedTimestamp;
    await revokeShare(owner, (await rowFor(single)).ShareKey);
    expect((await rowFor(single)).OsmlsRevokedTimestamp).toEqual(first);
  });

  it("ends when it expires", async () => {
    const { photo, single, list } = await shared();
    for (const token of [single, list]) {
      await works(token, photo);
      await db.update(share).set({ ExpirationTimestamp: new Date(Date.now() - 1000) }).where(eq(share.ShareKey, (await rowFor(token)).ShareKey));
      await gone(token, photo);
    }
  });

  it("ends while the owner's account is suspended, and works again once it is reinstated", async () => {
    const { photo, single, list } = await shared();
    await db.update(member).set({ MemberStatus: "Inactive" }).where(eq(member.MemberKey, owner.MemberKey));
    try {
      await gone(single, photo);
      await gone(list, photo);
    } finally {
      await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, owner.MemberKey));
    }
    await works(single, photo);
    await works(list, photo);
  });

  it("ends when the shared collection is deleted", async () => {
    const { photo, key, list, single } = await shared();
    await deleteCollection(owner, key);
    await gone(list, photo);
    await works(single, photo);
  });

  it("answers a link that never existed, or is not shaped like one, the same way", async () => {
    for (const token of ["A".repeat(43), "", "short", "../../etc/passwd", "A".repeat(44)]) {
      expect(await getSharedPage(token)).toBeNull();
      expect(await getSharedPhoto(token, NO_SUCH_KEY)).toBeNull();
    }
  });
});

describe("who may make and revoke links", () => {
  it("lets a member share only their own collection, and any listing a client may be given", async () => {
    const listing = await make();
    const key = await collect([listing]);
    // Another member: the listing is one they can see, so they may share it; the collection is not theirs.
    expect(await getSharedPage(await link({ listing: listing.ListingKey }, other))).not.toBeNull();
    await expect(createShare(other, { collection: key }, {})).rejects.toThrow("Collection not found.");
    await expect(createShare(owner, { collection: NO_SUCH_KEY }, {})).rejects.toThrow("Collection not found.");
    await expect(createShare(owner, { listing: NO_SUCH_KEY }, {})).rejects.toThrow("Listing not found.");
    const comingSoon = await make({ StandardStatus: "Coming Soon" });
    await expect(createShare(owner, { listing: comingSoon.ListingKey }, {})).rejects.toThrow("A Coming Soon listing cannot be shared with a client.");
    for (const viewer of [null, { ...owner, MemberStatus: "Inactive" }]) {
      await expect(createShare(viewer, { listing: listing.ListingKey }, {})).rejects.toThrow("Listing not found.");
      await expect(createShare(viewer, { collection: key }, {})).rejects.toThrow("Collection not found.");
    }
  });

  it("shows and revokes only the member's own links", async () => {
    const listing = await make();
    const mine = await link({ listing: listing.ListingKey });
    const theirs = await link({ listing: listing.ListingKey }, other);
    const mineKey = (await rowFor(mine)).ShareKey;
    expect((await listShares(owner, { listing: listing.ListingKey })).map((s) => s.ShareKey)).toEqual([mineKey]);
    expect((await listShares(other, { listing: listing.ListingKey })).map((s) => s.ShareKey)).toEqual([(await rowFor(theirs)).ShareKey]);
    expect(await listShares(null, { listing: listing.ListingKey })).toEqual([]);
    for (const viewer of [other, null, { ...owner, MemberStatus: "Inactive" }]) {
      await expect(revokeShare(viewer, mineKey)).rejects.toThrow("Link not found.");
    }
    await expect(revokeShare(owner, NO_SUCH_KEY)).rejects.toThrow("Link not found.");
    await expect(revokeShare(owner, "nonsense")).rejects.toThrow("Link not found.");
    expect(await getSharedPage(mine)).not.toBeNull();
    // A revoked link leaves the list.
    await revokeShare(owner, mineKey);
    expect(await listShares(owner, { listing: listing.ListingKey })).toEqual([]);
  });

  it("accepts only the offered lifetimes, one address, and a short note", async () => {
    const listing = await make();
    const target = { listing: listing.ListingKey };
    for (const days of [1, 31, 365, 0, -7, "forever"]) {
      await expect(createShare(owner, target, { days })).rejects.toThrow("Choose how long the link lasts.");
    }
    for (const email of ["not-an-address", "a@b.example, c@d.example", "a@b.example\nBcc: c@d.example"]) {
      await expect(createShare(owner, target, { email })).rejects.toThrow("Enter one email address, or leave it blank.");
    }
    await expect(createShare(owner, target, { note: "x".repeat(MAX_SHARE_NOTE_LENGTH + 1) })).rejects.toThrow("Keep the note");
    const made = await createShare(owner, target, { days: "90" });
    const days = (made.expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    // With nothing chosen, thirty days.
    const standard = await createShare(owner, target, {});
    expect(Math.round((standard.expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000))).toBe(30);
  });
});

describe("limits", () => {
  const filler = (count: number, values: Record<string, unknown>) =>
    db.insert(share).values(
      Array.from({ length: count }, (_, i) => ({
        MemberKey: other.MemberKey,
        OsmlsTokenHash: `filler-${run}-${serial++}-${i}`,
        ExpirationTimestamp: new Date(Date.now() + 60_000),
        ...values,
      })),
    );

  it("stops at the most working links a member may have, counting overlapping requests, and frees a place on revoking", async () => {
    await db.delete(share).where(eq(share.MemberKey, other.MemberKey));
    const listing = await make();
    const target = { listing: listing.ListingKey };
    await filler(MAX_ACTIVE_SHARES_PER_MEMBER - 1, { ListingKey: listing.ListingKey });
    // Two requests at once for the one remaining place.
    const results = await Promise.allSettled([createShare(other, target, {}), createShare(other, target, {})]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(createShare(other, target, {})).rejects.toThrow(`You have ${MAX_ACTIVE_SHARES_PER_MEMBER} working links`);
    // Another member is unaffected.
    await expect(createShare(owner, target, {})).resolves.toBeTruthy();
    const [mine] = await listShares(other, target);
    await revokeShare(other, mine.ShareKey);
    await expect(createShare(other, target, {})).resolves.toBeTruthy();
    await db.delete(share).where(eq(share.MemberKey, other.MemberKey));
  });

  it("stops at the most links a member may email in a day, whether or not those links still work", async () => {
    await db.delete(share).where(eq(share.MemberKey, other.MemberKey));
    const listing = await make();
    const target = { listing: listing.ListingKey };
    await filler(MAX_SHARE_EMAILS_PER_DAY, { ListingKey: listing.ListingKey, OsmlsSentTimestamp: new Date(), OsmlsRevokedTimestamp: new Date() });
    await expect(createShare(other, target, { email: address("limit") })).rejects.toThrow(`You have emailed ${MAX_SHARE_EMAILS_PER_DAY} links in the last day`);
    // A link the member sends themself is still allowed.
    await expect(createShare(other, target, {})).resolves.toBeTruthy();
    // Emails from more than a day ago do not count.
    await db.update(share).set({ OsmlsSentTimestamp: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(like(share.OsmlsTokenHash, `filler-${run}-%`));
    await expect(createShare(other, target, { email: address("limit") })).resolves.toMatchObject({ emailedTo: address("limit") });
    await db.delete(share).where(eq(share.MemberKey, other.MemberKey));
  });
});

describe("a recipient's address", () => {
  it("is deleted when the link is revoked", async () => {
    const listing = await make();
    const token = await link({ listing: listing.ListingKey }, owner, { email: address("revoked") });
    expect((await rowFor(token)).OsmlsRecipientEmail).toBe(address("revoked"));
    await revokeShare(owner, (await rowFor(token)).ShareKey);
    expect((await rowFor(token)).OsmlsRecipientEmail).toBeNull();
  });

  it("is deleted everywhere when the recipient asks for no more email; later sends are refused and links keep working", async () => {
    const listing = await make();
    const target = { listing: listing.ListingKey };
    const client = address("stop");
    const first = await link(target, owner, { email: client });
    const second = await link(target, other, { email: client.toUpperCase() });
    const unrelated = await link(target, owner, { email: address("someone-else") });
    const copied = await link(target);

    // Only a link that was emailed can be used to stop email.
    expect(await canStopEmail(copied)).toBe(false);
    expect(await stopEmail(copied)).toBe(false);
    expect(await stopEmail("A".repeat(43))).toBe(false);
    expect(await canStopEmail(first)).toBe(true);
    expect(await stopEmail(first)).toBe(true);
    // Asking twice is harmless.
    expect(await stopEmail(first)).toBe(true);

    expect((await rowFor(first)).OsmlsRecipientEmail).toBeNull();
    expect((await rowFor(second)).OsmlsRecipientEmail).toBeNull();
    expect((await rowFor(unrelated)).OsmlsRecipientEmail).toBe(address("someone-else"));
    // The address itself is nowhere in what is kept.
    const kept = JSON.stringify([await db.select().from(mailBlock), await db.select().from(share)]).toLowerCase();
    expect(kept.includes(client)).toBe(false);

    // No member can email it again, however the address is written.
    for (const by of [owner, other]) {
      for (const email of [client, ` ${client.toUpperCase()} `.trim()]) {
        await expect(createShare(by, target, { email })).rejects.toThrow("That address has asked not to receive email from this system.");
      }
    }
    // A refused send leaves no link behind.
    expect((await listShares(owner, target)).length).toBe(3);
    // Stopping email is not revoking: both links still open.
    expect(await getSharedPage(first)).not.toBeNull();
    expect(await getSharedPage(second)).not.toBeNull();
    // A stop request still works after the link has been revoked.
    const later = address("stop-after-revoke");
    const revoked = await link(target, owner, { email: later });
    await revokeShare(owner, (await rowFor(revoked)).ShareKey);
    expect(await stopEmail(revoked)).toBe(true);
    await expect(createShare(owner, target, { email: later })).rejects.toThrow("That address has asked not to receive email");
  });

  it("is deleted once the link has expired, and the link's record some time after it ended", async () => {
    const listing = await make();
    const target = { listing: listing.ListingKey };
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    const live = await link(target, owner, { email: address("live") });
    const expired = await link(target, owner, { email: address("expired") });
    const longExpired = await link(target, owner, { email: address("long-expired") });
    const longRevoked = await link(target, owner, { email: address("long-revoked") });
    const recentlyRevoked = await link(target, owner, { email: address("recently-revoked") });
    const at = async (token: string, values: Record<string, unknown>) =>
      db.update(share).set(values).where(eq(share.ShareKey, (await rowFor(token)).ShareKey));
    await at(expired, { ExpirationTimestamp: days(1) });
    await at(longExpired, { ExpirationTimestamp: days(SHARE_RECORD_RETENTION_DAYS + 1) });
    await at(longRevoked, { OsmlsRevokedTimestamp: days(SHARE_RECORD_RETENTION_DAYS + 1) });
    await at(recentlyRevoked, { OsmlsRevokedTimestamp: days(SHARE_RECORD_RETENTION_DAYS - 1) });

    await cleanUpShares();
    expect((await rowFor(live)).OsmlsRecipientEmail).toBe(address("live"));
    expect(await rowFor(expired)).toMatchObject({ OsmlsRecipientEmail: null });
    expect(await rowFor(longExpired)).toBeUndefined();
    expect(await rowFor(longRevoked)).toBeUndefined();
    expect(await rowFor(recentlyRevoked)).toBeDefined();
    expect(await getSharedPage(live)).not.toBeNull();
  });

  it("makes no link when the email cannot be sent", async () => {
    const listing = await make();
    const target = { listing: listing.ListingKey };
    const before = (await listShares(owner, target)).length;
    const real = process.env.SMTP_URL;
    // A port nothing listens on.
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    try {
      await expect(createShare(owner, target, { email: address("unsent") })).rejects.toThrow("The email could not be sent, so no link was made.");
    } finally {
      process.env.SMTP_URL = real;
    }
    expect((await listShares(owner, target)).length).toBe(before);
    // With email switched off altogether, an address is refused and a plain link still works.
    delete process.env.SMTP_URL;
    try {
      await expect(createShare(owner, target, { email: address("off") })).rejects.toThrow("Email is not set up on this system.");
      await expect(createShare(owner, target, {})).resolves.toBeTruthy();
    } finally {
      process.env.SMTP_URL = real;
    }
  });
});
