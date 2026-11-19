/*
 * Days on market and relisting chains, against the test database. Listings are
 * given a past by supplying the time of each change, which only tests and the
 * seed script can do. Example letters refer to the worked examples in issue #10.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { member, type Member } from "../src/db/schema";
import { createListing, updateListing } from "../src/lib/listings";
import { getMarketTime } from "../src/lib/market-time";
import { MARKET_TIME_SETTINGS, type MarketTimeSettings } from "../src/lib/rules/market-time";

let agents: { harborMain: Member; harborBranch: Member; summit: Member; staff: Member };

// Early afternoon in the Pacific time zone, so the calendar date there is the date given.
const on = (date: string) => new Date(`${date}T21:00:00Z`);
let serial = 0;
/** A parcel number no other test uses. */
const newParcel = () => `T${Date.now()}-${++serial}`;

type Step = [status: string, date: string];
type Options = { agent?: Member; parcel?: string | null; county?: string | null; unit?: string; address?: Partial<Record<string, string>> };

/** Enters a listing and takes it through a series of status changes on the dates given. */
async function listing(steps: Step[], options: Options = {}) {
  const agent = options.agent ?? agents.harborMain;
  const fields = (status: string, date: string) => ({
    StandardStatus: status,
    PropertyType: "Residential",
    ListPrice: "500000",
    ListingContractDate: "2026-01-01",
    StreetNumber: "1",
    StreetName: `Market Time Rd ${serial}`,
    City: "Testville",
    StateOrProvince: "WA",
    PostalCode: "98999",
    BedroomsTotal: "3",
    BathroomsTotalInteger: "2",
    CountyOrParish: options.county === undefined ? "Test County" : (options.county ?? ""),
    ParcelNumber: options.parcel === undefined ? newParcel() : (options.parcel ?? ""),
    UnitNumber: options.unit ?? "",
    ...options.address,
    ...(status === "Closed" ? { ClosePrice: "495000", CloseDate: date } : {}),
  });
  const [[firstStatus, firstDate], ...rest] = steps;
  const created = await createListing(agent, fields(firstStatus, firstDate), { at: on(firstDate) });
  for (const [status, date] of rest)
    await updateListing(agent, created.ListingKey, fields(status, date), null, { at: on(date) });
  return created;
}

const marketTime = async (key: string, asOf: string, settings?: Partial<MarketTimeSettings>) => {
  const all = await getMarketTime([key], { asOf: on(asOf), settings: { ...MARKET_TIME_SETTINGS, ...settings } });
  const { daysOnMarket, cumulativeDaysOnMarket } = all.get(key)!;
  return { dom: daysOnMarket, cdom: cumulativeDaysOnMarket };
};

beforeAll(async () => {
  const members = await db.select().from(member);
  const byId = (id: string) => members.find((m) => m.MemberMlsId === id)!;
  agents = { harborMain: byId("AG1001"), harborBranch: byId("AG1003"), summit: byId("AG2001"), staff: byId("ST0001") };
  // Harborview has a main office and a branch; Summit is a different brokerage.
  expect(agents.harborBranch.OfficeKey).not.toBe(agents.harborMain.OfficeKey);
});

afterAll(() => pool.end());

describe("days on market: the worked examples, with the default settings", () => {
  it("A. straight sale", async () => {
    const l = await listing([["Active", "2026-03-01"], ["Pending", "2026-03-21"], ["Closed", "2026-04-30"]]);
    expect(await marketTime(l.ListingKey, "2026-06-01")).toEqual({ dom: 20, cdom: 20 });
  });

  it("B. back on market: time spent pending is not counted", async () => {
    const l = await listing([
      ["Active", "2026-03-01"], ["Pending", "2026-03-11"], ["Active", "2026-03-25"],
      ["Pending", "2026-04-04"], ["Closed", "2026-05-15"],
    ]);
    expect(await marketTime(l.ListingKey, "2026-06-01")).toEqual({ dom: 20, cdom: 20 });
  });

  it("C. under contract with backups: the count runs on", async () => {
    const l = await listing([
      ["Active", "2026-03-01"], ["Active Under Contract", "2026-03-11"], ["Pending", "2026-03-31"], ["Closed", "2026-05-01"],
    ]);
    expect(await marketTime(l.ListingKey, "2026-06-01")).toEqual({ dom: 30, cdom: 30 });
  });

  it("D. coming soon first: nothing counts before it is active", async () => {
    const l = await listing([["Coming Soon", "2026-02-20"], ["Active", "2026-03-01"], ["Pending", "2026-03-08"]]);
    expect(await marketTime(l.ListingKey, "2026-06-01")).toEqual({ dom: 7, cdom: 7 });
  });

  it("E. quick relist by the same office continues the count", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-04-30"]], { parcel });
    const second = await listing([["Active", "2026-05-10"]], { parcel });
    expect(await marketTime(second.ListingKey, "2026-05-20")).toEqual({ dom: 10, cdom: 70 });
  });

  it("F. relist with a different brokerage still continues the count", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-04-30"]], { parcel });
    const second = await listing([["Active", "2026-05-10"]], { parcel, agent: agents.summit });
    expect(await marketTime(second.ListingKey, "2026-05-20")).toEqual({ dom: 10, cdom: 70 });
  });

  it("G. relist after a long gap starts again", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Expired", "2026-04-30"]], { parcel });
    const second = await listing([["Active", "2026-06-15"]], { parcel });
    expect(await marketTime(second.ListingKey, "2026-06-25")).toEqual({ dom: 10, cdom: 10 });
  });

  it("H. relist after a sale starts again, however short the gap", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Pending", "2026-03-21"], ["Closed", "2026-04-30"]], { parcel });
    const second = await listing([["Active", "2026-05-10"]], { parcel });
    expect(await marketTime(second.ListingKey, "2026-05-20")).toEqual({ dom: 10, cdom: 10 });
  });

  it("I. three in a row add up", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-01-01"], ["Expired", "2026-04-01"]], { parcel }); // DOM 90
    await listing([["Active", "2026-04-06"], ["Canceled", "2026-05-16"]], { parcel }); // 5 days later, DOM 40
    const third = await listing([["Active", "2026-05-28"]], { parcel }); // 12 days later
    expect(await marketTime(third.ListingKey, "2026-06-03")).toEqual({ dom: 6, cdom: 136 });
  });

  it("J. same-day change counts no days", async () => {
    const l = await listing([["Active", "2026-03-01"], ["Pending", "2026-03-01"], ["Closed", "2026-04-01"]]);
    expect(await marketTime(l.ListingKey, "2026-06-01")).toEqual({ dom: 0, cdom: 0 });
  });

  it("K. the same parcel number in another county is another property", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Expired", "2026-04-30"]], { parcel, county: "First County" });
    const second = await listing([["Active", "2026-05-10"]], { parcel, county: "Second County" });
    expect(await marketTime(second.ListingKey, "2026-05-10")).toEqual({ dom: 0, cdom: 0 });
  });

  it("L. two units on one parcel are different properties", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-04-15"]], { parcel, unit: "4" });
    const second = await listing([["Active", "2026-04-20"]], { parcel, unit: "7" });
    expect(await marketTime(second.ListingKey, "2026-04-20")).toEqual({ dom: 0, cdom: 0 });
  });

  it("M. with no parcel number, an identical address matches", async () => {
    const address = { StreetNumber: "88", StreetName: `No Parcel Ln ${Date.now()}` };
    await listing([["Active", "2026-03-01"], ["Expired", "2026-03-31"]], { parcel: null, address }); // DOM 30
    const second = await listing([["Active", "2026-04-08"]], { parcel: null, address });
    expect(await marketTime(second.ListingKey, "2026-04-18")).toEqual({ dom: 10, cdom: 40 });
  });

  it("N. a sale in between ends the chain; it does not reach back past it", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-01-01"], ["Canceled", "2026-02-20"]], { parcel }); // DOM 50
    await listing([["Active", "2026-03-02"], ["Pending", "2026-03-22"], ["Closed", "2026-04-10"]], { parcel }); // 10 days later, DOM 20, sold
    const third = await listing([["Active", "2026-04-22"]], { parcel }); // 12 days after the sale
    expect(await marketTime(third.ListingKey, "2026-04-27")).toEqual({ dom: 5, cdom: 5 });
  });
});

describe("listings of one property that overlap", () => {
  it("O. a relisting entered before the earlier listing ended continues it, and the shared days count in both", async () => {
    const parcel = newParcel();
    // Listing 1 runs March 1 to April 10 (DOM 40). Listing 2 is entered March 31, ten days before that.
    const first = await listing([["Active", "2026-03-01"], ["Canceled", "2026-04-10"]], { parcel });
    const second = await listing([["Active", "2026-03-31"]], { parcel });
    // On April 20 the second has 20 days of its own. The ten days both were active are in both figures.
    expect(await marketTime(second.ListingKey, "2026-04-20")).toEqual({ dom: 20, cdom: 60 });
    // The earlier listing is unaffected: nothing precedes it.
    expect(await marketTime(first.ListingKey, "2026-04-20")).toEqual({ dom: 40, cdom: 40 });
  });

  it("does not continue an earlier listing that is still open", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"]], { parcel });
    const second = await listing([["Active", "2026-03-31"]], { parcel });
    expect(await marketTime(second.ListingKey, "2026-04-20")).toEqual({ dom: 20, cdom: 20 });
  });

  it("P. measures the gap from the date the earlier listing reached its final status", async () => {
    const [long, short] = [newParcel(), newParcel()];
    // Pending for 40 days, then canceled. The count stopped on March 11, but the listing ended April 20.
    await listing([["Active", "2026-03-01"], ["Pending", "2026-03-11"], ["Canceled", "2026-04-20"]], { parcel: long });
    const soonAfter = await listing([["Active", "2026-04-25"]], { parcel: long });
    // Five days after the cancellation, though 45 after it stopped accumulating: it continues.
    expect(await marketTime(soonAfter.ListingKey, "2026-04-30")).toEqual({ dom: 5, cdom: 15 });

    await listing([["Active", "2026-03-01"], ["Pending", "2026-03-11"], ["Canceled", "2026-03-12"]], { parcel: short });
    const muchLater = await listing([["Active", "2026-04-25"]], { parcel: short });
    // 44 days after the cancellation: it starts again.
    expect(await marketTime(muchLater.ListingKey, "2026-04-30")).toEqual({ dom: 5, cdom: 5 });
  });
});

describe("each setting changes the calculation", () => {
  it("statuses that accumulate days: without Active Under Contract, example C is 10 days", async () => {
    const l = await listing([
      ["Active", "2026-03-01"], ["Active Under Contract", "2026-03-11"], ["Pending", "2026-03-31"], ["Closed", "2026-05-01"],
    ]);
    expect(await marketTime(l.ListingKey, "2026-06-01", { accumulatingStatuses: ["Active"] })).toEqual({ dom: 10, cdom: 10 });
    expect(await marketTime(l.ListingKey, "2026-06-01", { accumulatingStatuses: ["Active", "Active Under Contract", "Pending"] })).toEqual({ dom: 61, cdom: 61 });
  });

  it("relisting gap: at 60 days, example G continues", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Expired", "2026-04-30"]], { parcel });
    const second = await listing([["Active", "2026-06-15"]], { parcel });
    expect(await marketTime(second.ListingKey, "2026-06-25", { relistingGapDays: 60 })).toEqual({ dom: 10, cdom: 70 });
  });

  it("relisting gap: exactly 30 days does not continue, 29 does", async () => {
    const [p30, p29] = [newParcel(), newParcel()];
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { parcel: p30 });
    const at30 = await listing([["Active", "2026-04-10"]], { parcel: p30 });
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { parcel: p29 });
    const at29 = await listing([["Active", "2026-04-09"]], { parcel: p29 });
    expect((await marketTime(at30.ListingKey, "2026-04-10")).cdom).toBe(0);
    expect((await marketTime(at29.ListingKey, "2026-04-09")).cdom).toBe(10);
  });

  it("brokerage reset: when on, example F starts again", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-04-30"]], { parcel });
    const second = await listing([["Active", "2026-05-10"]], { parcel, agent: agents.summit });
    expect(await marketTime(second.ListingKey, "2026-05-20", { brokerageChangeResets: true })).toEqual({ dom: 10, cdom: 10 });
  });

  it("brokerage reset: a move between branches of one brokerage continues under both values", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-04-30"]], { parcel, agent: agents.harborMain });
    const second = await listing([["Active", "2026-05-10"]], { parcel, agent: agents.harborBranch });
    expect(await marketTime(second.ListingKey, "2026-05-20", { brokerageChangeResets: true })).toEqual({ dom: 10, cdom: 70 });
    expect(await marketTime(second.ListingKey, "2026-05-20", { brokerageChangeResets: false })).toEqual({ dom: 10, cdom: 70 });
  });

  it("address fallback: when off, example M starts again", async () => {
    const address = { StreetNumber: "89", StreetName: `No Parcel Ln ${Date.now()}` };
    await listing([["Active", "2026-03-01"], ["Expired", "2026-03-31"]], { parcel: null, address });
    const second = await listing([["Active", "2026-04-08"]], { parcel: null, address });
    expect(await marketTime(second.ListingKey, "2026-04-18", { addressFallback: false })).toEqual({ dom: 10, cdom: 10 });
  });

  it("gap endpoint: entered inside the gap but on the market after it", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { parcel }); // DOM 10
    // Entered 20 days later as Coming Soon; active 40 days after the cancellation.
    const second = await listing([["Coming Soon", "2026-03-31"], ["Active", "2026-04-20"]], { parcel });
    expect(await marketTime(second.ListingKey, "2026-04-25", { gapEndpoint: "entered" })).toEqual({ dom: 5, cdom: 15 });
    expect(await marketTime(second.ListingKey, "2026-04-25", { gapEndpoint: "onMarket" })).toEqual({ dom: 5, cdom: 5 });
  });

  it("time zone: a change near midnight falls on a different date", async () => {
    const agent = agents.harborMain;
    const fields = (status: string) => ({
      StandardStatus: status, PropertyType: "Residential", ListPrice: "1", ListingContractDate: "2026-01-01",
      StreetNumber: "2", StreetName: `Midnight Way ${Date.now()}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98999",
      BedroomsTotal: "1", BathroomsTotalInteger: "1", ParcelNumber: newParcel(), CountyOrParish: "Test County",
    });
    // 06:30 UTC on March 2 is still March 1 in Los Angeles, and already March 2 in New York.
    const created = await createListing(agent, fields("Active"), { at: new Date("2026-03-02T06:30:00Z") });
    await updateListing(agent, created.ListingKey, fields("Pending"), null, { at: new Date("2026-03-11T20:00:00Z") });
    expect((await marketTime(created.ListingKey, "2026-06-01")).dom).toBe(10);
    expect((await marketTime(created.ListingKey, "2026-06-01", { timeZone: "America/New_York" })).dom).toBe(9);
  });
});

describe("edges", () => {
  it("counts calendar dates across a daylight-saving change", async () => {
    // Clocks go forward in the United States on March 8, 2026.
    const l = await listing([["Active", "2026-03-01"], ["Pending", "2026-03-15"]]);
    expect((await marketTime(l.ListingKey, "2026-06-01")).dom).toBe(14);
  });

  it("matches parcel numbers that differ only in spacing and punctuation", async () => {
    const digits = `${Date.now()}`;
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { parcel: `12-${digits} 001` });
    const second = await listing([["Active", "2026-03-15"]], { parcel: `12${digits}001` });
    expect((await marketTime(second.ListingKey, "2026-03-15")).cdom).toBe(10);
  });

  it("does not match by address when both have parcel numbers that differ", async () => {
    const address = { StreetNumber: "90", StreetName: `Two Parcels Ln ${Date.now()}` };
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { address });
    const second = await listing([["Active", "2026-03-15"]], { address });
    expect((await marketTime(second.ListingKey, "2026-03-15")).cdom).toBe(0);
  });

  it("does not match a unit against no unit at the same address", async () => {
    const address = { StreetNumber: "91", StreetName: `Unit Ln ${Date.now()}` };
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { parcel: null, address, unit: "2" });
    const second = await listing([["Active", "2026-03-15"]], { parcel: null, address });
    expect((await marketTime(second.ListingKey, "2026-03-15")).cdom).toBe(0);
  });

  it("reflects a staff correction to status", async () => {
    const l = await listing([["Active", "2026-03-01"], ["Pending", "2026-03-11"]]);
    expect((await marketTime(l.ListingKey, "2026-03-31")).dom).toBe(10);
    // Staff put it back to Active on March 21: the count resumes from then.
    const [row] = await db.query.property.findMany({ where: (p) => eq(p.ListingKey, l.ListingKey) });
    await updateListing(
      agents.staff,
      l.ListingKey,
      { ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => [k, String(v)])), StandardStatus: "Active" },
      "Entered as pending in error.",
      { at: on("2026-03-21") },
    );
    expect((await marketTime(l.ListingKey, "2026-03-31")).dom).toBe(20);
  });

  it("takes changes made at the same instant in the order they were made", async () => {
    // Four changes sharing one timestamp: only the order of writing can settle it.
    const l = await listing([
      ["Active", "2026-03-01"], ["Pending", "2026-03-01"], ["Active", "2026-03-01"], ["Pending", "2026-03-01"],
    ]);
    expect((await marketTime(l.ListingKey, "2026-06-01")).dom).toBe(0);
    // And the reverse ending: left active, it has been accumulating ever since.
    const stillActive = await listing([["Active", "2026-03-01"], ["Pending", "2026-03-01"], ["Active", "2026-03-01"]]);
    expect((await marketTime(stillActive.ListingKey, "2026-03-11")).dom).toBe(10);
  });

  it("gives a listing with no history of being on the market zero days", async () => {
    const l = await listing([["Coming Soon", "2026-03-01"], ["Canceled", "2026-03-20"]]);
    expect(await marketTime(l.ListingKey, "2026-06-01")).toEqual({ dom: 0, cdom: 0 });
  });

  it("does not loop or double count when two relistings are entered at the same moment", async () => {
    const parcel = newParcel();
    await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { parcel }); // DOM 10
    const [a, b] = await Promise.all([
      listing([["Active", "2026-03-15"]], { parcel }),
      listing([["Active", "2026-03-15"]], { parcel }),
    ]);
    const both = await getMarketTime([a.ListingKey, b.ListingKey], { asOf: on("2026-03-20") });
    // Neither precedes the other; each continues the canceled listing once.
    expect(both.get(a.ListingKey)).toMatchObject({ daysOnMarket: 5, cumulativeDaysOnMarket: 15 });
    expect(both.get(b.ListingKey)).toMatchObject({ daysOnMarket: 5, cumulativeDaysOnMarket: 15 });
  });

  it("names the listings a count continues", async () => {
    const parcel = newParcel();
    const first = await listing([["Active", "2026-03-01"], ["Canceled", "2026-03-11"]], { parcel });
    const second = await listing([["Active", "2026-03-15"]], { parcel });
    const result = (await getMarketTime([second.ListingKey], { asOf: on("2026-03-20") })).get(second.ListingKey)!;
    expect(result.continues).toEqual([first.ListingId]);
    expect(result.firstOnMarketDate).toBe("2026-03-15");
    expect(result.offMarketDate).toBeNull();
    const ended = (await getMarketTime([first.ListingKey], { asOf: on("2026-03-20") })).get(first.ListingKey)!;
    expect(ended.offMarketDate).toBe("2026-03-11");
  });
});
