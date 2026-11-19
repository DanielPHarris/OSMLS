import { describe, expect, it } from "vitest";
import { canUseCollection, canUseSavedSearch, type Viewer } from "../src/lib/access";
import {
  DEFAULT_CRITERIA,
  criteriaFromParams,
  criteriaFromStored,
  criteriaToFilters,
  criteriaToParams,
  describeCriteria,
} from "../src/lib/search-criteria";

const member = (changes: Partial<NonNullable<Viewer>>): NonNullable<Viewer> => ({
  MemberKey: "owner",
  OfficeKey: "office-1",
  OsmlsRole: "agent",
  MemberStatus: "Active",
  ...changes,
});

describe("who may use saved work", () => {
  const mine = { MemberKey: "owner" };
  const viewers: [string, Viewer, boolean][] = [
    ["the owner", member({}), true],
    ["the owner, when the owner is MLS staff", member({ OsmlsRole: "staff", OfficeKey: null }), true],
    ["another agent in the owner's office", member({ MemberKey: "colleague" }), false],
    ["an agent in another office", member({ MemberKey: "stranger", OfficeKey: "office-2" }), false],
    ["MLS staff", member({ MemberKey: "staff", OsmlsRole: "staff", OfficeKey: null }), false],
    ["the owner after suspension", member({ MemberStatus: "Inactive" }), false],
    ["a signed-out visitor", null, false],
  ];
  for (const [who, viewer, expected] of viewers)
    it(`${who} ${expected ? "may" : "may not"}`, () => {
      expect(canUseSavedSearch(viewer, mine)).toBe(expected);
      expect(canUseCollection(viewer, mine)).toBe(expected);
    });
});

describe("search criteria", () => {
  it("reads a search page address and ignores what it does not recognise", () => {
    const criteria = criteriaFromParams({
      s: "1", city: " Port Alder ", minPrice: "$500,000", status: ["Closed", "Sold"], sort: "dom_high",
      closedFrom: "2026-01-01", closedTo: "yesterday", bounds: "-122.3,47.2,-122.1,47.4", mine: "1",
      saved: "abc", notice: "x", listAgentKey: "someone-else", unknown: "y",
    });
    expect(criteria).toEqual({
      listingId: undefined, address: undefined, city: "Port Alder", postalCode: undefined,
      minPrice: 500000, maxPrice: undefined, minBeds: undefined, minBaths: undefined,
      minClosePrice: undefined, maxClosePrice: undefined,
      closedFrom: "2026-01-01", closedTo: undefined,
      statuses: ["Closed"], sort: "dom_high", bounds: "-122.3,47.2,-122.1,47.4", mine: true,
    });
    expect(Object.keys(criteria)).not.toContain("listAgentKey");
  });

  it("uses the default statuses for a first visit, and every status for a submitted search with none ticked", () => {
    expect(criteriaFromParams({}).statuses).toEqual(["Active", "Coming Soon"]);
    expect(criteriaFromParams({ s: "1" }).statuses).toEqual([]);
  });

  it("round-trips through a page address", () => {
    const criteria = criteriaFromParams({ s: "1", address: "Oak", status: ["Active", "Pending"], maxPrice: "750000", sort: "price_low", mine: "1" });
    const params = Object.fromEntries([...criteriaToParams(criteria).keys()].map((k) => [k, criteriaToParams(criteria).getAll(k)]));
    expect(criteriaFromParams(params)).toEqual(criteria);
  });

  it("checks stored criteria again and names what it drops", () => {
    const { criteria, ignored } = criteriaFromStored({
      city: "Port Alder", statuses: ["Active", "Sold", "Under Offer"], sort: "by_magic",
      minPrice: "cheap", closedFrom: "2026-13-45", bounds: "nonsense", mine: "yes",
      listAgentKey: "11111111-1111-4111-8111-111111111111", "<script>": "x",
    });
    expect(criteria).toEqual({ ...DEFAULT_CRITERIA, city: "Port Alder", statuses: ["Active"], sort: "changed", mine: false });
    expect(ignored.sort()).toEqual(
      ["2 statuses", "a criterion this version does not recognise", "closed on or after", "map area", "minimum price", "only my listings", "sort order"].sort(),
    );
    // Nothing that was stored is echoed back in the notice.
    expect(ignored.join(" ")).not.toMatch(/script|listAgentKey|Sold|by_magic/);
  });

  it("drops nothing from criteria that are all still valid", () => {
    const stored = { city: "Port Alder", statuses: ["Closed"], sort: "dom_low", mine: true, minBeds: 3 };
    expect(criteriaFromStored(stored)).toEqual({ criteria: { ...DEFAULT_CRITERIA, ...stored }, ignored: [] });
    expect(criteriaFromStored(null).ignored).toEqual([]);
    expect(criteriaFromStored("not an object").criteria.statuses).toEqual([]);
  });

  it("turns 'my listings' into the member who is searching, never a stored one", () => {
    const criteria = { ...DEFAULT_CRITERIA, mine: true };
    expect(criteriaToFilters(criteria, { MemberKey: "alex", OsmlsRole: "agent" }).listAgentKey).toBe("alex");
    expect(criteriaToFilters(criteria, { MemberKey: "sam", OsmlsRole: "agent" }).listAgentKey).toBe("sam");
    expect(criteriaToFilters(criteria, { MemberKey: "morgan", OsmlsRole: "staff" }).listAgentKey).toBeUndefined();
    expect(criteriaToFilters({ ...DEFAULT_CRITERIA, mine: false }, { MemberKey: "alex", OsmlsRole: "agent" }).listAgentKey).toBeUndefined();
  });

  it("describes criteria in words", () => {
    expect(describeCriteria({ ...DEFAULT_CRITERIA, statuses: ["Closed"], city: "Port Alder", minPrice: 500000, sort: "dom_high", mine: true })).toBe(
      "My listings · Closed · in Port Alder · price $500,000 to any · sorted by days on market, most first",
    );
    expect(describeCriteria({ ...DEFAULT_CRITERIA, statuses: [] })).toBe("Every status");
  });
});
