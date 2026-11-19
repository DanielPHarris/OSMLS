/*
 * Saved-search activity against the test database: a checkpoint that cannot
 * skip a change, what counts as an event, when activity becomes seen, limits,
 * and who may read or clear it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { member, savedSearch, type Member, type Property } from "../src/db/schema";
import { countActivity, getActivity, markActivitySeen, toActivityEvent, type Activity } from "../src/lib/activity";
import { createListing, updateListing } from "../src/lib/listings";
import { MAX_ACTIVITY_EVENTS_PER_LISTING, MAX_ACTIVITY_LISTINGS } from "../src/lib/rules/local";
import { createSavedSearch, renameSavedSearch, updateSavedSearchCriteria } from "../src/lib/saved-work";
import { DEFAULT_CRITERIA, type SearchCriteria } from "../src/lib/search-criteria";

const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const REASON_MARK = `reason-mark-${run}`;
let owner: Member;
let who: Record<"sameOffice" | "otherOffice" | "staff" | "ownerSuspended" | "suspendedStaff", Member>;
let serial = 0;

/** Each group of tests works in a town of its own, so their listings never mix. */
const town = (label: string) => `${label}${run}`;
const fields = (city: string, changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
  StreetNumber: String(++serial), StreetName: "Activity Ave", City: city, StateOrProvince: "WA", PostalCode: "96559",
  BedroomsTotal: "3", BathroomsTotalInteger: "2", ...changes,
});
const make = (city: string, changes: Record<string, unknown> = {}) => createListing(owner, fields(city, changes));
/** Changes a listing, keeping everything else as it was entered. */
const change = (listing: Property, changes: Record<string, unknown>, by: Member = owner, reason?: string) =>
  updateListing(
    by,
    listing.ListingKey,
    { ...fields(listing.City), StreetNumber: listing.StreetNumber, ListPrice: String(listing.ListPrice), ...changes },
    reason,
  );
const save = (city: string, criteria: Partial<SearchCriteria> = {}) =>
  createSavedSearch(owner, `Activity ${city} ${++serial}`, { ...DEFAULT_CRITERIA, city, statuses: [], ...criteria });
const read = async (key: string, viewer: Member | null = owner) => (await getActivity(viewer, key))!;
const ids = (listings: Activity["matching"]) => listings.map((l) => l.ListingId);
const eventsOf = (activity: Activity, listing: Property) =>
  [...activity.matching, ...activity.mayNoLongerMatch]
    .find((l) => l.ListingKey === listing.ListingKey)
    ?.events.map((e) => `${e.kind}: ${e.previous ?? ""} → ${e.next ?? ""}`) ?? null;
const checkpoint = async (key: string) =>
  (await db.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key)))[0].OsmlsActivitySeenThrough;

/** These tests' saved searches, removed so repeated runs never reach the member's limit. */
const forget = () => db.delete(savedSearch).where(like(savedSearch.SavedSearchName, "Activity %"));

beforeAll(async () => {
  const members = await db.select().from(member);
  const byId = (id: string) => members.find((m) => m.MemberMlsId === id)!;
  owner = byId("AG1001");
  who = {
    sameOffice: byId("AG1002"),
    otherOffice: byId("AG2001"),
    staff: byId("ST0001"),
    ownerSuspended: { ...byId("AG1001"), MemberStatus: "Inactive" },
    suspendedStaff: byId("ST0099"),
  };
  await forget();
});
afterAll(async () => {
  await forget();
  await pool.end();
});

describe("the checkpoint cannot skip a change", () => {
  /** A price change written the way updateListing writes one, in a transaction left open. */
  async function openChange(listing: Property, price: number) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("begin");
    await client.query(`update "Property" set "ListPrice" = $2 where "ListingKey" = $1`, [listing.ListingKey, price]);
    await client.query(
      `insert into "HistoryTransactional" ("ResourceRecordKey", "ResourceRecordID", "ClassName", "FieldName",
         "PreviousValue", "NewValue", "ChangeType", "ChangedByMemberKey", "ChangedByMemberID")
       values ($1, $2, 'Residential', 'ListPrice', $3, $4, 'Price Change', $5, $6)`,
      [listing.ListingKey, listing.ListingId, String(listing.ListPrice), String(price), owner.MemberKey, owner.MemberMlsId],
    );
    return {
      commit: async () => {
        await client.query("commit");
        await client.end();
      },
    };
  }

  it("keeps a change unseen when it is committed after the activity that was marked seen was loaded", async () => {
    const city = town("Late");
    const early = await make(city);
    const other = await make(city);
    const { SavedSearchKey: key } = await save(city);
    expect((await read(key)).matching).toEqual([]);

    // 1. A change to a matching listing is written but not yet committed.
    const late = await openChange(early, 480000);
    // Meanwhile a change to another matching listing is made the ordinary way.
    const second = change(other, { ListPrice: "510000" });
    await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 300))]);

    // 2. Activity is loaded.
    const loaded = await read(key);
    expect(eventsOf(loaded, early)).toBeNull();
    // 3. The change is committed.
    await late.commit();
    await second;
    // 4. What was loaded is marked as seen.
    await markActivitySeen(owner, key, loaded.through);
    // 5. The late change is still unseen, and nothing was lost between the two readings.
    const after = await read(key);
    expect(eventsOf(after, early)).toEqual(["price: 500000 → 480000"]);
    expect(eventsOf(loaded, other) ?? eventsOf(after, other)).toEqual(["price: 500000 → 510000"]);
  });

  it("keeps a listing that starts matching while a reading is open", async () => {
    // The search wants at most $450,000; the listing is at $500,000 and does not match.
    const city = town("Starts");
    const listing = await make(city);
    const { SavedSearchKey: key } = await save(city, { maxPrice: 450000 });
    const entering = await openChange(listing, 440000);
    const loaded = await read(key);
    expect(loaded.matching).toEqual([]);
    await entering.commit();
    await markActivitySeen(owner, key, loaded.through);
    const after = await read(key);
    expect(eventsOf(after, listing)).toEqual(["price: 500000 → 440000"]);
  });

  it("never loses a change that lands while activity is being read and marked seen", async () => {
    // Readings, marks, and changes that bring a listing into the search, all at once.
    const city = town("Race");
    const { SavedSearchKey: key } = await save(city, { maxPrice: 450000 });
    const listings: Property[] = [];
    for (let i = 0; i < 24; i++) listings.push(await make(city));
    const shown = new Set<string>();
    const readAndMark = async () => {
      const loaded = await read(key);
      for (const l of loaded.matching) shown.add(l.ListingKey);
      await markActivitySeen(owner, key, loaded.through);
    };
    await Promise.all(listings.flatMap((listing) => [change(listing, { ListPrice: "440000" }), readAndMark()]));
    for (const l of (await read(key)).matching) shown.add(l.ListingKey);
    // Every listing was shown in some reading before its change could be marked seen.
    expect(listings.filter((l) => !shown.has(l.ListingKey)).map((l) => l.ListingId)).toEqual([]);
  });
});

describe("what counts as activity", () => {
  it("shows new listings, status changes, and list price changes, and nothing else", async () => {
    const city = town("Events");
    const priced = await make(city);
    const sold = await make(city);
    const quiet = await make(city);
    const { SavedSearchKey: key } = await save(city);
    expect((await read(key)).matching).toEqual([]);

    const entered = await make(city);
    await change(priced, { ListPrice: "490000" });
    await change(sold, { StandardStatus: "Pending" });
    await change(sold, { StandardStatus: "Closed", ClosePrice: "495000", CloseDate: "2026-03-03" });
    // Not events: remarks, beds, and the address.
    await change(quiet, { PublicRemarks: "New remarks.", BedroomsTotal: "4", StreetName: "Quiet Ct" });

    const activity = await read(key);
    expect(eventsOf(activity, entered)).toEqual(["new:  → Active"]);
    expect(eventsOf(activity, priced)).toEqual(["price: 500000 → 490000"]);
    expect(eventsOf(activity, sold)).toEqual(["status: Active → Pending", "status: Pending → Closed"]);
    expect(eventsOf(activity, quiet)).toBeNull();
    // Most recently changed first.
    expect(ids(activity.matching)).toEqual([sold.ListingId, priced.ListingId, entered.ListingId]);
    const closed = activity.matching[0];
    expect([closed.StandardStatus, closed.ClosePrice, closed.CloseDate]).toEqual(["Closed", 495000, "2026-03-03"]);
    expect(activity.mayNoLongerMatch).toEqual([]);
  });

  it("gives a member the change and its time, never who made it or why", async () => {
    const city = town("Projection");
    const listing = await make(city);
    const { SavedSearchKey: key } = await save(city);
    await change(listing, { ListPrice: "470000" }, who.staff, REASON_MARK);

    const activity = await read(key);
    expect(eventsOf(activity, listing)).toEqual(["price: 500000 → 470000"]);
    expect(Object.keys(activity.matching[0].events[0]).sort()).toEqual(["at", "kind", "next", "previous"]);
    const sent = JSON.stringify({ matching: activity.matching, mayNoLongerMatch: activity.mayNoLongerMatch });
    for (const hidden of [REASON_MARK, who.staff.MemberKey, who.staff.MemberMlsId, who.staff.MemberFullName, "Correction", "ChangedBy"]) {
      expect(sent, hidden).not.toContain(hidden);
    }
    // The projection itself, given a whole history row.
    const event = toActivityEvent({
      FieldName: "ListPrice", ChangeType: "Price Change", PreviousValue: "1", NewValue: "2", ModificationTimestamp: new Date(0),
      ...({ ChangedByMemberID: "X", OsmlsCorrectionReason: "Y", OsmlsStaffCorrection: true } as object),
    });
    expect(event).toEqual({ kind: "price", previous: "1", next: "2", at: new Date(0) });
  });
});

describe("listings that may no longer match", () => {
  it("reports a status or price change that takes a listing out of the search, apart from the matches", async () => {
    const city = town("Leaves");
    const pending = await make(city);
    const raised = await make(city);
    const stays = await make(city);
    const { SavedSearchKey: key } = await save(city, { statuses: ["Active"], maxPrice: 600000 });

    await change(pending, { StandardStatus: "Pending" });
    await change(raised, { ListPrice: "700000" });
    await change(stays, { ListPrice: "550000" });

    const activity = await read(key);
    expect(ids(activity.matching)).toEqual([stays.ListingId]);
    expect(ids(activity.mayNoLongerMatch)).toEqual([raised.ListingId, pending.ListingId]);
    expect(eventsOf(activity, pending)).toEqual(["status: Active → Pending"]);
    expect(eventsOf(activity, raised)).toEqual(["price: 500000 → 700000"]);
    expect((await countActivity(owner)).get(key)).toEqual({ listings: 3, more: false });
  });

  it("uses only status and list price from history: other criteria are the listing's current values", async () => {
    const city = town("Limits");
    const { SavedSearchKey: key } = await save(city, { statuses: ["Active"], minBeds: 3, maxPrice: 600000 });
    // Left the search because its bedrooms were corrected: not an event, so not reported.
    const fewerBeds = await make(city);
    // Matched, then lost a bedroom and went pending: by its current bedrooms it never matched.
    const both = await make(city);
    // Entered after the checkpoint and then priced out of the search: it was not there to match at the checkpoint.
    const entered = await make(city);
    await change(fewerBeds, { BedroomsTotal: "2" });
    await change(both, { BedroomsTotal: "2" });
    await change(both, { BedroomsTotal: "2", StandardStatus: "Pending" });
    await change(entered, { ListPrice: "700000" });

    const activity = await read(key);
    expect(ids(activity.matching)).toEqual([]);
    expect(ids(activity.mayNoLongerMatch)).toEqual([]);
  });
});

describe("since you last looked", () => {
  it("starts a new saved search with no activity, whatever happened before it was saved", async () => {
    const city = town("First");
    const listing = await make(city);
    await change(listing, { ListPrice: "480000" });
    const { SavedSearchKey: key } = await save(city);
    expect((await read(key)).matching).toEqual([]);
    expect((await countActivity(owner)).get(key)).toEqual({ listings: 0, more: false });
  });

  it("starts again when the criteria change, and not when the name does", async () => {
    const city = town("Reset");
    const listing = await make(city);
    const saved = await save(city);
    const key = saved.SavedSearchKey;
    await change(listing, { ListPrice: "480000" });

    await renameSavedSearch(owner, key, `Activity renamed ${run} ${++serial}`);
    expect(ids((await read(key)).matching)).toEqual([listing.ListingId]);
    expect(await checkpoint(key)).toBe(saved.OsmlsActivitySeenThrough);

    const updated = await updateSavedSearchCriteria(owner, key, { ...DEFAULT_CRITERIA, city, statuses: [], maxPrice: 900000 });
    expect(updated.OsmlsActivitySeenThrough).toBeGreaterThan(saved.OsmlsActivitySeenThrough);
    expect(updated.OsmlsActivitySeenAt.getTime()).toBeGreaterThanOrEqual(saved.OsmlsActivitySeenAt.getTime());
    expect((await read(key)).matching).toEqual([]);
    await change(listing, { ListPrice: "470000" });
    expect(eventsOf(await read(key), listing)).toEqual(["price: 480000 → 470000"]);
  });

  it("starts saved searches that already exist from the moment the change is installed", async () => {
    // A scratch database taken to the migration before this one, given a saved search and some history.
    const name = `osmls_install_check_${run}`;
    const adminUrl = new URL(process.env.DATABASE_URL!);
    adminUrl.pathname = "/postgres";
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const scratchUrl = new URL(process.env.DATABASE_URL!);
    scratchUrl.pathname = `/${name}`;
    const scratch = new Client({ connectionString: scratchUrl.toString() });
    await scratch.connect();
    try {
      const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort();
      const apply = async (file: string) => {
        for (const statement of readFileSync(`drizzle/${file}`, "utf8").split("--> statement-breakpoint")) await scratch.query(statement);
      };
      for (const file of files.filter((f) => f < "0008")) await apply(file);
      await scratch.query(`insert into "user" (id, name, email) values ('u1', 'A', 'a@example.test')`);
      const { rows: [m] } = await scratch.query(
        `insert into "Member" ("MemberMlsId", "MemberFirstName", "MemberLastName", "MemberFullName", "MemberEmail", "OsmlsRole", "OsmlsUserId")
         values ('S1', 'A', 'B', 'A B', 'a@example.test', 'staff', 'u1') returning "MemberKey"`,
      );
      for (let i = 0; i < 3; i++) {
        await scratch.query(
          `insert into "HistoryTransactional" ("ResourceRecordKey", "ResourceRecordID", "ClassName", "FieldName", "ChangedByMemberKey", "ChangedByMemberID")
           values (gen_random_uuid(), 'X', 'Residential', 'ListPrice', $1, 'S1')`,
          [m.MemberKey],
        );
      }
      await scratch.query(
        `insert into "SavedSearch" ("MemberKey", "SavedSearchName", "OsmlsCriteria", "SearchQueryHumanReadable") values ($1, 'Old', '{}', 'Old')`,
        [m.MemberKey],
      );
      await apply(files.find((f) => f.startsWith("0008"))!);
      const { rows: [after] } = await scratch.query(
        `select "OsmlsActivitySeenThrough"::int as seen, (select max("OsmlsSequence") from "HistoryTransactional")::int as latest from "SavedSearch"`,
      );
      expect(after.latest).toBe(3);
      expect(after.seen).toBe(3);
    } finally {
      await scratch.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    }
  });
});

describe("when activity becomes seen", () => {
  it("is unchanged by reading it or counting it, any number of times", async () => {
    const city = town("Reading");
    const listing = await make(city);
    const { SavedSearchKey: key } = await save(city);
    await change(listing, { ListPrice: "480000" });
    const before = await checkpoint(key);
    for (let i = 0; i < 3; i++) {
      expect(ids((await read(key)).matching)).toEqual([listing.ListingId]);
      expect((await countActivity(owner)).get(key)).toEqual({ listings: 1, more: false });
    }
    expect(await checkpoint(key)).toBe(before);
  });

  it("clears what was loaded and leaves what arrived afterwards", async () => {
    const city = town("Marking");
    const first = await make(city);
    const second = await make(city);
    const { SavedSearchKey: key } = await save(city);
    await change(first, { ListPrice: "480000" });
    const loaded = await read(key);
    await change(second, { ListPrice: "470000" });
    await change(first, { ListPrice: "460000" });

    await markActivitySeen(owner, key, loaded.through);
    const after = await read(key);
    expect(eventsOf(after, first)).toEqual(["price: 480000 → 460000"]);
    expect(eventsOf(after, second)).toEqual(["price: 500000 → 470000"]);
  });

  it("only ever moves forward, and never past the newest history there is", async () => {
    const city = town("Forward");
    const listing = await make(city);
    const { SavedSearchKey: key } = await save(city);
    await change(listing, { ListPrice: "480000" });
    const early = await read(key);
    await change(listing, { ListPrice: "470000" });
    const late = await read(key);

    // Two tabs: the newer reading and the older one are marked at the same moment.
    await Promise.all([markActivitySeen(owner, key, late.through), markActivitySeen(owner, key, early.through)]);
    expect(await checkpoint(key)).toBe(late.through);
    await markActivitySeen(owner, key, early.through);
    await markActivitySeen(owner, key, 0);
    expect(await checkpoint(key)).toBe(late.through);

    // A number from the future cannot hide what has not happened yet.
    await markActivitySeen(owner, key, Number.MAX_SAFE_INTEGER);
    await change(listing, { ListPrice: "465000" });
    expect(eventsOf(await read(key), listing)).toEqual(["price: 470000 → 465000"]);
    for (const bad of [-1, 1.5, Number.NaN, "12", null, undefined]) {
      await expect(markActivitySeen(owner, key, bad), String(bad)).rejects.toThrow("Reload the page and try again.");
    }
  });
});

describe("limits", () => {
  it("shows the most recent events of a listing and counts the earlier ones it leaves out", async () => {
    const city = town("Many");
    const listing = await make(city);
    const { SavedSearchKey: key } = await save(city);
    for (let i = 1; i <= MAX_ACTIVITY_EVENTS_PER_LISTING + 1; i++) await change(listing, { ListPrice: String(500000 - i * 1000) });
    const [shown] = (await read(key)).matching;
    expect(shown.events).toHaveLength(MAX_ACTIVITY_EVENTS_PER_LISTING);
    expect(shown.omittedEvents).toBe(1);
    // The one left out is the oldest.
    expect(shown.events[0].previous).toBe("499000");
    expect(shown.events.at(-1)!.next).toBe(String(500000 - (MAX_ACTIVITY_EVENTS_PER_LISTING + 1) * 1000));
  });

  it("shows up to the limit of listings and says there are more without counting them", async () => {
    const city = town("Crowd");
    const { SavedSearchKey: key } = await save(city);
    const made: Property[] = [];
    for (let i = 0; i < MAX_ACTIVITY_LISTINGS + 1; i++) made.push(await make(city));
    const activity = await read(key);
    expect(activity.matching).toHaveLength(MAX_ACTIVITY_LISTINGS);
    expect(activity.moreListings).toBe(true);
    // Newest first, so the one not shown is the first one entered.
    expect(ids(activity.matching)).not.toContain(made[0].ListingId);
    expect(activity.matching[0].ListingId).toBe(made.at(-1)!.ListingId);
    expect((await countActivity(owner)).get(key)).toEqual({ listings: MAX_ACTIVITY_LISTINGS, more: true });

    // Marking as seen clears all of it, the one not shown included.
    await markActivitySeen(owner, key, activity.through);
    const after = await read(key);
    expect([after.matching.length, after.moreListings]).toEqual([0, false]);
  }, 60_000);
});

describe("activity belongs to the saved search's owner", () => {
  it("refuses everyone else to read it or clear it, exactly as for a key that does not exist", async () => {
    const city = town("Private");
    const listing = await make(city);
    const { SavedSearchKey: key } = await save(city);
    await change(listing, { ListPrice: "480000" });
    const loaded = await read(key);
    const before = await checkpoint(key);

    for (const [label, viewer] of [...Object.entries(who), ["signedOut", null]] as [string, Member | null][]) {
      expect(await getActivity(viewer, key), label).toBeNull();
      expect(await getActivity(viewer, NO_SUCH_KEY), label).toBeNull();
      await expect(markActivitySeen(viewer, key, loaded.through), label).rejects.toThrow("Not found.");
      await expect(markActivitySeen(viewer, NO_SUCH_KEY, loaded.through), label).rejects.toThrow("Not found.");
      expect((await countActivity(viewer)).has(key), label).toBe(false);
    }
    expect(await getActivity(owner, "not-a-key")).toBeNull();
    expect(await checkpoint(key)).toBe(before);
    expect(ids((await read(key)).matching)).toEqual([listing.ListingId]);
  });

  it("is read as the member is now: 'only my listings' means the member asking", async () => {
    const city = town("Mine");
    const mine = await make(city);
    const { SavedSearchKey: key } = await save(city, { mine: true });
    const theirs = await createListing(who.otherOffice, fields(city));
    await change(mine, { ListPrice: "480000" });
    const activity = await read(key);
    expect(ids(activity.matching)).toEqual([mine.ListingId]);
    expect(JSON.stringify(activity)).not.toContain(theirs.ListingId);
  });
});
