import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/listings";
import { choosePredecessor, continuesPredecessor, daysBetween, normalizeParcel, sameProperty } from "../src/lib/market-time";
import { median } from "../src/lib/market-research";
import { MARKET_TIME_SETTINGS } from "../src/lib/rules/market-time";

const home = {
  parcelNumber: "12-345-678",
  countyOrParish: "Alder County",
  stateOrProvince: "WA",
  streetNumber: "12",
  streetName: "Oak St",
  unitNumber: null,
  city: "Port Alder",
  postalCode: "98001",
};

describe("the settings file", () => {
  it("has one list of statuses that accumulate days, and no list of pausing statuses", () => {
    expect(MARKET_TIME_SETTINGS.accumulatingStatuses).toEqual(["Active", "Active Under Contract"]);
    expect(Object.keys(MARKET_TIME_SETTINGS).sort()).toEqual(
      ["accumulatingStatuses", "addressFallback", "brokerageChangeResets", "gapEndpoint", "relistingGapDays", "timeZone"].sort(),
    );
    expect(MARKET_TIME_SETTINGS).toMatchObject({ relistingGapDays: 30, brokerageChangeResets: false, addressFallback: true, gapEndpoint: "entered" });
  });
});

describe("is it the same property?", () => {
  it("matches on parcel number, county, and state together", () => {
    expect(sameProperty(home, { ...home, parcelNumber: "12 345 678", streetName: "Different St" })).toBe(true);
    expect(sameProperty(home, { ...home, countyOrParish: "Other County" })).toBe(false);
    expect(sameProperty(home, { ...home, stateOrProvince: "OR" })).toBe(false);
    expect(sameProperty(home, { ...home, parcelNumber: "99-999-999" })).toBe(false);
  });

  it("requires unit numbers to agree in both kinds of match", () => {
    expect(sameProperty({ ...home, unitNumber: "4" }, { ...home, unitNumber: "7" })).toBe(false);
    expect(sameProperty({ ...home, unitNumber: "4" }, home)).toBe(false);
    expect(sameProperty({ ...home, unitNumber: " 4 " }, { ...home, unitNumber: "4" })).toBe(true);
    const noParcel = { ...home, parcelNumber: null };
    expect(sameProperty({ ...noParcel, unitNumber: "4" }, noParcel)).toBe(false);
  });

  it("falls back to the address only when a parcel match is not possible", () => {
    const noParcel = { ...home, parcelNumber: null };
    const noCounty = { ...home, countyOrParish: null };
    expect(sameProperty(noParcel, { ...noParcel, streetName: " oak  st " })).toBe(true);
    expect(sameProperty(noParcel, home)).toBe(true);
    // A parcel number with no county cannot identify a property, so the address decides.
    expect(sameProperty(noCounty, { ...noCounty, parcelNumber: "99" })).toBe(true);
    expect(sameProperty(noParcel, { ...noParcel, streetName: "Oak Street" })).toBe(false);
    expect(sameProperty(noParcel, { ...noParcel, postalCode: "98002" })).toBe(false);
    expect(sameProperty(noParcel, noParcel, { ...MARKET_TIME_SETTINGS, addressFallback: false })).toBe(false);
  });

  it("does not consult the address when both are identified by different parcels", () => {
    expect(sameProperty(home, { ...home, parcelNumber: "00-000-001" })).toBe(false);
  });

  it("normalises parcel numbers", () => {
    expect(normalizeParcel(" 12-345.678 a ")).toBe("12345678A");
    expect(normalizeParcel("  ")).toBeNull();
    expect(normalizeParcel(null)).toBeNull();
  });
});

describe("choosing and testing the predecessor", () => {
  const at = (date: string) => new Date(`${date}T20:00:00Z`);
  const entry = (listingKey: string, date: string, changes = {}) => ({ ...home, listingKey, enteredAt: at(date), ...changes });

  it("takes the most recently entered earlier listing of the same property", () => {
    const current = entry("c", "2026-05-01");
    const candidates = [entry("a", "2026-01-01"), entry("b", "2026-03-01"), entry("later", "2026-06-01"), entry("other", "2026-04-01", { parcelNumber: "9" })];
    expect(choosePredecessor(current, candidates)?.listingKey).toBe("b");
    expect(choosePredecessor(current, [current, entry("same-time", "2026-05-01")])).toBeNull();
  });

  const link = (changes = {}) => ({
    standardStatus: "Canceled",
    enteredDate: "2026-05-10",
    firstOnMarketDate: "2026-05-10",
    endedDate: "2026-04-30",
    brokerageKey: "one",
    ...changes,
  });

  it("never continues a sale, or a listing that is still open", () => {
    for (const standardStatus of ["Closed", "Active", "Pending", "Hold", "Coming Soon", "Active Under Contract"])
      expect(continuesPredecessor(link(), link({ standardStatus })), standardStatus).toBe(false);
    for (const standardStatus of ["Canceled", "Expired", "Withdrawn"])
      expect(continuesPredecessor(link(), link({ standardStatus })), standardStatus).toBe(true);
  });

  it("applies the gap, the endpoint, and the brokerage rule", () => {
    const current = link({ enteredDate: "2026-05-29", firstOnMarketDate: "2026-06-05", brokerageKey: "two" });
    expect(continuesPredecessor(current, link())).toBe(true); // 29 days
    expect(continuesPredecessor({ ...current, enteredDate: "2026-05-30" }, link())).toBe(false); // 30 days
    expect(continuesPredecessor(current, link(), { ...MARKET_TIME_SETTINGS, gapEndpoint: "onMarket" })).toBe(false); // 36 days
    expect(continuesPredecessor(current, link(), { ...MARKET_TIME_SETTINGS, brokerageChangeResets: true })).toBe(false);
    expect(continuesPredecessor({ ...current, brokerageKey: "one" }, link(), { ...MARKET_TIME_SETTINGS, brokerageChangeResets: true })).toBe(true);
  });
});

describe("dates and figures", () => {
  it("counts whole days between calendar dates", () => {
    expect(daysBetween("2026-03-01", "2026-03-21")).toBe(20);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2); // across the daylight-saving change
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("gives the calendar date in the MLS time zone", () => {
    expect(localDate(new Date("2026-03-02T06:30:00Z"), "America/Los_Angeles")).toBe("2026-03-01");
    expect(localDate(new Date("2026-03-02T06:30:00Z"), "America/New_York")).toBe("2026-03-02");
  });

  it("takes the median, not the mean", () => {
    expect(median([1, 2, 900])).toBe(2);
    expect(median([1, 2, 3, 900])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
