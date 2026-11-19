/*
 * Saved searches and collections against the test database: ownership on every
 * operation, limits, and what happens when requests overlap.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { collection, collectionListing, member, property, savedSearch, type Member } from "../src/db/schema";
import { createListing, searchListings, updateListing } from "../src/lib/listings";
import { MAX_COLLECTIONS_PER_MEMBER, MAX_LISTINGS_PER_COLLECTION, MAX_SAVED_SEARCHES_PER_MEMBER } from "../src/lib/rules/local";
import {
  addToCollection,
  collectionsForListing,
  createCollection,
  createSavedSearch,
  deleteCollection,
  deleteSavedSearch,
  getCollection,
  getSavedSearch,
  listCollections,
  listSavedSearches,
  openSavedSearch,
  removeFromCollection,
  renameCollection,
  renameSavedSearch,
  updateSavedSearchCriteria,
} from "../src/lib/saved-work";
import { DEFAULT_CRITERIA, criteriaToFilters, type SearchCriteria } from "../src/lib/search-criteria";

let owner: Member;
let who: Record<"sameOffice" | "otherOffice" | "staff" | "ownerSuspended" | "suspendedStaff", Member>;
const run = Date.now();
let serial = 0;
const name = (label: string) => `${label} ${run}-${++serial}`;
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const criteria = (changes: Partial<SearchCriteria> = {}): SearchCriteria => ({ ...DEFAULT_CRITERIA, city: "Port Alder", ...changes });

const listingFields = (changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
  StreetNumber: String(++serial), StreetName: `Saved Work St ${run}`, City: "Testville", StateOrProvince: "WA",
  PostalCode: "96555", BedroomsTotal: "3", BathroomsTotalInteger: "2", ...changes,
});

beforeAll(async () => {
  const members = await db.select().from(member);
  const byId = (id: string) => members.find((m) => m.MemberMlsId === id)!;
  owner = byId("AG1001");
  who = {
    sameOffice: byId("AG1002"),
    otherOffice: byId("AG2001"),
    staff: byId("ST0001"),
    // The owner's own account, as it would be seen once suspended.
    ownerSuspended: { ...byId("AG1001"), MemberStatus: "Inactive" },
    suspendedStaff: byId("ST0099"),
  };
});
afterAll(() => pool.end());

const others = () => Object.entries(who) as [keyof typeof who, Member][];
const everyoneElse = () => [...others(), ["signedOut", null] as const];

describe("saved searches belong to their creator", () => {
  it("lets the owner create, list, open, rename, update, and delete", async () => {
    const created = await createSavedSearch(owner, `  ${name("Mine")}  `, criteria({ statuses: ["Closed"], sort: "dom_high" }));
    expect(created.SavedSearchName).toMatch(/^Mine /);
    expect(created.SearchQueryHumanReadable).toBe("Closed · in Port Alder · sorted by days on market, most first");
    expect((await listSavedSearches(owner)).map((s) => s.SavedSearchKey)).toContain(created.SavedSearchKey);
    expect((await openSavedSearch(owner, created.SavedSearchKey))!.criteria).toMatchObject({ city: "Port Alder", statuses: ["Closed"], sort: "dom_high" });

    const renamed = await renameSavedSearch(owner, created.SavedSearchKey, name("Renamed"));
    expect(renamed.SavedSearchName).toMatch(/^Renamed /);
    const updated = await updateSavedSearchCriteria(owner, created.SavedSearchKey, criteria({ city: "Cedar Hollow" }));
    expect(updated.SearchQueryHumanReadable).toContain("Cedar Hollow");
    await deleteSavedSearch(owner, created.SavedSearchKey);
    expect(await getSavedSearch(owner, created.SavedSearchKey)).toBeNull();
  });

  it("refuses everyone else every operation, exactly as for a key that does not exist", async () => {
    const mine = await createSavedSearch(owner, name("Private search"), criteria());
    for (const [label, viewer] of everyoneElse()) {
      // Reading: nothing, the same as for a key never issued.
      expect(await getSavedSearch(viewer, mine.SavedSearchKey), label).toEqual(await getSavedSearch(viewer, NO_SUCH_KEY));
      expect(await openSavedSearch(viewer, mine.SavedSearchKey), label).toBeNull();
      expect((await listSavedSearches(viewer)).map((s) => s.SavedSearchKey), label).not.toContain(mine.SavedSearchKey);

      // Changing: the same refusal for theirs-not-yours as for does-not-exist.
      const attempts = (key: string) => [
        renameSavedSearch(viewer, key, name("Stolen")),
        updateSavedSearchCriteria(viewer, key, criteria({ city: "Elsewhere" })),
        deleteSavedSearch(viewer, key),
      ];
      const messages = async (key: string) =>
        Promise.all(attempts(key).map((p) => p.then(() => "allowed", (e: Error) => e.message)));
      expect(await messages(mine.SavedSearchKey), label).toEqual(["Not found.", "Not found.", "Not found."]);
      expect(await messages(mine.SavedSearchKey), label).toEqual(await messages(NO_SUCH_KEY));
    }
    // Untouched by all of that.
    const [after] = await db.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, mine.SavedSearchKey));
    expect(after).toMatchObject({ SavedSearchName: mine.SavedSearchName, OsmlsCriteria: mine.OsmlsCriteria });
  });

  it("gives a suspended owner nothing, and everything back unchanged on reinstatement", async () => {
    const mine = await createSavedSearch(owner, name("Survives suspension"), criteria());
    expect(await listSavedSearches(who.ownerSuspended)).toEqual([]);
    await expect(createSavedSearch(who.ownerSuspended, name("While suspended"), criteria())).rejects.toThrow("Not found.");
    expect(await getSavedSearch(owner, mine.SavedSearchKey)).toEqual(mine);
  });

  it("stores 'my listings' as a choice, so it cannot be used to search as someone else", async () => {
    const mine = await createSavedSearch(owner, name("My listings"), criteria({ city: undefined, mine: true, statuses: [] }));
    const stored = JSON.stringify(mine.OsmlsCriteria);
    expect(stored).not.toContain(owner.MemberKey);
    expect(stored).not.toContain("listAgentKey");

    const opened = (await openSavedSearch(owner, mine.SavedSearchKey))!;
    const asOwner = await searchListings(criteriaToFilters(opened.criteria, owner));
    expect(asOwner.rows.length).toBeGreaterThan(0);
    expect(asOwner.rows.every((r) => r.listing.ListAgentKey === owner.MemberKey)).toBe(true);
    // The same criteria in another member's hands mean that member's listings.
    const asOther = await searchListings(criteriaToFilters(opened.criteria, who.otherOffice));
    expect(asOther.rows.every((r) => r.listing.ListAgentKey === who.otherOffice.MemberKey)).toBe(true);

    // A member key smuggled into storage is dropped and never reaches the search.
    await db.execute(sql`update "SavedSearch" set "OsmlsCriteria" = "OsmlsCriteria" || ${JSON.stringify({ listAgentKey: who.otherOffice.MemberKey })}::jsonb where "SavedSearchKey" = ${mine.SavedSearchKey}`);
    const tampered = (await openSavedSearch(owner, mine.SavedSearchKey))!;
    expect(tampered.ignored).toEqual(["a criterion this version does not recognise"]);
    expect(criteriaToFilters(tampered.criteria, owner).listAgentKey).toBe(owner.MemberKey);
  });

  it("names the criteria it had to drop when a stored search is no longer valid", async () => {
    const mine = await createSavedSearch(owner, name("Aged"), criteria({ statuses: ["Active"] }));
    await db.execute(sql`update "SavedSearch" set "OsmlsCriteria" = ${JSON.stringify({ city: "Port Alder", statuses: ["Active", "Sold"], sort: "by_magic" })}::jsonb where "SavedSearchKey" = ${mine.SavedSearchKey}`);
    const opened = (await openSavedSearch(owner, mine.SavedSearchKey))!;
    expect(opened.ignored.sort()).toEqual(["one status", "sort order"]);
    expect(opened.criteria).toMatchObject({ city: "Port Alder", statuses: ["Active"], sort: "changed" });
  });

  it("runs a search, not an error, when stored criteria hold an inherited sort name or an impossible date", async () => {
    const mine = await createSavedSearch(owner, name("Poisoned"), criteria({ city: undefined, address: "Comparable Ct", statuses: ["Closed"] }));
    for (const poison of [{ sort: "constructor" }, { sort: "toString" }, { closedFrom: "2026-02-31" }, { closedTo: "2026-04-31" }]) {
      await db.execute(sql`update "SavedSearch" set "OsmlsCriteria" = ${JSON.stringify({ address: "Comparable Ct", statuses: ["Closed"], ...poison })}::jsonb where "SavedSearchKey" = ${mine.SavedSearchKey}`);
      const opened = (await openSavedSearch(owner, mine.SavedSearchKey))!;
      expect(opened.ignored, JSON.stringify(poison)).toHaveLength(1);
      const result = await searchListings(criteriaToFilters(opened.criteria, owner));
      expect(result.rows.length, JSON.stringify(poison)).toBe(8);
    }
  });

  it("ignores an inherited sort name or an impossible date handed straight to the search", async () => {
    const base = { address: "Comparable Ct", statuses: ["Closed" as const] };
    for (const filters of [{ sort: "constructor" }, { sort: "__proto__" }, { closedFrom: "2026-02-31" }, { closedTo: "2026-02-30" }])
      expect((await searchListings({ ...base, ...(filters as object) })).rows.length, JSON.stringify(filters)).toBe(8);
  });

  it("returns the same listings in the same order as the search done by hand", async () => {
    const asked = criteria({ city: undefined, address: "Comparable Ct", statuses: ["Closed"], sort: "dom_high" });
    const saved = await createSavedSearch(owner, name("Sold on the court"), asked);
    const asOf = new Date();
    const opened = (await openSavedSearch(owner, saved.SavedSearchKey))!;
    const byHand = await searchListings(criteriaToFilters(asked, owner), { asOf });
    const fromSaved = await searchListings(criteriaToFilters(opened.criteria, owner), { asOf });
    expect(fromSaved.rows.map((r) => r.listing.ListingKey)).toEqual(byHand.rows.map((r) => r.listing.ListingKey));
    expect(byHand.rows.length).toBeGreaterThan(3);
  });

  it("requires a name, unique for that member whatever the capitalisation", async () => {
    const base = name("Unique");
    await createSavedSearch(owner, base, criteria());
    await expect(createSavedSearch(owner, base.toUpperCase(), criteria())).rejects.toThrow("You already have one with that name.");
    await expect(createSavedSearch(owner, "   ", criteria())).rejects.toThrow("Give it a name.");
    await expect(createSavedSearch(owner, "x".repeat(81), criteria())).rejects.toThrow("That name is too long.");
    // Another member may use the same name.
    const theirs = await createSavedSearch(who.otherOffice, base, criteria());
    expect(theirs.MemberKey).toBe(who.otherOffice.MemberKey);
    const second = await createSavedSearch(owner, name("Second"), criteria());
    await expect(renameSavedSearch(owner, second.SavedSearchKey, base)).rejects.toThrow("You already have one with that name.");
  });

  it("is refused by the database without a name or an owner", async () => {
    const mine = await createSavedSearch(owner, name("Guarded"), criteria());
    const set = (assignment: string) => db.execute(sql.raw(`update "SavedSearch" set ${assignment} where "SavedSearchKey" = '${mine.SavedSearchKey}'`));
    await expect(set(`"SavedSearchName" = null`)).rejects.toBeTruthy();
    await expect(set(`"SavedSearchName" = '  '`)).rejects.toBeTruthy();
    await expect(set(`"MemberKey" = null`)).rejects.toBeTruthy();
    await expect(set(`"OsmlsCriteria" = null`)).rejects.toBeTruthy();
  });
});

describe("collections belong to their creator", () => {
  it("lets the owner create, add, list, remove, rename, and delete", async () => {
    const a = await createListing(owner, listingFields());
    const b = await createListing(owner, listingFields());
    const mine = await createCollection(owner, name("Shortlist"));
    expect(await addToCollection(owner, mine.CollectionKey, [a.ListingKey, b.ListingKey])).toEqual({ added: 2 });
    // Adding one that is already there changes nothing and is not an error.
    expect(await addToCollection(owner, mine.CollectionKey, [a.ListingKey, NO_SUCH_KEY, "junk"])).toEqual({ added: 0 });

    const opened = (await getCollection(owner, mine.CollectionKey))!;
    expect(opened.rows.map((r) => r.listing.ListingKey)).toEqual([a.ListingKey, b.ListingKey]);
    expect(opened.rows[0].marketTime).toMatchObject({ daysOnMarket: 0 });
    expect((await listCollections(owner)).find((c) => c.collection.CollectionKey === mine.CollectionKey)!.listingCount).toBe(2);
    expect((await collectionsForListing(owner, a.ListingKey)).find((c) => c.CollectionKey === mine.CollectionKey)!.contains).toBe(true);

    await removeFromCollection(owner, mine.CollectionKey, a.ListingKey);
    expect((await getCollection(owner, mine.CollectionKey))!.rows.map((r) => r.listing.ListingKey)).toEqual([b.ListingKey]);
    expect((await renameCollection(owner, mine.CollectionKey, name("Renamed list"))).CollectionName).toMatch(/^Renamed list/);

    await deleteCollection(owner, mine.CollectionKey);
    expect(await getCollection(owner, mine.CollectionKey)).toBeNull();
    // Its entries are gone; the listings are untouched.
    expect(await db.select().from(collectionListing).where(eq(collectionListing.CollectionKey, mine.CollectionKey))).toEqual([]);
    expect(await db.select().from(property).where(eq(property.ListingKey, b.ListingKey))).toHaveLength(1);
  });

  it("counts and marks each collection on its own, not by what other collections hold", async () => {
    const [a, b, c] = [await createListing(owner, listingFields()), await createListing(owner, listingFields()), await createListing(owner, listingFields())];
    const one = await createCollection(owner, name("Holds two"));
    const two = await createCollection(owner, name("Holds one"));
    const empty = await createCollection(owner, name("Holds none"));
    // Someone else's collection holds all three, which must make no difference here.
    const theirs = await createCollection(who.otherOffice, name("Someone else's"));
    await addToCollection(owner, one.CollectionKey, [a.ListingKey, b.ListingKey]);
    await addToCollection(owner, two.CollectionKey, [c.ListingKey]);
    await addToCollection(who.otherOffice, theirs.CollectionKey, [a.ListingKey, b.ListingKey, c.ListingKey]);

    const counts = Object.fromEntries((await listCollections(owner)).map((x) => [x.collection.CollectionKey, x.listingCount]));
    expect(counts[one.CollectionKey]).toBe(2);
    expect(counts[two.CollectionKey]).toBe(1);
    expect(counts[empty.CollectionKey]).toBe(0);

    const holding = async (listingKey: string) =>
      Object.fromEntries((await collectionsForListing(owner, listingKey)).map((x) => [x.CollectionKey, x.contains]));
    expect(await holding(a.ListingKey)).toMatchObject({ [one.CollectionKey]: true, [two.CollectionKey]: false, [empty.CollectionKey]: false });
    expect(await holding(c.ListingKey)).toMatchObject({ [one.CollectionKey]: false, [two.CollectionKey]: true, [empty.CollectionKey]: false });
    // And never anyone else's collection.
    expect(Object.keys(await holding(a.ListingKey))).not.toContain(theirs.CollectionKey);
  });

  it("refuses everyone else every operation, exactly as for a key that does not exist", async () => {
    const listing = await createListing(owner, listingFields());
    const mine = await createCollection(owner, name("Private list"));
    await addToCollection(owner, mine.CollectionKey, [listing.ListingKey]);

    for (const [label, viewer] of everyoneElse()) {
      expect(await getCollection(viewer, mine.CollectionKey), label).toEqual(await getCollection(viewer, NO_SUCH_KEY));
      expect((await listCollections(viewer)).map((c) => c.collection.CollectionKey), label).not.toContain(mine.CollectionKey);
      expect((await collectionsForListing(viewer, listing.ListingKey)).map((c) => c.CollectionKey), label).not.toContain(mine.CollectionKey);

      const attempts = (key: string) => [
        renameCollection(viewer, key, name("Stolen")),
        addToCollection(viewer, key, [listing.ListingKey]),
        removeFromCollection(viewer, key, listing.ListingKey),
        deleteCollection(viewer, key),
      ];
      const messages = async (key: string) =>
        Promise.all(attempts(key).map((p) => p.then(() => "allowed", (e: Error) => e.message)));
      expect(await messages(mine.CollectionKey), label).toEqual(["Not found.", "Not found.", "Not found.", "Not found."]);
      expect(await messages(mine.CollectionKey), label).toEqual(await messages(NO_SUCH_KEY));
    }
    const after = (await getCollection(owner, mine.CollectionKey))!;
    expect(after.collection.CollectionName).toBe(mine.CollectionName);
    expect(after.rows.map((r) => r.listing.ListingKey)).toEqual([listing.ListingKey]);
  });

  it("gives a suspended owner nothing, and everything back unchanged on reinstatement", async () => {
    const listing = await createListing(owner, listingFields());
    const mine = await createCollection(owner, name("Kept through suspension"));
    await addToCollection(owner, mine.CollectionKey, [listing.ListingKey]);
    expect(await listCollections(who.ownerSuspended)).toEqual([]);
    expect(await getCollection(who.ownerSuspended, mine.CollectionKey)).toBeNull();
    await expect(createCollection(who.ownerSuspended, name("While suspended"))).rejects.toThrow("Not found.");
    expect((await getCollection(owner, mine.CollectionKey))!.rows).toHaveLength(1);
  });

  it("shows each listing by the viewer's current permissions, never showing details", async () => {
    const secret = `collection-secret-${run}`;
    const fields = listingFields({ ShowingInstructions: secret, LockBoxLocation: secret, ShowingContactName: "Pat" });
    const listing = await createListing(owner, fields);
    // An agent in another office keeps it in a collection of their own.
    const theirs = await createCollection(who.otherOffice, name("Watching"));
    await addToCollection(who.otherOffice, theirs.CollectionKey, [listing.ListingKey]);

    const before = (await getCollection(who.otherOffice, theirs.CollectionKey))!;
    expect(before.rows[0].listing.StandardStatus).toBe("Active");
    expect(JSON.stringify(before)).not.toContain(secret);

    await updateListing(owner, listing.ListingKey, { ...fields, StandardStatus: "Pending" });
    await updateListing(owner, listing.ListingKey, { ...fields, StandardStatus: "Closed", ClosePrice: "490000", CloseDate: "2026-02-01" });
    const after = (await getCollection(who.otherOffice, theirs.CollectionKey))!;
    // The listing stays in the collection and shows as it is now.
    expect(after.rows[0].listing).toMatchObject({ StandardStatus: "Closed", ClosePrice: 490000 });
    expect(JSON.stringify(after)).not.toContain(secret);
    // Nor do the listing agent's own collections carry showing details.
    const own = await createCollection(owner, name("Own"));
    await addToCollection(owner, own.CollectionKey, [listing.ListingKey]);
    expect(JSON.stringify(await getCollection(owner, own.CollectionKey))).not.toContain(secret);
  });

  it("is refused by the database without a name, an owner, or with a duplicate entry", async () => {
    const listing = await createListing(owner, listingFields());
    const mine = await createCollection(owner, name("Guarded list"));
    await addToCollection(owner, mine.CollectionKey, [listing.ListingKey]);
    const set = (assignment: string) => db.execute(sql.raw(`update "OsmlsCollection" set ${assignment} where "CollectionKey" = '${mine.CollectionKey}'`));
    await expect(set(`"CollectionName" = null`)).rejects.toBeTruthy();
    await expect(set(`"CollectionName" = ' '`)).rejects.toBeTruthy();
    await expect(set(`"MemberKey" = null`)).rejects.toBeTruthy();
    await expect(db.insert(collectionListing).values({ CollectionKey: mine.CollectionKey, ListingKey: listing.ListingKey })).rejects.toBeTruthy();
  });
});

describe("limits", () => {
  // A member with no other saved work, so the counts are exact.
  let fresh: Member;
  beforeAll(async () => {
    fresh = (await db.select().from(member)).find((m) => m.MemberMlsId === "AG2003")!;
  });

  it("caps saved searches, including when the last two are created at once", async () => {
    for (let i = 0; i < MAX_SAVED_SEARCHES_PER_MEMBER - 1; i++) await createSavedSearch(fresh, name("Fill"), criteria());
    const results = await Promise.allSettled([
      createSavedSearch(fresh, name("Race A"), criteria()),
      createSavedSearch(fresh, name("Race B"), criteria()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("at most 50 saved searches");
    expect(await listSavedSearches(fresh)).toHaveLength(MAX_SAVED_SEARCHES_PER_MEMBER);
  });

  it("caps collections, including when the last two are created at once", async () => {
    for (let i = 0; i < MAX_COLLECTIONS_PER_MEMBER - 1; i++) await createCollection(fresh, name("Fill"));
    const results = await Promise.allSettled([createCollection(fresh, name("Race A")), createCollection(fresh, name("Race B"))]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await listCollections(fresh)).toHaveLength(MAX_COLLECTIONS_PER_MEMBER);
  });

  it("caps the listings in a collection, including when two adds would together pass it", async () => {
    const mine = await createCollection(owner, name("Full"));
    const needed = MAX_LISTINGS_PER_COLLECTION + 2;
    const [{ have }] = (await db.execute(sql`select count(*)::int as have from "Property"`)).rows as { have: number }[];
    for (let i = have; i < needed; i++) await createListing(owner, listingFields());
    const keys = (await db.select({ k: property.ListingKey }).from(property).limit(needed)).map((r) => r.k);
    expect(keys).toHaveLength(needed);
    await addToCollection(owner, mine.CollectionKey, keys.slice(0, MAX_LISTINGS_PER_COLLECTION - 1));
    const results = await Promise.allSettled([
      addToCollection(owner, mine.CollectionKey, [keys[MAX_LISTINGS_PER_COLLECTION]]),
      addToCollection(owner, mine.CollectionKey, [keys[MAX_LISTINGS_PER_COLLECTION + 1]]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await getCollection(owner, mine.CollectionKey))!.rows).toHaveLength(MAX_LISTINGS_PER_COLLECTION);
    // A single request that would overflow adds nothing at all.
    const other = await createCollection(owner, name("Too many at once"));
    await expect(addToCollection(owner, other.CollectionKey, keys.slice(0, MAX_LISTINGS_PER_COLLECTION + 1))).rejects.toThrow("at most 200 listings");
    expect((await getCollection(owner, other.CollectionKey))!.rows).toHaveLength(0);
  });
});

describe("overlapping requests", () => {
  it("adds a listing once when two requests add it at the same moment", async () => {
    const listing = await createListing(owner, listingFields());
    const mine = await createCollection(owner, name("Twice"));
    const results = await Promise.all([
      addToCollection(owner, mine.CollectionKey, [listing.ListingKey]),
      addToCollection(owner, mine.CollectionKey, [listing.ListingKey]),
    ]);
    expect(results.map((r) => r.added).sort()).toEqual([0, 1]);
    expect((await getCollection(owner, mine.CollectionKey))!.rows).toHaveLength(1);
  });

  it("leaves nothing behind when an add overlaps the collection's deletion", async () => {
    for (let round = 0; round < 5; round++) {
      const listing = await createListing(owner, listingFields());
      const mine = await createCollection(owner, name("Going"));
      const [added, deleted] = await Promise.allSettled([
        addToCollection(owner, mine.CollectionKey, [listing.ListingKey]),
        deleteCollection(owner, mine.CollectionKey),
      ]);
      expect(deleted.status).toBe("fulfilled");
      if (added.status === "rejected") expect(String(added.reason)).toContain("Not found.");
      expect(await db.select().from(collection).where(eq(collection.CollectionKey, mine.CollectionKey))).toEqual([]);
      expect(await db.select().from(collectionListing).where(eq(collectionListing.CollectionKey, mine.CollectionKey))).toEqual([]);
    }
  });

  it("lets only one of two renames to the same name succeed", async () => {
    const [a, b] = [await createCollection(owner, name("First")), await createCollection(owner, name("Second"))];
    const target = name("Contested");
    const results = await Promise.allSettled([
      renameCollection(owner, a.CollectionKey, target),
      renameCollection(owner, b.CollectionKey, target.toUpperCase()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("already have one with that name");

    const [s1, s2] = [await createSavedSearch(owner, name("First"), criteria()), await createSavedSearch(owner, name("Second"), criteria())];
    const searchTarget = name("Contested search");
    const searchResults = await Promise.allSettled([
      renameSavedSearch(owner, s1.SavedSearchKey, searchTarget),
      renameSavedSearch(owner, s2.SavedSearchKey, searchTarget),
    ]);
    expect(searchResults.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("gives a clear answer when an update overlaps a deletion", async () => {
    const mine = await createSavedSearch(owner, name("Vanishing"), criteria());
    const [updated, deleted] = await Promise.allSettled([
      updateSavedSearchCriteria(owner, mine.SavedSearchKey, criteria({ city: "Cedar Hollow" })),
      deleteSavedSearch(owner, mine.SavedSearchKey),
    ]);
    expect(deleted.status).toBe("fulfilled");
    if (updated.status === "rejected") expect(String(updated.reason)).toContain("Not found.");
    expect(await getSavedSearch(owner, mine.SavedSearchKey)).toBeNull();
  });
});
