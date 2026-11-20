/*
 * The market-time settings against the test database: what may be saved, that
 * a save is refused when it would undo someone else's, what is kept on record,
 * that each of the six settings changes the figures as soon as it is saved, and
 * that one operation works under one version throughout.
 *
 * Nothing here passes settings to the calculation: the figures come from
 * whatever is stored, as they do in the application.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { historyTransactional, marketTimeSettings, member, property, savedSearch, type Member } from "../src/db/schema";
import { sendDueAlerts, setAlertFrequency } from "../src/lib/alerts";
import { createListing, updateListing } from "../src/lib/listings";
import type { Mail } from "../src/lib/mail";
import { currentSettings, getMarketTime, latestSettings, withOneSettingsVersion } from "../src/lib/market-time";
import { STARTING_MARKET_TIME_SETTINGS, type MarketTimeSettings } from "../src/lib/rules/market-time";
import { createSavedSearch } from "../src/lib/saved-work";
import { DEFAULT_CRITERIA } from "../src/lib/search-criteria";
import { getSettingsHistory, saveMarketTimeSettings } from "../src/lib/settings";

const run = Date.now();
let staff: Member;
let agents: { harbor: Member; summit: Member };
let serial = 0;

// Early afternoon in the Pacific time zone, so the calendar date there is the date given.
const on = (date: string) => new Date(`${date}T21:00:00Z`);
const values = async (changes: Partial<MarketTimeSettings> = {}) => {
  const { version, ...now } = await latestSettings();
  return { version, next: { ...now, ...changes } };
};
/** Saves a change the way the Settings screen does: from the version now in force. */
async function change(changes: Partial<MarketTimeSettings>, reason = "test") {
  const { version, next } = await values(changes);
  return saveMarketTimeSettings(staff, next, version, reason);
}

type Step = [status: string, at: string | Date];
type Options = { agent?: Member; parcel?: string | null; street?: string };
/** Enters a listing and takes it through status changes at the times given. */
async function listing(steps: Step[], options: Options = {}) {
  const agent = options.agent ?? agents.harbor;
  const moment = (at: string | Date) => (typeof at === "string" ? on(at) : at);
  const fields = (status: string) => ({
    StandardStatus: status, PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
    StreetNumber: "1", StreetName: options.street ?? `Settings Rd ${run}-${++serial}`, City: `Settings${run}`, StateOrProvince: "WA", PostalCode: "98998",
    BedroomsTotal: "3", BathroomsTotalInteger: "2", CountyOrParish: "Test County",
    ParcelNumber: options.parcel === undefined ? `S${run}-${++serial}` : (options.parcel ?? ""),
  });
  const [[firstStatus, firstAt], ...rest] = steps;
  const created = await createListing(agent, fields(firstStatus), { at: moment(firstAt) });
  const same = { StreetName: created.StreetName, ParcelNumber: created.ParcelNumber ?? "" };
  for (const [status, at] of rest) await updateListing(agent, created.ListingKey, { ...fields(status), ...same }, null, { at: moment(at) });
  return created;
}
const figures = async (key: string, asOf: string | Date) => {
  const { daysOnMarket, cumulativeDaysOnMarket } = (await getMarketTime([key], { asOf: typeof asOf === "string" ? on(asOf) : asOf })).get(key)!;
  return { dom: daysOnMarket, cdom: cumulativeDaysOnMarket };
};

beforeAll(async () => {
  const members = await db.select().from(member);
  const byId = (id: string) => members.find((m) => m.MemberMlsId === id)!;
  staff = byId("ST0001");
  agents = { harbor: byId("AG1001"), summit: byId("AG2001") };
});
// Every test leaves the starting values in force, which the other test files' figures assume.
afterEach(async () => {
  await change(STARTING_MARKET_TIME_SETTINGS, "back to the starting values");
});
afterAll(async () => {
  await db.delete(savedSearch).where(like(savedSearch.SavedSearchName, `Settings ${run}%`));
  await pool.end();
});

describe("where the settings come from", () => {
  it("starts from the values the application used while they were in code", async () => {
    const [first] = await db.select().from(marketTimeSettings).where(eq(marketTimeSettings.Version, 1));
    expect(first).toMatchObject({
      AccumulatingStatuses: STARTING_MARKET_TIME_SETTINGS.accumulatingStatuses,
      RelistingGapDays: STARTING_MARKET_TIME_SETTINGS.relistingGapDays,
      BrokerageChangeResets: STARTING_MARKET_TIME_SETTINGS.brokerageChangeResets,
      AddressFallback: STARTING_MARKET_TIME_SETTINGS.addressFallback,
      GapEndpoint: STARTING_MARKET_TIME_SETTINGS.gapEndpoint,
      TimeZone: STARTING_MARKET_TIME_SETTINGS.timeZone,
      ChangedByMemberKey: null,
    });
  });

  it("has no code path that could fall back to the starting values", () => {
    // Only the file that declares them may mention them: nothing in the application reads them.
    const files = (readdirSync("src", { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const mentioning = files.filter((f) => readFileSync(join("src", f), "utf8").includes("STARTING_MARKET_TIME_SETTINGS"));
    expect(mentioning).toEqual([join("lib", "rules", "market-time.ts")]);
    expect(files.length).toBeGreaterThan(50);
  });
});

describe("saving the settings", () => {
  it("stores a new version with who, when and why, and shows what changed from the one before", async () => {
    const before = await latestSettings();
    const saved = await change({ relistingGapDays: 14, addressFallback: false }, "Board policy 2026-11");
    expect(saved).toEqual({ ...before, version: before.version + 1, relistingGapDays: 14, addressFallback: false });
    const [newest, previous] = (await getSettingsHistory(staff))!;
    expect(newest).toMatchObject({ version: saved.version, by: staff.MemberFullName, reason: "Board policy 2026-11" });
    expect(Date.now() - newest.at.getTime()).toBeLessThan(60_000);
    expect(newest.changes).toEqual([
      { label: "Relisting gap (days)", previous: "30", next: "14" },
      { label: "Match by address when there is no parcel match", previous: "Yes", next: "No" },
    ]);
    // The earlier version is still there, exactly as it was.
    expect(previous.version).toBe(before.version);
    const [kept] = await db.select().from(marketTimeSettings).where(eq(marketTimeSettings.Version, before.version));
    expect(kept.RelistingGapDays).toBe(before.relistingGapDays);
  });

  it("stores nothing when nothing changed", async () => {
    const before = await latestSettings();
    expect(await change({})).toEqual(before);
    expect(await latestSettings()).toEqual(before);
  });

  it("needs a reason", async () => {
    const before = await latestSettings();
    await expect(change({ relistingGapDays: 14 }, "   ")).rejects.toThrow("Give a reason.");
    expect(await latestSettings()).toEqual(before);
  });

  it("refuses values outside the limits, naming the setting", async () => {
    const before = await latestSettings();
    const refusals: [Record<string, unknown>, string][] = [
      [{ accumulatingStatuses: [] }, "accumulatingStatuses"],
      [{ accumulatingStatuses: ["Active", "Closed"] }, "accumulatingStatuses"],
      [{ accumulatingStatuses: ["Active", "Canceled"] }, "accumulatingStatuses"],
      [{ accumulatingStatuses: ["Active", "Expired"] }, "accumulatingStatuses"],
      [{ accumulatingStatuses: ["Active", "Withdrawn"] }, "accumulatingStatuses"],
      [{ accumulatingStatuses: ["Active", "Sold"] }, "accumulatingStatuses"],
      [{ relistingGapDays: -1 }, "relistingGapDays"],
      [{ relistingGapDays: 366 }, "relistingGapDays"],
      [{ relistingGapDays: 2.5 }, "relistingGapDays"],
      [{ relistingGapDays: "soon" }, "relistingGapDays"],
      [{ gapEndpoint: "closed" }, "gapEndpoint"],
      [{ timeZone: "Mars/Olympus" }, "timeZone"],
      [{ timeZone: "" }, "timeZone"],
      [{ timeZone: "PST" }, "timeZone"],
      [{ brokerageChangeResets: "yes" }, "brokerageChangeResets"],
    ];
    for (const [bad, field] of refusals) {
      const { version, next } = await values();
      const attempt = saveMarketTimeSettings(staff, { ...next, ...bad }, version, "test");
      await expect(attempt, JSON.stringify(bad)).rejects.toMatchObject({ message: "Check the settings marked below.", fieldErrors: { [field]: expect.any(String) } });
    }
    expect(await latestSettings()).toEqual(before);
    // The edges of each limit are accepted.
    await change({ relistingGapDays: 0, accumulatingStatuses: ["Coming Soon"], timeZone: "UTC" });
    await change({ relistingGapDays: 365, accumulatingStatuses: ["Active", "Active Under Contract", "Coming Soon", "Hold", "Pending"] });
  });

  it("refuses a save made from a version that is no longer in force", async () => {
    const mine = await values({ relistingGapDays: 10 });
    const theirs = await change({ brokerageChangeResets: true }, "someone else, first");
    await expect(saveMarketTimeSettings(staff, mine.next, mine.version, "mine, second")).rejects.toThrow(/Someone else changed the settings/);
    // Their change stands; mine, which did not know of it, did not undo it.
    expect(await latestSettings()).toEqual(theirs);
    for (const stale of [undefined, null, "", "abc", mine.version - 1, theirs.version + 1])
      await expect(saveMarketTimeSettings(staff, mine.next, stale, "no version"), String(stale)).rejects.toThrow(/Someone else changed the settings/);
  });

  it("stores one of two saves made from the same version at the same moment", async () => {
    for (let round = 0; round < 5; round++) {
      const base = await values();
      const results = await Promise.allSettled([
        saveMarketTimeSettings(staff, { ...base.next, relistingGapDays: 40 + round }, base.version, "race one"),
        saveMarketTimeSettings(staff, { ...base.next, relistingGapDays: 60 + round }, base.version, "race two"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((await latestSettings()).version).toBe(base.version + 1);
    }
  });
});

describe("each setting changes the figures as soon as it is saved", () => {
  /** A listing canceled after 60 days, and the same property listed again 10 days later, 30 days ago as of the date asked. */
  async function relisting(options: { secondAgent?: Member; parcel?: string | null; secondSteps?: Step[] } = {}) {
    const street = `Relisted Rd ${run}-${++serial}`;
    const parcel = options.parcel === undefined ? `R${run}-${serial}` : options.parcel;
    await listing([["Active", "2026-01-01"], ["Canceled", "2026-03-02"]], { street, parcel });
    return listing(options.secondSteps ?? [["Active", "2026-03-12"]], { street, parcel, agent: options.secondAgent });
  }

  it("statuses that gain days", async () => {
    const l = await listing([["Active", "2026-03-01"], ["Pending", "2026-03-21"]]);
    expect(await figures(l.ListingKey, "2026-04-10")).toEqual({ dom: 20, cdom: 20 });
    await change({ accumulatingStatuses: ["Active", "Active Under Contract", "Pending"] });
    expect(await figures(l.ListingKey, "2026-04-10")).toEqual({ dom: 40, cdom: 40 });
  });

  it("relisting gap", async () => {
    const l = await relisting();
    expect(await figures(l.ListingKey, "2026-04-11")).toEqual({ dom: 30, cdom: 90 });
    await change({ relistingGapDays: 10 });
    expect(await figures(l.ListingKey, "2026-04-11")).toEqual({ dom: 30, cdom: 30 });
    await change({ relistingGapDays: 11 });
    expect(await figures(l.ListingKey, "2026-04-11")).toEqual({ dom: 30, cdom: 90 });
  });

  it("a different brokerage starts from zero", async () => {
    const l = await relisting({ secondAgent: agents.summit });
    expect(await figures(l.ListingKey, "2026-04-11")).toEqual({ dom: 30, cdom: 90 });
    await change({ brokerageChangeResets: true });
    expect(await figures(l.ListingKey, "2026-04-11")).toEqual({ dom: 30, cdom: 30 });
  });

  it("matching by address", async () => {
    const l = await relisting({ parcel: null });
    expect(await figures(l.ListingKey, "2026-04-11")).toEqual({ dom: 30, cdom: 90 });
    await change({ addressFallback: false });
    expect(await figures(l.ListingKey, "2026-04-11")).toEqual({ dom: 30, cdom: 30 });
  });

  it("where the gap ends", async () => {
    // Entered 10 days after the cancellation, but not on the market until 44 days after it.
    const l = await relisting({ secondSteps: [["Coming Soon", "2026-03-12"], ["Active", "2026-04-15"]] });
    expect(await figures(l.ListingKey, "2026-05-15")).toEqual({ dom: 30, cdom: 90 });
    await change({ gapEndpoint: "onMarket" });
    expect(await figures(l.ListingKey, "2026-05-15")).toEqual({ dom: 30, cdom: 30 });
  });

  it("time zone, without rewriting anything stored", async () => {
    // Late evening on March 1 on the Pacific coast; already March 2 in New York.
    const entered = new Date("2026-03-02T06:30:00Z");
    const l = await listing([["Active", entered]]);
    const stored = async () => ({
      listing: (await db.select().from(property).where(eq(property.ListingKey, l.ListingKey)))[0],
      history: await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, l.ListingKey)),
    });
    const before = await stored();
    expect(before.listing.OnMarketDate).toBe("2026-03-01");
    expect(await figures(l.ListingKey, "2026-03-11")).toEqual({ dom: 10, cdom: 10 });

    await change({ timeZone: "America/New_York" });
    expect(await figures(l.ListingKey, "2026-03-11")).toEqual({ dom: 9, cdom: 9 });
    // The date and times stored for the listing are as they were.
    expect(await stored()).toEqual(before);
    // A date made from now on is in the new zone.
    const later = await listing([["Active", entered]]);
    expect((await db.select().from(property).where(eq(property.ListingKey, later.ListingKey)))[0].OnMarketDate).toBe("2026-03-02");
  });
});

describe("one version for the whole of an operation", () => {
  it("keeps the version it began with, whatever is saved while it runs", async () => {
    const began = await latestSettings();
    const l = await listing([["Active", "2026-03-01"], ["Pending", "2026-03-21"]]);
    await withOneSettingsVersion(async () => {
      expect(await currentSettings()).toEqual(began);
      await change({ accumulatingStatuses: ["Active", "Active Under Contract", "Pending"] });
      // Saved, and in force for everyone else, but not for the work already under way.
      expect((await latestSettings()).version).toBe(began.version + 1);
      expect(await currentSettings()).toEqual(began);
      expect(await figures(l.ListingKey, "2026-04-10")).toEqual({ dom: 20, cdom: 20 });
    });
    expect((await currentSettings()).accumulatingStatuses).toContain("Pending");
    expect(await figures(l.ListingKey, "2026-04-10")).toEqual({ dom: 40, cdom: 40 });
  });

  it("holds through an alert run, and a settings change alone sends no email", async () => {
    const owner = agents.harbor;
    const city = `SettingsAlert${run}`;
    const fields = (price: string) => ({
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: price, ListingContractDate: "2026-01-01",
      StreetNumber: "9", StreetName: "Alert Settings Ave", City: city, StateOrProvince: "WA", PostalCode: "98997",
      BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const watched = await createListing(owner, fields("500000"));
    const { SavedSearchKey: key } = await createSavedSearch(owner, `Settings ${run} alert`, { ...DEFAULT_CRITERIA, city, statuses: [] });
    await setAlertFrequency(owner, key, "daily");
    const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);
    const delivered: Mail[] = [];

    // The settings change, and nothing else does: no email.
    await change({ accumulatingStatuses: ["Active"], relistingGapDays: 5, timeZone: "America/New_York" });
    expect((await sendDueAlerts({ send: async (mail) => void delivered.push(mail), now: hours(25) })).busy).toBe(false);
    expect(delivered.filter((m) => m.to === owner.MemberEmail && m.subject.includes(`Settings ${run} alert`))).toEqual([]);

    // A real change to the listing does send one. While it is being sent, the settings change again.
    await updateListing(owner, watched.ListingKey, fields("480000"));
    const began = await latestSettings();
    const seen: number[] = [];
    await sendDueAlerts({
      now: hours(50),
      send: async (mail) => {
        delivered.push(mail);
        if (!mail.subject.includes(`Settings ${run} alert`)) return;
        await change({ relistingGapDays: 6 });
        seen.push((await currentSettings()).version);
      },
    });
    expect(delivered.filter((m) => m.subject.includes(`Settings ${run} alert`))).toHaveLength(1);
    // Inside the run, after the save, the run still had the version it began with.
    expect(seen).toEqual([began.version]);
    expect((await latestSettings()).version).toBe(began.version + 1);
  });
});
