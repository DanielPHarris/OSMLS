/*
 * Runs against the test database, which `pnpm test` creates and seeds. Needs the
 * PostgreSQL server (docker compose up -d db). Each test creates its own listing.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { historyTransactional, member, property } from "../src/db/schema";
import { ListingError, createListing, searchListings, updateListing, type Actor } from "../src/lib/listings";

let listingAgent: Actor;
let otherAgent: Actor;
let staff: Actor;

const input = (changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active",
  PropertyType: "Residential",
  ListPrice: "500000",
  ListingContractDate: "2026-01-15",
  StreetNumber: "77",
  StreetName: "Integration Test Way",
  City: "Testville",
  StateOrProvince: "WA",
  PostalCode: "98999",
  BedroomsTotal: "3",
  BathroomsTotalInteger: "2",
  ...changes,
});

const historyFor = (key: string) =>
  db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, key));

beforeAll(async () => {
  const members = await db.select().from(member);
  const byId = (id: string) => {
    const m = members.find((x) => x.MemberMlsId === id);
    if (!m) throw new Error(`Seed data missing member ${id}. Run pnpm test:db.`);
    return m;
  };
  listingAgent = byId("AG1001");
  otherAgent = byId("AG2001");
  staff = byId("ST0001");
});

afterAll(() => pool.end());

describe("listing changes and their history", () => {
  it("records a new listing", async () => {
    const created = await createListing(listingAgent, input());
    expect(created.ListingId).toMatch(/^OS\d+$/);
    expect(created.OriginalListPrice).toBe(500000);
    expect(created.OnMarketDate).not.toBeNull();
    const history = await historyFor(created.ListingKey);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      ChangeType: "New Listing",
      NewValue: "Active",
      ChangedByMemberID: "AG1001",
      OsmlsStaffCorrection: false,
    });
  });

  it("records one row per changed field, with old and new values", async () => {
    const created = await createListing(listingAgent, input());
    const { listing, changedFields } = await updateListing(
      listingAgent,
      created.ListingKey,
      input({ ListPrice: "485000", BedroomsTotal: "4", StandardStatus: "Pending" }),
    );
    expect(changedFields.sort()).toEqual(["BedroomsTotal", "ListPrice", "StandardStatus"]);
    expect(listing.PriceChangeTimestamp).not.toBeNull();
    expect(listing.OriginalListPrice).toBe(500000);

    const rows = (await historyFor(created.ListingKey)).filter((r) => r.ChangeType !== "New Listing");
    const price = rows.find((r) => r.FieldName === "ListPrice");
    expect(price).toMatchObject({ PreviousValue: "500000", NewValue: "485000", ChangeType: "Price Change" });
    expect(rows.find((r) => r.FieldName === "StandardStatus")).toMatchObject({ PreviousValue: "Active", NewValue: "Pending" });
    expect(rows).toHaveLength(3);
  });

  it("writes nothing when nothing changed", async () => {
    const created = await createListing(listingAgent, input());
    const { changedFields } = await updateListing(listingAgent, created.ListingKey, input());
    expect(changedFields).toEqual([]);
    expect(await historyFor(created.ListingKey)).toHaveLength(1);
  });

  it("refuses a status change that is not permitted, and changes nothing", async () => {
    const created = await createListing(listingAgent, input());
    await expect(
      updateListing(listingAgent, created.ListingKey, input({ StandardStatus: "Closed", ClosePrice: "490000", CloseDate: "2026-02-01", ListPrice: "1" })),
    ).rejects.toThrow(ListingError);
    const [after] = await db.select().from(property).where(eq(property.ListingKey, created.ListingKey));
    expect(after.StandardStatus).toBe("Active");
    expect(after.ListPrice).toBe(500000);
    expect(await historyFor(created.ListingKey)).toHaveLength(1);
  });

  it("refuses edits from an agent who is not the listing agent", async () => {
    const created = await createListing(listingAgent, input());
    await expect(updateListing(otherAgent, created.ListingKey, input({ ListPrice: "1000" }))).rejects.toThrow(
      /listing agent or MLS staff/,
    );
  });

  it("locks closed listings for the agent but lets staff correct them with a reason", async () => {
    const created = await createListing(listingAgent, input());
    await updateListing(listingAgent, created.ListingKey, input({ StandardStatus: "Pending" }));
    const closed = input({ StandardStatus: "Closed", ClosePrice: "490000", CloseDate: "2026-02-01" });
    await updateListing(listingAgent, created.ListingKey, closed);

    await expect(updateListing(listingAgent, created.ListingKey, { ...closed, ClosePrice: "495000" })).rejects.toThrow(
      /only be changed by MLS staff/,
    );
    await expect(updateListing(staff, created.ListingKey, { ...closed, ClosePrice: "495000" }, "  ")).rejects.toThrow(
      /needs a reason/,
    );

    await updateListing(staff, created.ListingKey, { ...closed, ClosePrice: "495000" }, "Close price mistyped by agent.");
    const correction = (await historyFor(created.ListingKey)).find((r) => r.OsmlsStaffCorrection);
    expect(correction).toMatchObject({
      FieldName: "ClosePrice",
      PreviousValue: "490000",
      NewValue: "495000",
      ChangedByMemberID: "ST0001",
      OsmlsCorrectionReason: "Close price mistyped by agent.",
    });
  });

  it("does not let staff or agents without an office enter listings", async () => {
    await expect(createListing(staff, input())).rejects.toThrow(/Only agents/);
  });

  it("keeps history rows from being changed or deleted", async () => {
    const created = await createListing(listingAgent, input());
    const where = eq(historyTransactional.ResourceRecordKey, created.ListingKey);
    // The database error is wrapped; the trigger's message is on the cause.
    const refusal = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) };
    await expect(db.update(historyTransactional).set({ NewValue: "tampered" }).where(where)).rejects.toMatchObject(refusal);
    await expect(db.delete(historyTransactional).where(where)).rejects.toMatchObject(refusal);
    expect((await historyFor(created.ListingKey))[0].NewValue).toBe("Active");
  });

  it("enforces required values in the database itself", async () => {
    const created = await createListing(listingAgent, input());
    await expect(
      db.execute(sql`update "Property" set "StandardStatus" = 'Sold' where "ListingKey" = ${created.ListingKey}`),
    ).rejects.toBeTruthy();
    await expect(
      db.execute(sql`update "Property" set "ListPrice" = 0 where "ListingKey" = ${created.ListingKey}`),
    ).rejects.toBeTruthy();
  });
});

describe("search", () => {
  it("finds a listing by number, by address, and by combined filters", async () => {
    const created = await createListing(listingAgent, input({ StreetName: "Searchable Quartz Ln", ListPrice: "612345", BedroomsTotal: "5" }));
    const keys = async (filters: Parameters<typeof searchListings>[0]) =>
      (await searchListings(filters)).rows.map((r) => r.listing.ListingKey);

    expect(await keys({ listingId: created.ListingId.toLowerCase() })).toEqual([created.ListingKey]);
    expect(await keys({ address: "quartz" })).toContain(created.ListingKey);
    expect(await keys({ city: "testville", postalCode: "98999", minPrice: 612345, maxPrice: 612345, minBeds: 5, statuses: ["Active"] })).toContain(created.ListingKey);
    expect(await keys({ address: "quartz", statuses: ["Pending"] })).not.toContain(created.ListingKey);
    expect(await keys({ address: "quartz", minBeds: 6 })).not.toContain(created.ListingKey);
    expect(await keys({ address: "100%_match" })).toEqual([]);
  });
});
