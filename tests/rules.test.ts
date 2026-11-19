import { describe, expect, it } from "vitest";
import { parseListingInput } from "../src/lib/listing-input";
import { parseBounds, sniffImageType } from "../src/lib/listings";
import { canTransition, changeTypeForStatus, isTerminal } from "../src/lib/rules/status";

const valid = {
  StandardStatus: "Active",
  PropertyType: "Residential",
  ListPrice: "450000",
  ListingContractDate: "2026-01-15",
  StreetNumber: "12",
  StreetName: "Alder St",
  UnitNumber: "",
  City: "Port Alder",
  StateOrProvince: "wa",
  PostalCode: "98001",
  BedroomsTotal: "3",
  BathroomsTotalInteger: "2",
  LivingArea: "",
  LotSizeAcres: "",
  YearBuilt: "",
  PublicRemarks: "",
  ClosePrice: "",
  CloseDate: "",
};

describe("status rules", () => {
  it("allows the permitted changes and refuses the rest", () => {
    expect(canTransition("Active", "Pending")).toBe(true);
    expect(canTransition("Pending", "Closed")).toBe(true);
    expect(canTransition("Active", "Closed")).toBe(false);
    expect(canTransition("Closed", "Active")).toBe(false);
    expect(canTransition("Active", "Active")).toBe(true);
  });

  it("treats closed, canceled, and expired as terminal", () => {
    expect(["Closed", "Canceled", "Expired"].every((s) => isTerminal(s as "Closed"))).toBe(true);
    expect(isTerminal("Active")).toBe(false);
  });

  it("records a return to Active as Back On Market", () => {
    expect(changeTypeForStatus("Pending", "Active")).toBe("Back On Market");
    expect(changeTypeForStatus("Coming Soon", "Active")).toBe("Active");
    expect(changeTypeForStatus("Active", "Pending")).toBe("Pending");
  });
});

describe("listing validation", () => {
  it("accepts a complete listing and normalises blanks and case", () => {
    const result = parseListingInput(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ListPrice).toBe(450000);
    expect(result.data.StateOrProvince).toBe("WA");
    expect(result.data.UnitNumber).toBeNull();
    expect(result.data.LivingArea).toBeNull();
  });

  it("reports each missing required field", () => {
    const result = parseListingInput({ ...valid, StreetName: " ", City: "", ListPrice: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["City", "ListPrice", "StreetName"]);
  });

  it.each([
    ["ListPrice", "0"],
    ["ListPrice", "abc"],
    ["BedroomsTotal", "-1"],
    ["BedroomsTotal", "2.5"],
    ["PostalCode", "9800"],
    ["StateOrProvince", "Washington"],
    ["ListingContractDate", "2999-01-01"],
    ["YearBuilt", "1200"],
    ["StandardStatus", "Sold"],
  ])("rejects %s = %s", (field, value) => {
    const result = parseListingInput({ ...valid, [field]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toBeTruthy();
  });

  it("rejects dates that are well formed but not on the calendar", () => {
    for (const date of ["2026-02-31", "2026-02-29", "2026-04-31", "2026-13-01"]) {
      const contract = parseListingInput({ ...valid, ListingContractDate: date });
      expect(!contract.ok && contract.errors.ListingContractDate, date).toBeTruthy();
      const close = parseListingInput({ ...valid, StandardStatus: "Closed", ClosePrice: "1", CloseDate: date });
      expect(!close.ok && close.errors.CloseDate, date).toBeTruthy();
    }
    expect(parseListingInput({ ...valid, ListingContractDate: "2024-02-29" }).ok).toBe(true);
  });

  it("requires close price and date exactly when the listing is closed", () => {
    const closedWithout = parseListingInput({ ...valid, StandardStatus: "Closed" });
    expect(closedWithout.ok).toBe(false);
    if (!closedWithout.ok) expect(Object.keys(closedWithout.errors).sort()).toEqual(["CloseDate", "ClosePrice"]);

    expect(parseListingInput({ ...valid, StandardStatus: "Closed", ClosePrice: "440000", CloseDate: "2026-02-01" }).ok).toBe(true);
    expect(parseListingInput({ ...valid, ClosePrice: "440000" }).ok).toBe(false);
    expect(parseListingInput({ ...valid, StandardStatus: "Closed", ClosePrice: "440000", CloseDate: "2026-01-01" }).ok).toBe(false);
  });
});

describe("map location validation", () => {
  it("accepts a location, rounded to six decimal places", () => {
    const result = parseListingInput({ ...valid, Latitude: "47.31234567", Longitude: "-122.2600001" });
    expect(result.ok).toBe(true);
    if (result.ok) expect([result.data.Latitude, result.data.Longitude]).toEqual([47.312346, -122.26]);
  });

  it("accepts a listing with no location", () => {
    const result = parseListingInput({ ...valid, Latitude: "", Longitude: "" });
    expect(result.ok && result.data.Latitude).toBeNull();
  });

  it("requires both coordinates or neither", () => {
    const onlyLatitude = parseListingInput({ ...valid, Latitude: "47.3" });
    expect(!onlyLatitude.ok && onlyLatitude.errors.Longitude).toMatch(/both latitude and longitude/);
    const onlyLongitude = parseListingInput({ ...valid, Longitude: "-122.2" });
    expect(!onlyLongitude.ok && onlyLongitude.errors.Latitude).toMatch(/both latitude and longitude/);
  });

  it.each([
    ["Latitude", "90.1"],
    ["Latitude", "-91"],
    ["Longitude", "180.5"],
    ["Longitude", "east"],
  ])("rejects %s = %s", (field, value) => {
    const result = parseListingInput({ ...valid, Latitude: "10", Longitude: "10", [field]: value });
    expect(!result.ok && result.errors[field]).toBeTruthy();
  });
});

describe("map area in a URL", () => {
  it("reads west,south,east,north", () => {
    expect(parseBounds("-122.3,47.2,-122.1,47.4")).toEqual({ west: -122.3, south: 47.2, east: -122.1, north: 47.4 });
  });

  it.each([undefined, "", "1,2,3", "a,b,c,d", "10,10,5,20", "10,20,20,10", "-200,0,10,10", "0,0,10,95"])(
    "ignores %s",
    (value) => expect(parseBounds(value)).toBeUndefined(),
  );
});

describe("photo type detection", () => {
  it("recognises images by content and rejects everything else", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.mime).toBe("image/png");
    expect(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});
