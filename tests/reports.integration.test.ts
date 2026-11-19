/*
 * Printable reports against the test database: what a client copy may hold,
 * what an agent copy adds for each kind of member, order, limits, and what a
 * report says about anything it leaves out.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { member, property, type Member, type Property } from "../src/db/schema";
import { addDocument } from "../src/lib/documents";
import { createListing, updateListing } from "../src/lib/listings";
import {
  collectionReport,
  disclosureLines,
  listingReport,
  parseCopy,
  searchReport,
  type AgentReport,
  type ClientReport,
  type Report,
} from "../src/lib/reports";
import { CLIENT_LISTING_FIELDS, toClientListing } from "../src/lib/rules/client-copy";
import { MAX_LISTINGS_PER_REPORT, MAX_SEARCH_RESULTS } from "../src/lib/rules/local";
import { addToCollection, createCollection } from "../src/lib/saved-work";
import { DEFAULT_CRITERIA, type SearchCriteria } from "../src/lib/search-criteria";

const run = Date.now();
const CITY = `Reportville${run}`;
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const SHOWING_MARK = `showing-mark-${run}`;
const LOCKBOX_MARK = `lockbox-mark-${run}`;
const DOCUMENT_MARK = `document-mark-${run}`;
const REASON_MARK = `correction-mark-${run}`;

let owner: Member;
let who: Record<"sameOffice" | "otherOffice" | "staff" | "ownerSuspended" | "suspendedStaff", Member>;
let serial = 0;

const fields = (changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: String(300000 + ++serial * 1000),
  ListingContractDate: "2026-01-01", StreetNumber: String(serial), StreetName: "Report Rd", City: CITY,
  StateOrProvince: "WA", PostalCode: "96556", BedroomsTotal: "3", BathroomsTotalInteger: "2",
  CountyOrParish: "Markshire", ParcelNumber: `PARCEL-${run}-${serial}`,
  ShowingInstructions: SHOWING_MARK, LockBoxLocation: LOCKBOX_MARK, ...changes,
});
const make = (changes: Record<string, unknown> = {}) => createListing(owner, fields(changes));
const ids = (report: Report) => report.listings.map((l) => l.ListingId);
const criteria = (changes: Partial<SearchCriteria> = {}): SearchCriteria => ({
  ...DEFAULT_CRITERIA, city: CITY, statuses: [], sort: "price_low", ...changes,
});
const agentCopy = (r: unknown) => r as AgentReport;
const clientCopy = (r: unknown) => r as ClientReport;

// Three Coming Soon listings added first, then more Active ones than one search reads.
let comingSoon: Property[];
let active: Property[];

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
  comingSoon = [];
  for (let i = 0; i < 3; i++) comingSoon.push(await make({ StandardStatus: "Coming Soon" }));
  active = [];
  for (let i = 0; i < MAX_SEARCH_RESULTS + 2; i++) active.push(await make());
}, 120_000);
afterAll(() => pool.end());

describe("the copy asked for", () => {
  it("is one of the two by name, with no default", () => {
    expect(parseCopy("agent")).toBe("agent");
    expect(parseCopy("client")).toBe("client");
    for (const bad of [undefined, "", "Agent", "both", "constructor", "toString", ["client"], null]) {
      expect(parseCopy(bad), String(bad)).toBeNull();
    }
  });
});

describe("the client allowlist", () => {
  it("copies only the named fields from a listing in which every field is marked", async () => {
    const [real] = await db.select().from(property).where(eq(property.ListingKey, active[0].ListingKey));
    // Give every column a value found nowhere else.
    const marked = Object.fromEntries(
      Object.keys(real).map((column, i) => [column, `MARK-${column}-${i}`]),
    ) as unknown as Property;
    marked.StandardStatus = "Closed";
    const out = toClientListing({ listing: marked, agentName: "Agent Name", officeName: "Office Name", photoKeys: ["photo-key"] });

    const allowed = new Set<string>([...CLIENT_LISTING_FIELDS, "ClosePrice", "CloseDate"]);
    expect(Object.keys(out).sort()).toEqual([...allowed, "ListOfficeName", "ListAgentFullName", "photoUrls"].sort());
    const sent = JSON.stringify(out);
    for (const column of Object.keys(real)) {
      if (column === "StandardStatus") continue;
      expect(sent.includes(`MARK-${column}-`), column).toBe(allowed.has(column));
    }
    expect(out.photoUrls).toEqual(["/media/photo-key"]);
  });

  it("gives a close price and date only for a closed listing", () => {
    const listing = { ...active[0], StandardStatus: "Pending", ClosePrice: 123456, CloseDate: "2026-02-02" };
    const out = toClientListing({ listing, agentName: "A", officeName: "O", photoKeys: [] });
    expect([out.ClosePrice, out.CloseDate]).toEqual([null, null]);
  });
});

describe("a single listing", () => {
  it("as a client copy carries nothing restricted, whoever asks", async () => {
    // One well away from the cheapest ten, which the search tests count.
    const listing = active[60];
    await addDocument(owner, listing.ListingKey, {
      bytes: Buffer.from("%PDF-1.4\n% test\n%%EOF\n"), name: DOCUMENT_MARK, permission: "Private",
    });
    await updateListing(who.staff, listing.ListingKey, { ...fields(), ListPrice: "410000", StreetNumber: listing.StreetNumber }, REASON_MARK);
    for (const viewer of [owner, who.sameOffice, who.otherOffice, who.staff]) {
      const report = clientCopy(await listingReport(viewer, listing.ListingKey, "client"));
      expect(report.copy).toBe("client");
      const sent = JSON.stringify(report);
      for (const mark of [SHOWING_MARK, LOCKBOX_MARK, DOCUMENT_MARK, REASON_MARK, "Markshire", `PARCEL-${run}`]) {
        expect(sent, `${viewer.MemberMlsId} ${mark}`).not.toContain(mark);
      }
      for (const key of [listing.ListingKey, listing.ListAgentKey, listing.ListOfficeKey, owner.MemberMlsId]) {
        if (viewer === owner && key === owner.MemberMlsId) continue;
        expect(sent, `${viewer.MemberMlsId} key`).not.toContain(key);
      }
      expect(sent).not.toMatch(/daysOnMarket|OriginalListPrice|showing|title/);
      // The requesting member's own details, and the listing side by name only.
      expect(report.preparedBy.email).toBe(viewer.MemberEmail);
      expect(report.listings[0].ListAgentFullName).toBe(owner.MemberFullName);
      expect(sent.split(owner.MemberEmail).length - 1).toBe(viewer === owner ? 1 : 0);
    }
  });

  it("as an agent copy shows showing details only to a member who may see them", async () => {
    // A canceled listing's showing details are for the listing side and staff only.
    const listing = await make();
    await updateListing(owner, listing.ListingKey, { ...fields(), StreetNumber: listing.StreetNumber, StandardStatus: "Canceled" });
    for (const [viewer, may] of [[owner, true], [who.sameOffice, true], [who.staff, true], [who.otherOffice, false]] as const) {
      const report = agentCopy(await listingReport(viewer, listing.ListingKey, "agent"));
      const sent = JSON.stringify(report);
      expect(sent.includes(SHOWING_MARK), viewer.MemberMlsId).toBe(may);
      expect(sent.includes(LOCKBOX_MARK), viewer.MemberMlsId).toBe(may);
      expect(report.listings[0].showing === null).toBe(!may);
      expect(report.listings[0].ParcelNumber).toContain(`PARCEL-${run}`);
    }
  });

  it("never carries history or documents, even for staff", async () => {
    const sent = JSON.stringify(await listingReport(who.staff, active[60].ListingKey, "agent"));
    expect(sent).not.toContain(DOCUMENT_MARK);
    expect(sent).not.toContain(REASON_MARK);
  });

  it("refuses a client copy for a status not given to clients, and still allows the agent copy", async () => {
    expect(await listingReport(owner, comingSoon[0].ListingKey, "client")).toEqual({ refused: "status", status: "Coming Soon" });
    expect(agentCopy(await listingReport(owner, comingSoon[0].ListingKey, "agent")).listings).toHaveLength(1);
  });

  it("gives nothing to a suspended or signed-out viewer, or for a listing that does not exist", async () => {
    for (const viewer of [who.ownerSuspended, who.suspendedStaff, null]) {
      for (const copy of ["agent", "client"] as const) {
        expect(await listingReport(viewer, active[0].ListingKey, copy)).toBeNull();
        expect(await searchReport(viewer, criteria(), copy)).toBeNull();
      }
    }
    expect(await listingReport(owner, NO_SUCH_KEY, "agent")).toBeNull();
    expect(await listingReport(owner, "not-a-key", "client")).toBeNull();
  });
});

describe("a collection report", () => {
  let key: string;
  // 3 Coming Soon first, then 52 Active: 55 listings in the order added.
  const members = () => [...comingSoon, ...active.slice(0, MAX_LISTINGS_PER_REPORT + 2)];

  beforeAll(async () => {
    key = (await createCollection(owner, `Report collection ${run}`)).CollectionKey;
    for (const listing of members()) await addToCollection(owner, key, [listing.ListingKey]);
  }, 60_000);

  it("as an agent copy keeps the order added and says how many of the counted total it shows", async () => {
    const report = agentCopy(await collectionReport(owner, key, "agent"));
    expect(ids(report)).toEqual(members().slice(0, MAX_LISTINGS_PER_REPORT).map((l) => l.ListingId));
    expect(report.title).toBe(`Report collection ${run}`);
    expect(disclosureLines(report)).toEqual([`Showing the first ${MAX_LISTINGS_PER_REPORT} of 55 listings.`]);
  });

  it("as a client copy applies status before the limit, and reports the two kinds of omission apart", async () => {
    const report = clientCopy(await collectionReport(owner, key, "client"));
    // The three ineligible listings do not use up places: the 50 start at the first Active one.
    expect(ids(report)).toEqual(active.slice(0, MAX_LISTINGS_PER_REPORT).map((l) => l.ListingId));
    expect(disclosureLines(report)).toEqual([
      `Showing the first ${MAX_LISTINGS_PER_REPORT} of 52 listings.`,
      "3 listings in this collection are not included: client copies include only Active, Active Under Contract, Pending, Closed listings.",
    ]);
    const sent = JSON.stringify(report);
    for (const mark of [SHOWING_MARK, LOCKBOX_MARK, `Report collection ${run}`, key, "Markshire"]) expect(sent).not.toContain(mark);
  });

  it("shows showing details in an agent copy only where each listing allows this member", async () => {
    const mine = agentCopy(await collectionReport(owner, key, "agent"));
    expect(mine.listings.every((l) => l.showing?.ShowingInstructions === SHOWING_MARK)).toBe(true);
    // Another office's agent has their own collection of the same listings, one of them canceled.
    const canceled = await make();
    await updateListing(owner, canceled.ListingKey, { ...fields(), StreetNumber: canceled.StreetNumber, StandardStatus: "Canceled" });
    const theirs = (await createCollection(who.otherOffice, `Other office ${run}`)).CollectionKey;
    await addToCollection(who.otherOffice, theirs, [active[0].ListingKey, canceled.ListingKey]);
    const report = agentCopy(await collectionReport(who.otherOffice, theirs, "agent"));
    expect(report.listings.map((l) => l.showing?.ShowingInstructions ?? null)).toEqual([SHOWING_MARK, null]);
  });

  it("answers for someone else's collection exactly as for one that does not exist", async () => {
    for (const viewer of [who.sameOffice, who.otherOffice, who.staff, who.ownerSuspended, null]) {
      for (const copy of ["agent", "client"] as const) {
        expect(await collectionReport(viewer, key, copy)).toBeNull();
        expect(await collectionReport(viewer, NO_SUCH_KEY, copy)).toBeNull();
      }
    }
  });
});

describe("a search report", () => {
  it("keeps the search's order and claims no total when the search itself was cut off", async () => {
    const report = agentCopy(await searchReport(owner, criteria(), "agent"));
    const prices = report.listings.map((l) => l.ListPrice);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(report.listings).toHaveLength(MAX_LISTINGS_PER_REPORT);
    expect(report.disclosure.totalIsExact).toBe(false);
    const lines = disclosureLines(report);
    expect(lines).toEqual([
      `Showing the first ${MAX_LISTINGS_PER_REPORT} listings. More listings match this search than the ${MAX_SEARCH_RESULTS} it read, so this report is incomplete and the total is not known.`,
    ]);
    expect(lines.join(" ")).not.toMatch(/ of \d+ listings/);
  });

  it("as a client copy leaves out ineligible statuses before the limit and counts them only among what was read", async () => {
    // The three Coming Soon listings are the cheapest, so they are among the 100 read.
    const report = clientCopy(await searchReport(owner, criteria(), "client"));
    expect(report.listings).toHaveLength(MAX_LISTINGS_PER_REPORT);
    expect(report.listings.every((l) => l.StandardStatus !== "Coming Soon")).toBe(true);
    expect(disclosureLines(report)[1]).toBe(
      `3 listings among the ${MAX_SEARCH_RESULTS} read are not included: client copies include only Active, Active Under Contract, Pending, Closed listings.`,
    );
  });

  it("states an exact total when every match was read", async () => {
    // The ten cheapest: three Coming Soon and seven Active.
    const narrow = criteria({ maxPrice: 300000 + 10 * 1000 });
    const agent = agentCopy(await searchReport(owner, narrow, "agent"));
    expect(agent.listings).toHaveLength(10);
    expect(disclosureLines(agent)).toEqual([]);
    const client = clientCopy(await searchReport(owner, narrow, "client"));
    expect(client.listings).toHaveLength(7);
    expect(disclosureLines(client)).toEqual([
      "3 listings matching this search are not included: client copies include only Active, Active Under Contract, Pending, Closed listings.",
    ]);
  });

  it("is run for the member asking: 'mine' means their own listings", async () => {
    const mine = criteria({ mine: true, maxPrice: 300000 + 10 * 1000 });
    expect(agentCopy(await searchReport(owner, mine, "agent")).listings).toHaveLength(10);
    expect(agentCopy(await searchReport(who.otherOffice, mine, "agent")).listings).toHaveLength(0);
  });
});
