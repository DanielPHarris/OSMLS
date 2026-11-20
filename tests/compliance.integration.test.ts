/*
 * The compliance workflow against the test database, by direct call: who may
 * raise, see and close a flag; that who raised it never reaches the listing
 * side; the two limits, including under simultaneous submissions; and the
 * relisting link, including what a named listing does and does not override.
 */
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { flag, historyTransactional, member, office, property, relistingLink, type Member } from "../src/db/schema";
import { closeFlag, flagsOnListing, getRelistingLink, listFlags, raiseFlag, setRelistingLink } from "../src/lib/compliance";
import { createListing, getHistory, updateListing } from "../src/lib/listings";
import { FLAG_CATEGORIES } from "../src/lib/lookups";
import { getMarketTimeline } from "../src/lib/market-research";
import { getMarketTime, latestSettings } from "../src/lib/market-time";
import { createMember, setCapabilities, setMemberStatus } from "../src/lib/members";
import { collectionReport, listingReport } from "../src/lib/reports";
import { MAX_FLAGS_PER_MEMBER_PER_DAY, MAX_FLAG_TEXT_LENGTH } from "../src/lib/rules/local";
import { STARTING_MARKET_TIME_SETTINGS, type MarketTimeSettings } from "../src/lib/rules/market-time";
import { addToCollection, createCollection } from "../src/lib/saved-work";
import { saveMarketTimeSettings } from "../src/lib/settings";
import { createShare, getSharedPage } from "../src/lib/shares";
import { AUTHORITY_TURN, overlapping } from "./overlap";

const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
let admin: Member;
let listingAgent: Member;
let sameOffice: Member;
let otherAgent: Member;
let suspendedAgent: Member;
let offices: { harbor: string; summit: string };
let serial = 0;
const smtp = process.env.SMTP_URL;

const fresh = async (m: Member) => (await db.select().from(member).where(eq(member.MemberKey, m.MemberKey)))[0];
/** A new member, so that one test's flags never count against another's daily limit. */
async function newMember(changes: Record<string, string> = {}) {
  const n = ++serial;
  const made = await createMember(admin, {
    firstName: "Flagger", lastName: `Number${n}`, email: `flagger-${run}-${n}@osmls.example`, memberId: `C${run}-${n}`,
    role: "agent", officeKey: offices.harbor, phone: "", ...changes,
  });
  return made.member;
}
async function staffWithout() {
  const made = await newMember({ role: "staff", officeKey: "" });
  await setCapabilities(admin, made.MemberKey, ["members", "offices", "settings", "staff"], "everything but compliance");
  return fresh(made);
}
async function complianceStaff() {
  const made = await newMember({ role: "staff", officeKey: "" });
  await setCapabilities(admin, made.MemberKey, ["compliance"], "compliance only");
  return fresh(made);
}

// Early afternoon in the Pacific time zone, so the calendar date there is the date given.
const on = (date: string) => new Date(`${date}T21:00:00Z`);
type Step = [status: string, date: string];
type Options = { agent?: Member; parcel?: string | null; street?: string };
const fields = (status: string, options: Options, date?: string) => ({
  StandardStatus: status, PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
  StreetNumber: "1", StreetName: options.street ?? `Compliance Rd ${run}-${++serial}`, City: `Compliance${run}`, StateOrProvince: "WA", PostalCode: "98995",
  BedroomsTotal: "3", BathroomsTotalInteger: "2", CountyOrParish: "Test County",
  ParcelNumber: options.parcel === undefined ? `C${run}-${++serial}` : (options.parcel ?? ""),
  ...(status === "Closed" ? { ClosePrice: "495000", CloseDate: date } : {}),
});
/** Enters a listing and takes it through status changes on the dates given. */
async function listing(steps: Step[] = [["Active", "2026-03-01"]], options: Options = {}) {
  const agent = options.agent ?? listingAgent;
  const [[firstStatus, firstDate], ...rest] = steps;
  const created = await createListing(agent, fields(firstStatus, options, firstDate), { at: on(firstDate) });
  const same = { street: created.StreetName, parcel: created.ParcelNumber };
  for (const [status, date] of rest) await updateListing(agent, created.ListingKey, fields(status, same, date), null, { at: on(date) });
  return created;
}
const figures = async (key: string, asOf: string) => {
  const found = (await getMarketTime([key], { asOf: on(asOf) })).get(key)!;
  return { dom: found.daysOnMarket, cdom: found.cumulativeDaysOnMarket, continues: found.continues };
};
async function change(changes: Partial<MarketTimeSettings>) {
  const { version, ...now } = await latestSettings();
  return saveMarketTimeSettings(admin, { ...now, ...changes }, version, "test");
}
const about = (n: number) => ({ category: FLAG_CATEGORIES[n % FLAG_CATEGORIES.length], description: `Flag ${run}-${++serial}` });

beforeAll(async () => {
  delete process.env.SMTP_URL;
  const members = await db.select().from(member);
  const byId = (id: string) => members.find((m) => m.MemberMlsId === id)!;
  admin = byId("ST0001");
  listingAgent = byId("AG2001");
  sameOffice = byId("AG2002");
  otherAgent = byId("AG1002");
  suspendedAgent = byId("AG1099");
  offices = { harbor: byId("AG1001").OfficeKey!, summit: listingAgent.OfficeKey! };
});
// Every test leaves the starting settings in force, which the other test files' figures assume.
afterEach(async () => {
  await change(STARTING_MARKET_TIME_SETTINGS);
});
afterAll(async () => {
  process.env.SMTP_URL = smtp;
  await db.update(member).set({ MemberStatus: "Inactive", OsmlsCapabilities: [] }).where(like(member.MemberMlsId, `C${run}-%`));
  await pool.end();
});

describe("raising a flag", () => {
  it("is open to any active member on any listing, and to no one else", async () => {
    const l = await listing();
    const agentFromElsewhere = await newMember();
    const staffMember = await staffWithout();
    for (const viewer of [agentFromElsewhere, staffMember, listingAgent]) {
      const raised = await raiseFlag(viewer, l.ListingKey, about(0));
      expect(raised).toMatchObject({ State: "Open", RaisedByMemberKey: viewer.MemberKey, ClosedByMemberKey: null, ClosingNote: null });
    }
    for (const viewer of [suspendedAgent, { ...agentFromElsewhere, MemberStatus: "Inactive" }, null])
      await expect(raiseFlag(viewer, l.ListingKey, about(0))).rejects.toThrow("Not found.");
    await expect(raiseFlag(agentFromElsewhere, NO_SUCH_KEY, about(1))).rejects.toThrow("Not found.");
    await expect(raiseFlag(agentFromElsewhere, "not-a-key", about(1))).rejects.toThrow("Not found.");
  });

  it("needs a listed category and a description of a sensible length", async () => {
    const l = await listing();
    const by = await newMember();
    await expect(raiseFlag(by, l.ListingKey, { category: "Fines", description: "x" })).rejects.toThrow("Choose what the flag is about.");
    await expect(raiseFlag(by, l.ListingKey, { category: "Other", description: "   " })).rejects.toThrow("Describe the problem.");
    await expect(raiseFlag(by, l.ListingKey, { category: "Other", description: "x".repeat(MAX_FLAG_TEXT_LENGTH + 1) })).rejects.toThrow(/characters or fewer/);
    await raiseFlag(by, l.ListingKey, { category: "Other", description: "x".repeat(MAX_FLAG_TEXT_LENGTH) });
    expect(await db.select().from(flag).where(eq(flag.RaisedByMemberKey, by.MemberKey))).toHaveLength(1);
  });

  it("changes nothing about the listing, when raised and when closed", async () => {
    const l = await listing();
    const state = async () => ({
      listing: (await db.select().from(property).where(eq(property.ListingKey, l.ListingKey)))[0],
      history: (await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, l.ListingKey))).length,
      figures: await figures(l.ListingKey, "2026-04-01"),
    });
    const before = await state();
    const raised = await raiseFlag(await newMember(), l.ListingKey, about(0));
    expect(await state()).toEqual(before);
    await closeFlag(admin, raised.FlagKey, "Resolved", "Nothing to change");
    expect(await state()).toEqual(before);
  });
});

describe("who is shown a flag", () => {
  it("shows the listing side every flag on their listing, the reporter their own, and anyone else none", async () => {
    const l = await listing();
    const reporter = await newMember();
    const second = await newMember();
    const one = await raiseFlag(reporter, l.ListingKey, { category: "Photos", description: `First ${run}` });
    const two = await raiseFlag(second, l.ListingKey, { category: "Remarks", description: `Second ${run}` });
    const keys = async (viewer: Member | null) => (await flagsOnListing(viewer, l.ListingKey)).map((f) => f.flagKey).sort();
    const both = [one.FlagKey, two.FlagKey].sort();

    expect(await keys(listingAgent)).toEqual(both);
    expect(await keys(sameOffice)).toEqual(both);
    expect(await keys(admin)).toEqual(both);
    expect(await keys(reporter)).toEqual([one.FlagKey]);
    expect(await keys(second)).toEqual([two.FlagKey]);
    for (const viewer of [otherAgent, await staffWithout(), suspendedAgent, { ...listingAgent, MemberStatus: "Inactive" }, null]) expect(await keys(viewer)).toEqual([]);
    expect(await flagsOnListing(listingAgent, NO_SUCH_KEY)).toEqual([]);

    // "mine" marks only the viewer's own.
    expect((await flagsOnListing(reporter, l.ListingKey)).map((f) => f.mine)).toEqual([true]);
    expect((await flagsOnListing(listingAgent, l.ListingKey)).map((f) => f.mine)).toEqual([false, false]);
    // A reporter who is suspended is shown nothing, and their flag stays for staff.
    await setMemberStatus(admin, second.MemberKey, "Inactive", "test");
    expect(await keys(await fresh(second))).toEqual([]);
    expect(await keys(admin)).toEqual(both);
  });

  it("gives the listing side no part of who raised a flag or who closed it", async () => {
    const l = await listing();
    const reporter = await newMember({ firstName: "Quillon", lastName: `Reporter${run}`, phone: "555-0142" });
    const closer = await complianceStaff();
    const raised = await raiseFlag(reporter, l.ListingKey, { category: "Remarks", description: `Remarks problem ${run}` });
    await closeFlag(closer, raised.FlagKey, "Resolved", `Looked into ${run}`);
    const [reporterOffice] = await db.select().from(office).where(eq(office.OfficeKey, reporter.OfficeKey!));
    const traces = [
      reporter.MemberKey, reporter.MemberMlsId, reporter.MemberEmail, reporter.MemberFirstName, reporter.MemberLastName, reporter.OsmlsUserId,
      reporterOffice.OfficeName, reporterOffice.OfficeKey, closer.MemberKey, closer.MemberMlsId, closer.MemberEmail, closer.MemberLastName,
    ];
    for (const viewer of [listingAgent, sameOffice]) {
      const given = await flagsOnListing(viewer, l.ListingKey);
      expect(given).toHaveLength(1);
      // Exactly these fields: nothing was hidden, because nothing else was ever put in.
      expect(Object.keys(given[0]).sort()).toEqual(["category", "closedAt", "closingNote", "description", "flagKey", "mine", "raisedAt", "state"]);
      expect(given[0]).toMatchObject({ description: `Remarks problem ${run}`, closingNote: `Looked into ${run}`, state: "Resolved" });
      const text = JSON.stringify(given);
      for (const trace of traces) expect(text.includes(trace), trace).toBe(false);
    }
    // The reporter is told the outcome and not who closed it.
    const theirs = JSON.stringify(await flagsOnListing(reporter, l.ListingKey));
    for (const trace of [closer.MemberKey, closer.MemberMlsId, closer.MemberEmail, closer.MemberLastName]) expect(theirs.includes(trace), trace).toBe(false);
    // Compliance staff are told both.
    const [detail] = (await listFlags(admin, { listing: l.ListingKey }))!;
    expect(detail.raisedBy).toEqual({ name: reporter.MemberFullName, memberId: reporter.MemberMlsId, email: reporter.MemberEmail, officeName: reporterOffice.OfficeName });
    expect(detail.closedBy).toBe(closer.MemberFullName);
  });

  it("keeps flags out of agent copies, client copies, and pages shared with clients", async () => {
    const l = await listing();
    const description = `Never on a report ${run}`;
    const note = `Nor this note ${run}`;
    const raised = await raiseFlag(await newMember(), l.ListingKey, { category: "Photos", description });
    await raiseFlag(listingAgent, l.ListingKey, { category: "Other", description });
    await closeFlag(admin, raised.FlagKey, "Dismissed", note);
    const collection = await createCollection(listingAgent, `Compliance ${run}`);
    await addToCollection(listingAgent, collection.CollectionKey, [l.ListingKey]);
    const token = (await createShare(listingAgent, { listing: l.ListingKey }, {})).link.split("/").pop()!;
    const outputs = {
      "agent copy": await listingReport(listingAgent, l.ListingKey, "agent"),
      "client copy": await listingReport(listingAgent, l.ListingKey, "client"),
      "staff agent copy": await listingReport(admin, l.ListingKey, "agent"),
      "collection agent copy": await collectionReport(listingAgent, collection.CollectionKey, "agent"),
      "collection client copy": await collectionReport(listingAgent, collection.CollectionKey, "client"),
      "shared page": await getSharedPage(token),
    };
    for (const [name, output] of Object.entries(outputs)) {
      expect(output, name).not.toBeNull();
      const text = JSON.stringify(output);
      expect(text.includes(l.ListingId), name).toBe(true);
      for (const absent of [description, note, raised.FlagKey, "Dismissed"]) expect(text.includes(absent), `${name}: ${absent}`).toBe(false);
    }
  });

  it("gives compliance staff the queue, narrowed by state, category, office and listing", async () => {
    const harbor = await listing(undefined, { agent: otherAgent });
    const summit = await listing();
    const reporter = await newMember();
    const a = await raiseFlag(reporter, harbor.ListingKey, { category: "Photos", description: `Queue ${run} a` });
    const b = await raiseFlag(reporter, summit.ListingKey, { category: "Remarks", description: `Queue ${run} b` });
    await closeFlag(admin, b.FlagKey, "Dismissed", "No problem found");
    const mine = async (filters: Parameters<typeof listFlags>[1]) =>
      (await listFlags(admin, filters))!.filter((f) => f.description.startsWith(`Queue ${run}`)).map((f) => f.flagKey).sort();
    expect(await mine({})).toEqual([a.FlagKey, b.FlagKey].sort());
    expect(await mine({ state: "Open" })).toEqual([a.FlagKey]);
    expect(await mine({ state: "Dismissed" })).toEqual([b.FlagKey]);
    expect(await mine({ category: "Remarks" })).toEqual([b.FlagKey]);
    expect(await mine({ office: offices.harbor })).toEqual([a.FlagKey]);
    expect(await mine({ listing: summit.ListingKey })).toEqual([b.FlagKey]);
    // Something that is not a state or a category narrows nothing, rather than matching nothing.
    expect(await mine({ state: "constructor", category: "x" })).toEqual([a.FlagKey, b.FlagKey].sort());
    const [first] = (await listFlags(admin, { listing: harbor.ListingKey }))!;
    expect(first).toMatchObject({ listingId: harbor.ListingId, address: harbor.UnparsedAddress, state: "Open", closedBy: null });
  });
});

describe("the limits on raising flags", () => {
  it("allows one open flag per member, per listing, per category", async () => {
    const l = await listing();
    const other = await listing();
    const by = await newMember();
    const first = await raiseFlag(by, l.ListingKey, { category: "Photos", description: "one" });
    await expect(raiseFlag(by, l.ListingKey, { category: "Photos", description: "again" })).rejects.toThrow('You already have an open flag on this listing about "Photos".');
    // Another category, another listing, and another member are each a different flag.
    await raiseFlag(by, l.ListingKey, { category: "Remarks", description: "two" });
    await raiseFlag(by, other.ListingKey, { category: "Photos", description: "three" });
    await raiseFlag(await newMember(), l.ListingKey, { category: "Photos", description: "four" });
    // Once it is closed, the same member may raise the same kind again.
    await closeFlag(admin, first.FlagKey, "Resolved", "Fixed");
    await raiseFlag(by, l.ListingKey, { category: "Photos", description: "back again" });
  });

  it("stores one of several identical flags sent at the same moment", async () => {
    const l = await listing();
    for (let round = 0; round < 3; round++) {
      const by = await newMember();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => raiseFlag(by, l.ListingKey, { category: "Photos", description: "same moment" })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason.message).toBe('You already have an open flag on this listing about "Photos".');
      expect(await db.select().from(flag).where(eq(flag.RaisedByMemberKey, by.MemberKey))).toHaveLength(1);
    }
  });

  /** As many different flags as asked for: no two share a listing and a category. */
  async function distinct(count: number) {
    const listings = await Promise.all(Array.from({ length: Math.ceil(count / FLAG_CATEGORIES.length) }, () => listing()));
    return Array.from({ length: count }, (_, n) => ({ listingKey: listings[Math.floor(n / FLAG_CATEGORIES.length)].ListingKey, input: about(n) }));
  }

  it(`stops at ${MAX_FLAGS_PER_MEMBER_PER_DAY} in a day, and closing flags does not give any back`, async () => {
    const by = await newMember();
    const flags = await distinct(MAX_FLAGS_PER_MEMBER_PER_DAY + 1);
    const raised = [];
    for (const f of flags.slice(0, MAX_FLAGS_PER_MEMBER_PER_DAY)) raised.push(await raiseFlag(by, f.listingKey, f.input));
    const last = flags[MAX_FLAGS_PER_MEMBER_PER_DAY];
    const message = `You have raised ${MAX_FLAGS_PER_MEMBER_PER_DAY} flags today, which is the most allowed in a day.`;
    await expect(raiseFlag(by, last.listingKey, last.input)).rejects.toThrow(message);
    await closeFlag(admin, raised[0].FlagKey, "Dismissed", "test");
    await expect(raiseFlag(by, last.listingKey, last.input)).rejects.toThrow(message);
    // Someone else's day is their own.
    await raiseFlag(await newMember(), last.listingKey, last.input);
  });

  it("stores exactly the day's limit when more than that are sent at the same moment", async () => {
    const by = await newMember();
    const flags = await distinct(MAX_FLAGS_PER_MEMBER_PER_DAY + 8);
    const results = await Promise.allSettled(flags.map((f) => raiseFlag(by, f.listingKey, f.input)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_FLAGS_PER_MEMBER_PER_DAY);
    expect(await db.select().from(flag).where(eq(flag.RaisedByMemberKey, by.MemberKey))).toHaveLength(MAX_FLAGS_PER_MEMBER_PER_DAY);
  });

  it("starts a new day at midnight in the MLS time zone", async () => {
    // Midnight in New York on 15 January is 05:00 UTC. In the starting zone, Pacific, both moments below are the 14th.
    await change({ timeZone: "America/New_York" });
    const beforeMidnight = new Date("2026-01-15T04:59:00Z");
    const afterMidnight = new Date("2026-01-15T05:01:00Z");
    const by = await newMember();
    const flags = await distinct(MAX_FLAGS_PER_MEMBER_PER_DAY + 2);
    for (const f of flags.slice(0, MAX_FLAGS_PER_MEMBER_PER_DAY)) await raiseFlag(by, f.listingKey, f.input, { at: beforeMidnight });
    const [next, another] = flags.slice(MAX_FLAGS_PER_MEMBER_PER_DAY);
    await expect(raiseFlag(by, next.listingKey, next.input, { at: beforeMidnight })).rejects.toThrow(/most allowed in a day/);
    const tomorrow = await raiseFlag(by, next.listingKey, next.input, { at: afterMidnight });
    expect(tomorrow.RaisedDate).toBe("2026-01-15");

    // In the Pacific zone the same two moments are one day, so there the limit would still hold.
    await change({ timeZone: "America/Los_Angeles" });
    const pacific = await newMember();
    for (const f of flags.slice(0, MAX_FLAGS_PER_MEMBER_PER_DAY)) await raiseFlag(pacific, f.listingKey, f.input, { at: beforeMidnight });
    await expect(raiseFlag(pacific, another.listingKey, another.input, { at: afterMidnight })).rejects.toThrow(/most allowed in a day/);
  });
});

describe("closing a flag", () => {
  it("records who closed it, when, and the note, and is final", async () => {
    const l = await listing();
    const closer = await complianceStaff();
    const raised = await raiseFlag(await newMember(), l.ListingKey, about(0));
    await expect(closeFlag(closer, raised.FlagKey, "Open", "note")).rejects.toThrow("Choose Resolved or Dismissed.");
    await expect(closeFlag(closer, raised.FlagKey, "Resolved", "  ")).rejects.toThrow("Give a closing note.");
    await expect(closeFlag(closer, raised.FlagKey, "Resolved", "x".repeat(MAX_FLAG_TEXT_LENGTH + 1))).rejects.toThrow(/Keep the note/);
    await expect(closeFlag(closer, NO_SUCH_KEY, "Resolved", "note")).rejects.toThrow("Not found.");

    await closeFlag(closer, raised.FlagKey, "Resolved", "Photo replaced by the listing agent");
    const [closed] = await db.select().from(flag).where(eq(flag.FlagKey, raised.FlagKey));
    expect(closed).toMatchObject({ State: "Resolved", ClosedByMemberKey: closer.MemberKey, ClosingNote: "Photo replaced by the listing agent" });
    expect(Date.now() - closed.ClosedTimestamp!.getTime()).toBeLessThan(60_000);

    for (const state of ["Resolved", "Dismissed"])
      await expect(closeFlag(admin, raised.FlagKey, state, "again")).rejects.toThrow("This flag has already been closed. A closed flag is final.");
    expect((await db.select().from(flag).where(eq(flag.FlagKey, raised.FlagKey)))[0]).toEqual(closed);
  });

  it("closes a flag once when two staff close it at the same moment", async () => {
    const l = await listing();
    const [a, b] = [await complianceStaff(), await complianceStaff()];
    for (let round = 0; round < 5; round++) {
      const raised = await raiseFlag(await newMember(), l.ListingKey, about(round));
      const results = await Promise.allSettled([closeFlag(a, raised.FlagKey, "Resolved", "a"), closeFlag(b, raised.FlagKey, "Dismissed", "b")]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const [now] = await db.select().from(flag).where(eq(flag.FlagKey, raised.FlagKey));
      // Whichever won, the state, the note and the name agree with each other.
      expect([["Resolved", "a", a.MemberKey], ["Dismissed", "b", b.MemberKey]]).toContainEqual([now.State, now.ClosingNote, now.ClosedByMemberKey]);
    }
  });
});

describe("which earlier listing a listing continues", () => {
  /** A listing canceled after 60 days, and a second 10 days later that has been on the market 30 days by 11 April. */
  async function pair(second: Options = {}, first: Options = {}) {
    const street = `Linked Rd ${run}-${++serial}`;
    const parcel = `L${run}-${serial}`;
    const earlier = await listing([["Active", "2026-01-01"], ["Canceled", "2026-03-02"]], { street, parcel, ...first });
    const later = await listing([["Active", "2026-03-12"]], { street, parcel, ...second });
    return { earlier, later };
  }
  const ASOF = "2026-04-11";
  const link = (later: { ListingKey: string }, input: { mode: string; listingId?: string }, reason = "test") => setRelistingLink(admin, later.ListingKey, input, reason);

  it("is found by matching unless staff say otherwise, and goes back to matching when they withdraw it", async () => {
    const { earlier, later } = await pair();
    expect(await getRelistingLink(admin, later.ListingKey)).toEqual({ mode: "automatic", listingId: null });
    expect(await figures(later.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 90, continues: [earlier.ListingId] });

    await link(later, { mode: "none" });
    expect(await getRelistingLink(admin, later.ListingKey)).toEqual({ mode: "none", listingId: null });
    expect(await figures(later.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 30, continues: [] });
    // The earlier listing's own figures are not touched.
    expect(await figures(earlier.ListingKey, ASOF)).toMatchObject({ dom: 60, cdom: 60 });

    await link(later, { mode: "automatic" });
    expect(await getRelistingLink(admin, later.ListingKey)).toEqual({ mode: "automatic", listingId: null });
    expect(await db.select().from(relistingLink).where(eq(relistingLink.ListingKey, later.ListingKey))).toEqual([]);
    expect(await figures(later.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 90, continues: [earlier.ListingId] });
  });

  it("lets a named listing repair a match that parcel and address both missed, whatever the address-fallback setting", async () => {
    // Two parcels and two spellings of the street: nothing matches them.
    const { earlier, later } = await pair({ street: `Oak Street ${run}`, parcel: `M${run}-b` }, { street: `Oak St ${run}`, parcel: `M${run}-a` });
    expect(await figures(later.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 30, continues: [] });
    await link(later, { mode: "named", listingId: earlier.ListingId });
    expect(await getRelistingLink(admin, later.ListingKey)).toEqual({ mode: "named", listingId: earlier.ListingId });
    expect(await figures(later.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 90, continues: [earlier.ListingId] });
    await change({ addressFallback: false });
    expect(await figures(later.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 90, continues: [earlier.ListingId] });
  });

  it("still applies the gap, the gap endpoint, and the brokerage rule to a named listing", async () => {
    const named = async (second: Options = {}, secondSteps?: Step[]) => {
      const street = `Named Rd ${run}-${++serial}`;
      const earlier = await listing([["Active", "2026-01-01"], ["Canceled", "2026-03-02"]], { street: `${street} a` });
      const later = await listing(secondSteps ?? [["Active", "2026-03-12"]], { street: `${street} b`, ...second });
      await link(later, { mode: "named", listingId: earlier.ListingId });
      return later;
    };
    const plain = await named();
    const otherBrokerage = await named({ agent: otherAgent });
    // Entered 10 days after the cancellation, but not on the market until 44 days after it.
    const lateToMarket = await named({}, [["Coming Soon", "2026-03-12"], ["Active", "2026-04-15"]]);

    expect((await figures(plain.ListingKey, ASOF)).cdom).toBe(90);
    expect((await figures(otherBrokerage.ListingKey, ASOF)).cdom).toBe(90);
    expect((await figures(lateToMarket.ListingKey, "2026-05-15")).cdom).toBe(90);

    await change({ relistingGapDays: 10 });
    expect(await figures(plain.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 30, continues: [] });
    await change({ relistingGapDays: 30, brokerageChangeResets: true });
    expect((await figures(plain.ListingKey, ASOF)).cdom).toBe(90);
    expect((await figures(otherBrokerage.ListingKey, ASOF)).cdom).toBe(30);
    await change({ brokerageChangeResets: false, gapEndpoint: "onMarket" });
    expect((await figures(lateToMarket.ListingKey, "2026-05-15")).cdom).toBe(30);
    // The link itself is still on record; only the count stopped following it.
    expect((await getRelistingLink(admin, plain.ListingKey))!.mode).toBe("named");
  });

  it("does not continue a named listing that was sold, or that has not ended", async () => {
    const sold = await listing([["Active", "2026-01-01"], ["Pending", "2026-02-01"], ["Closed", "2026-03-02"]]);
    const stillActive = await listing([["Active", "2026-01-01"]]);
    for (const earlier of [sold, stillActive]) {
      const later = await listing([["Active", "2026-03-12"]]);
      await link(later, { mode: "named", listingId: earlier.ListingId });
      expect(await figures(later.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 30, continues: [] });
    }
  });

  it("refuses to link past a sale of the same property: A canceled, B sold, C new", async () => {
    const street = `Sale Rd ${run}-${++serial}`;
    const parcel = `S${run}-${serial}`;
    const a = await listing([["Active", "2025-11-01"], ["Canceled", "2025-12-31"]], { street, parcel });
    const b = await listing([["Active", "2026-01-05"], ["Pending", "2026-01-20"], ["Closed", "2026-02-20"]], { street, parcel });
    // C was typed with another parcel and street, so matching finds neither A nor B for it.
    const c = await listing([["Active", "2026-03-12"]], { street: `${street} typo`, parcel: `${parcel}-typo` });
    expect(await figures(c.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 30, continues: [] });

    const refusal = new RegExp(`Listing ${b.ListingId} is a sale of the same property between the two`);
    await expect(link(c, { mode: "named", listingId: a.ListingId })).rejects.toThrow(refusal);
    expect((await getRelistingLink(admin, c.ListingKey))!.mode).toBe("automatic");
    // Naming the sale itself is allowed and, being a sale, carries nothing forward.
    await link(c, { mode: "named", listingId: b.ListingId });
    expect(await figures(c.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 30, continues: [] });

    // If B was in truth another property, matched to A by a mistyped parcel, correcting B is the remedy.
    await updateListing(admin, b.ListingKey, { ...fields("Closed", { street: `Elsewhere Rd ${run}`, parcel: `E${run}` }, "2026-02-20") }, "B is a different property");
    await link(c, { mode: "named", listingId: a.ListingId });
    await change({ relistingGapDays: 120 });
    expect(await figures(c.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 90, continues: [a.ListingId] });
  });

  it("stops following a link once a sale of the property is entered between the two", async () => {
    const street = `Later Sale Rd ${run}-${++serial}`;
    const parcel = `LS${run}-${serial}`;
    const a = await listing([["Active", "2026-01-01"], ["Canceled", "2026-03-02"]], { street, parcel });
    // B is a second listing of the same property, entered before C and still open when the link is made.
    const b = await listing([["Active", "2026-03-05"]], { street, parcel });
    const c = await listing([["Active", "2026-03-12"]], { street: `${street} typo`, parcel: `${parcel}-typo` });
    await link(c, { mode: "named", listingId: a.ListingId });
    expect(await figures(c.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 90, continues: [a.ListingId] });

    for (const [status, date] of [["Pending", "2026-03-20"], ["Closed", "2026-04-05"]] as Step[])
      await updateListing(b.ListAgentKey === listingAgent.MemberKey ? listingAgent : admin, b.ListingKey, fields(status, { street, parcel }, date), null, { at: on(date) });
    expect(await figures(c.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 30, continues: [] });
    // The link was not removed; it is simply not followed.
    expect(await getRelistingLink(admin, c.ListingKey)).toEqual({ mode: "named", listingId: a.ListingId });
  });

  it("follows a chain of named listings, each tested in turn", async () => {
    const first = await listing([["Active", "2025-12-01"], ["Expired", "2025-12-31"]]);
    const second = await listing([["Active", "2026-01-01"], ["Canceled", "2026-03-02"]]);
    const third = await listing([["Active", "2026-03-12"]]);
    await link(second, { mode: "named", listingId: first.ListingId });
    await link(third, { mode: "named", listingId: second.ListingId });
    expect(await figures(third.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 120, continues: [second.ListingId, first.ListingId] });
    await link(second, { mode: "none" });
    expect(await figures(third.ListingKey, ASOF)).toEqual({ dom: 30, cdom: 90, continues: [second.ListingId] });
  });

  it("refuses a listing that is not earlier, the listing itself, and one that does not exist", async () => {
    const { earlier, later } = await pair();
    await expect(link(earlier, { mode: "named", listingId: later.ListingId })).rejects.toThrow(/was not entered before this one/);
    await expect(link(later, { mode: "named", listingId: later.ListingId })).rejects.toThrow("Choose a different listing.");
    await expect(link(later, { mode: "named", listingId: "999999999" })).rejects.toThrow("Enter the listing number of the earlier listing.");
    await expect(link(later, { mode: "named" })).rejects.toThrow("Enter the listing number of the earlier listing.");
    await expect(link(later, { mode: "sideways" })).rejects.toThrow("Choose automatic, none, or a listing.");
    await expect(link(later, { mode: "none" }, "  ")).rejects.toThrow("Give a reason.");
    await expect(setRelistingLink(admin, NO_SUCH_KEY, { mode: "none" }, "test")).rejects.toThrow("Not found.");
    expect(await db.select().from(relistingLink).where(eq(relistingLink.ListingKey, later.ListingKey))).toEqual([]);
    // Two listings entered at the same instant: neither is earlier.
    const twin = await listing([["Active", "2026-03-12"]]);
    const other = await listing([["Active", "2026-03-12"]]);
    await expect(link(twin, { mode: "named", listingId: other.ListingId })).rejects.toThrow(/was not entered before this one/);
  });

  it("records each change as a staff correction with its reason, and tells members only the result", async () => {
    const { earlier, later } = await pair();
    await link(later, { mode: "none" }, "Different property, same parcel typed");
    await link(later, { mode: "none" }, "Saved again without a change");
    await link(later, { mode: "named", listingId: earlier.ListingId }, "It is the same property after all");
    await link(later, { mode: "automatic" }, "Leave it to matching");
    const record = (await getHistory(later.ListingKey))
      .filter(({ entry }) => entry.FieldName === "OsmlsRelistingLink")
      .map(({ entry: e, changedByName }) => `${e.PreviousValue} → ${e.NewValue} (${e.OsmlsCorrectionReason}) staff correction: ${e.OsmlsStaffCorrection}, by ${changedByName}`)
      .reverse();
    expect(record).toEqual([
      `Automatic → None (Different property, same parcel typed) staff correction: true, by ${admin.MemberFullName}`,
      `None → Listing ${earlier.ListingId} (It is the same property after all) staff correction: true, by ${admin.MemberFullName}`,
      `Listing ${earlier.ListingId} → Automatic (Leave it to matching) staff correction: true, by ${admin.MemberFullName}`,
    ]);
    // The timeline members see is prices and statuses: nothing about the link, the reason, or who.
    await link(later, { mode: "none" }, "Secret reason");
    const timeline = JSON.stringify(await getMarketTimeline(later.ListingKey));
    for (const absent of ["Secret reason", "OsmlsRelistingLink", "None", admin.MemberFullName]) expect(timeline.includes(absent), absent).toBe(false);
    expect(await getRelistingLink(listingAgent, later.ListingKey)).toBeNull();
  });
});

describe("staff who do not hold Manage compliance", () => {
  it("are refused the queue, closing a flag, and the relisting link, exactly as if nothing were there", async () => {
    const l = await listing();
    const raised = await raiseFlag(await newMember(), l.ListingKey, about(0));
    const without = await staffWithout();
    for (const viewer of [without, otherAgent, listingAgent, suspendedAgent, null]) {
      expect(await listFlags(viewer)).toBeNull();
      expect(await getRelistingLink(viewer, l.ListingKey)).toBeNull();
      await expect(closeFlag(viewer, raised.FlagKey, "Resolved", "no")).rejects.toThrow("Not found.");
      await expect(setRelistingLink(viewer, l.ListingKey, { mode: "none" }, "no")).rejects.toThrow("Not found.");
    }
    expect((await db.select().from(flag).where(eq(flag.FlagKey, raised.FlagKey)))[0].State).toBe("Open");
    expect(await db.select().from(relistingLink).where(eq(relistingLink.ListingKey, l.ListingKey))).toEqual([]);
  });

  it("are refused a closure and a link change that were waiting when the capability was revoked", async () => {
    const losesEverything = (m: Member) => `update "Member" set "OsmlsCapabilities" = '{}' where "MemberKey" = '${m.MemberKey}'`;
    const l = await listing();
    const raised = await raiseFlag(await newMember(), l.ListingKey, about(0));

    const closer = await complianceStaff();
    const closure = await overlapping(AUTHORITY_TURN, losesEverything(closer), () => closeFlag(closer, raised.FlagKey, "Resolved", "late"));
    expect(closure).toMatchObject({ status: "rejected", reason: { message: "Not found." } });
    expect((await db.select().from(flag).where(eq(flag.FlagKey, raised.FlagKey)))[0]).toMatchObject({ State: "Open", ClosingNote: null });

    const linker = await complianceStaff();
    const linking = await overlapping(AUTHORITY_TURN, losesEverything(linker), () => setRelistingLink(linker, l.ListingKey, { mode: "none" }, "late"));
    expect(linking).toMatchObject({ status: "rejected", reason: { message: "Not found." } });
    expect(await db.select().from(relistingLink).where(eq(relistingLink.ListingKey, l.ListingKey))).toEqual([]);
    const recorded = await db
      .select()
      .from(historyTransactional)
      .where(and(eq(historyTransactional.ResourceRecordKey, l.ListingKey), eq(historyTransactional.FieldName, "OsmlsRelistingLink")));
    expect(recorded).toEqual([]);
  });
});
