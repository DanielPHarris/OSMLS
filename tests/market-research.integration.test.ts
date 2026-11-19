/*
 * Sold search, the member timeline, and comparables, against the test database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { member, type Member } from "../src/db/schema";
import { addDocument } from "../src/lib/documents";
import { createListing, getListing, searchListings, updateListing } from "../src/lib/listings";
import { defaultComparableCriteria, findComparables, getMarketTimeline, summarizeComparables } from "../src/lib/market-research";
import { STANDARD_STATUSES } from "../src/lib/lookups";

let agent: Member;
let staff: Member;
const on = (date: string) => new Date(`${date}T21:00:00Z`);
const AS_OF = on("2026-06-30");
const run = Date.now();
let serial = 0;

const fields = (changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active",
  PropertyType: "Residential",
  ListPrice: "600000",
  ListingContractDate: "2026-01-01",
  StreetNumber: String(++serial),
  StreetName: `Research Rd ${run}`,
  City: "Testville",
  StateOrProvince: "WA",
  PostalCode: "97111",
  CountyOrParish: "Test County",
  ParcelNumber: `R${run}-${serial}`,
  BedroomsTotal: "3",
  BathroomsTotalInteger: "2",
  LivingArea: "2000",
  // No map pin unless a test gives one, so tests cannot turn up in each other's comparables.
  ...changes,
});

/** A listing that went active, pending, and closed on the dates given. */
async function sale(changes: Record<string, unknown>, active: string, pending: string, closedOn: string, closePrice: string) {
  const base = fields(changes);
  const created = await createListing(agent, base, { at: on(active) });
  await updateListing(agent, created.ListingKey, { ...base, StandardStatus: "Pending" }, null, { at: on(pending) });
  await updateListing(agent, created.ListingKey, { ...base, StandardStatus: "Closed", ClosePrice: closePrice, CloseDate: closedOn }, null, { at: on(closedOn) });
  return created;
}

beforeAll(async () => {
  const members = await db.select().from(member);
  agent = members.find((m) => m.MemberMlsId === "AG1001")!;
  staff = members.find((m) => m.MemberMlsId === "ST0001")!;
});
afterAll(() => pool.end());

describe("sold search", () => {
  it("filters by close date and close price, and sorts by the days on market it shows", async () => {
    const street = `Sold Search St ${run}`;
    // No map pins, so these stay out of the comparables tests below.
    const here = { StreetName: street, Latitude: "", Longitude: "", PostalCode: "97000" };
    const quick = await sale(here, "2026-03-01", "2026-03-06", "2026-04-10", "590000"); // DOM 5
    const slow = await sale(here, "2026-02-01", "2026-03-23", "2026-05-20", "640000"); // DOM 50
    const open = await createListing(agent, fields(here), { at: on("2026-06-10") }); // DOM 20 on June 30
    const everything = { address: street, statuses: [...STANDARD_STATUSES] };
    const search = async (filters: Parameters<typeof searchListings>[0]) =>
      (await searchListings({ ...everything, ...filters }, { asOf: AS_OF })).rows;

    const byDom = await search({ sort: "dom_high" });
    expect(byDom.map((r) => r.listing.ListingKey)).toEqual([slow.ListingKey, open.ListingKey, quick.ListingKey]);
    expect(byDom.map((r) => r.marketTime.daysOnMarket)).toEqual([50, 20, 5]);
    expect((await search({ sort: "dom_low" })).map((r) => r.marketTime.daysOnMarket)).toEqual([5, 20, 50]);

    // Close filters match closed listings only; the open listing never appears.
    expect((await search({ closedFrom: "2026-05-01" })).map((r) => r.listing.ListingKey)).toEqual([slow.ListingKey]);
    expect((await search({ closedFrom: "2026-04-01", closedTo: "2026-04-30" })).map((r) => r.listing.ListingKey)).toEqual([quick.ListingKey]);
    expect((await search({ minClosePrice: 600000 })).map((r) => r.listing.ListingKey)).toEqual([slow.ListingKey]);
    expect((await search({ maxClosePrice: 600000 })).map((r) => r.listing.ListingKey)).toEqual([quick.ListingKey]);
    expect((await search({ sort: "closed_recent" })).map((r) => r.listing.ListingKey).slice(0, 2)).toEqual([slow.ListingKey, quick.ListingKey]);
    // A malformed date is ignored, not passed to the database.
    expect(await search({ closedFrom: "not-a-date" })).toHaveLength(3);
  });
});

describe("the timeline members see", () => {
  it("shows status and price changes, and nothing about people, corrections, documents, or showings", async () => {
    const base = fields({ ShowingInstructions: "Knock loudly timeline-secret", LockBoxLocation: "Behind the timeline-secret gnome" });
    const created = await createListing(agent, base, { at: on("2026-03-01") });
    await updateListing(agent, created.ListingKey, { ...base, ListPrice: "585000" }, null, { at: on("2026-03-10") });
    await updateListing(agent, created.ListingKey, { ...base, ListPrice: "585000", BedroomsTotal: "4" }, null, { at: on("2026-03-11") });
    await updateListing(agent, created.ListingKey, { ...base, ListPrice: "585000", BedroomsTotal: "4", StandardStatus: "Pending" }, null, { at: on("2026-03-20") });
    await updateListing(staff, created.ListingKey, { ...base, ListPrice: "585000", BedroomsTotal: "4", StandardStatus: "Active" }, "Buyer withdrew timeline-secret", { at: on("2026-03-25") });
    await addDocument(agent, created.ListingKey, { bytes: new TextEncoder().encode("%PDF-1.4\n"), name: "Disclosure timeline-secret", permission: "Private" });

    const timeline = await getMarketTimeline(created.ListingKey);
    expect(timeline).toEqual([
      { date: "2026-03-01", event: "Listed", detail: "Active" },
      { date: "2026-03-10", event: "Price change", detail: "$600,000 → $585,000" },
      { date: "2026-03-20", event: "Status", detail: "Active → Pending" },
      { date: "2026-03-25", event: "Back on market", detail: "Pending → Active" },
    ]);
    const text = JSON.stringify(timeline);
    for (const secret of ["timeline-secret", "Rivera", "Ellis", "AG1001", "ST0001", "Bedrooms", "correction", "SHA-256"])
      expect(text).not.toContain(secret);
    expect(await getMarketTimeline("not-a-key")).toEqual([]);
  });
});

describe("comparables", () => {
  const near = (north: number) => ({ Latitude: (35 + north).toFixed(6), Longitude: "-100.000000" });

  it("finds recent, nearby, similar sales and nothing else, nearest first", async () => {
    const subject = await createListing(agent, fields({ ListPrice: "610000", ...near(0) }), { at: on("2026-06-20") });
    const close = await sale(near(0.002), "2026-03-01", "2026-03-11", "2026-04-15", "600000"); // about 0.14 miles
    const closer = await sale(near(0.001), "2026-04-01", "2026-04-21", "2026-05-30", "620000");
    const further = await sale({ ...near(0.01), LivingArea: "2300", BedroomsTotal: "4" }, "2026-02-01", "2026-02-06", "2026-03-10", "660000"); // about 0.69 miles
    // Each of these fails exactly one default criterion.
    const tooFar = await sale(near(0.05), "2026-03-01", "2026-03-11", "2026-04-15", "600000"); // about 3.5 miles
    const tooOld = await sale({ ...near(0.002), ListingContractDate: "2025-07-01" }, "2025-08-01", "2025-08-11", "2025-09-15", "600000");
    const otherType = await sale({ ...near(0.002), PropertyType: "Land" }, "2026-03-01", "2026-03-11", "2026-04-15", "600000");
    const tooBig = await sale({ ...near(0.002), LivingArea: "2600" }, "2026-03-01", "2026-03-11", "2026-04-15", "600000");
    const tooManyBeds = await sale({ ...near(0.002), BedroomsTotal: "5" }, "2026-03-01", "2026-03-11", "2026-04-15", "600000");
    const noPin = await sale({}, "2026-03-01", "2026-03-11", "2026-04-15", "600000");
    const stillActive = await createListing(agent, fields(near(0.002)), { at: on("2026-06-01") });

    const subjectRow = (await getListing(subject.ListingKey, agent))!.listing;
    const defaults = defaultComparableCriteria(subjectRow);
    expect(defaults).toEqual({
      statuses: ["Closed"], closedWithinDays: 180, area: "radius", radiusMiles: 1,
      samePropertyType: true, livingAreaPercent: 20, bedroomRange: 1,
    });

    const found = await findComparables(subjectRow, defaults, { asOf: AS_OF });
    expect(found.map((c) => c.listing.ListingKey)).toEqual([closer.ListingKey, close.ListingKey, further.ListingKey]);
    expect(found[0].distanceMiles!).toBeGreaterThan(0.05);
    expect(found[0].distanceMiles!).toBeLessThan(0.09);
    expect(found[2].distanceMiles!).toBeGreaterThan(0.6);
    expect(found[1]).toMatchObject({ pricePerSquareFoot: 300, marketTime: { daysOnMarket: 10, cumulativeDaysOnMarket: 10 } });

    const summary = summarizeComparables(found);
    expect(summary).toEqual({ closedCount: 3, medians: { closePrice: 620000, pricePerSquareFoot: 300, daysOnMarket: 10 } });

    // Loosening one criterion at a time admits exactly the listing it was excluding.
    const keysWith = async (change: Partial<typeof defaults>) =>
      (await findComparables(subjectRow, { ...defaults, ...change }, { asOf: AS_OF })).map((c) => c.listing.ListingKey);
    const base = [closer.ListingKey, close.ListingKey, further.ListingKey];
    const added = async (change: Partial<typeof defaults>) => (await keysWith(change)).filter((k) => !base.includes(k));
    expect(await added({ radiusMiles: 5 })).toEqual([tooFar.ListingKey]);
    expect(await added({ closedWithinDays: 365 })).toEqual([tooOld.ListingKey]);
    expect(await added({ samePropertyType: false })).toEqual([otherType.ListingKey]);
    expect(await added({ livingAreaPercent: null })).toEqual([tooBig.ListingKey]);
    expect(await added({ bedroomRange: null })).toEqual([tooManyBeds.ListingKey]);
    expect(await added({ statuses: ["Closed", "Active"] })).toEqual([stillActive.ListingKey]);
    // By ZIP code, the sale with no pin appears; the subject never does, under any criteria.
    const byZip = await keysWith({ area: "zip", closedWithinDays: 3650, samePropertyType: false, livingAreaPercent: null, bedroomRange: null, statuses: ["Closed", "Active"] });
    expect(byZip).toContain(noPin.ListingKey);
    expect(byZip).not.toContain(subject.ListingKey);
    expect(await keysWith({ statuses: [] })).toEqual([]);
  });

  it("shows no medians with fewer than three sales, and never carries showing details", async () => {
    const pin = { Latitude: "36.500000", Longitude: "-101.000000", PostalCode: "97222" };
    const subject = await createListing(agent, fields(pin), { at: on("2026-06-20") });
    await sale({ ...pin, ShowingInstructions: "comparable-secret", LockBoxLocation: "comparable-secret" }, "2026-03-01", "2026-03-11", "2026-04-15", "600000");
    await sale(pin, "2026-03-01", "2026-03-11", "2026-04-15", "610000");
    const subjectRow = (await getListing(subject.ListingKey, agent))!.listing;
    const found = await findComparables(subjectRow, defaultComparableCriteria(subjectRow), { asOf: AS_OF });
    expect(found).toHaveLength(2);
    expect(summarizeComparables(found)).toEqual({ closedCount: 2, medians: null });
    expect(JSON.stringify(found)).not.toContain("comparable-secret");
  });

  it("uses the ZIP code when the subject has no map location", async () => {
    const zip = { Latitude: "", Longitude: "", PostalCode: "97333" };
    const subject = await createListing(agent, fields(zip), { at: on("2026-06-20") });
    const sameZip = await sale(zip, "2026-03-01", "2026-03-11", "2026-04-15", "600000");
    const subjectRow = (await getListing(subject.ListingKey, agent))!.listing;
    const defaults = defaultComparableCriteria(subjectRow);
    expect(defaults.area).toBe("zip");
    const found = await findComparables(subjectRow, defaults, { asOf: AS_OF });
    expect(found.map((c) => c.listing.ListingKey)).toEqual([sameZip.ListingKey]);
    expect(found[0].distanceMiles).toBeNull();
    // Asking for a distance anyway finds nothing: there is nothing to measure from.
    expect(await findComparables(subjectRow, { ...defaults, area: "radius" }, { asOf: AS_OF })).toEqual([]);
  });
});

describe("giving a change a past date", () => {
  it("cannot be done through the fields a form or request supplies", async () => {
    const before = Date.now();
    const created = await createListing(agent, fields({ at: "2020-01-01T00:00:00Z", OriginalEntryTimestamp: "2020-01-01T00:00:00Z", ModificationTimestamp: "2020-01-01" }));
    expect(created.OriginalEntryTimestamp.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const { listing } = await updateListing(agent, created.ListingKey, fields({ StreetNumber: created.StreetNumber, StreetName: created.StreetName, ParcelNumber: created.ParcelNumber, ListPrice: "1", at: "2020-01-01", PriceChangeTimestamp: "2020-01-01" }));
    expect(listing.PriceChangeTimestamp!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});
