/*
 * Scheduled email alerts against the test database: what is sent and to whom,
 * that nothing is skipped, what happens when a send fails or its outcome is not
 * known, the checkpoint's whole life, and who may change an alert.
 *
 * The mail server is stood in for by a function, so each test decides what
 * "sending" does. The real server is exercised by the browser tests.
 */
import { eq, like } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { member, savedSearch, type Member, type Property } from "../src/db/schema";
import { getActivity } from "../src/lib/activity";
import { pauseNotice, resumeAlert, sendDueAlerts, setAlertFrequency } from "../src/lib/alerts";
import { createListing, updateListing } from "../src/lib/listings";
import { MailError, classifyMailFailure, type Mail } from "../src/lib/mail";
import { MAX_ALERT_FAILURES, MAX_UNCERTAIN_ALERT_SENDS } from "../src/lib/rules/local";
import { createSavedSearch, renameSavedSearch, updateSavedSearchCriteria } from "../src/lib/saved-work";
import { DEFAULT_CRITERIA } from "../src/lib/search-criteria";

const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const HOUR = 60 * 60 * 1000;
let owner: Member;
let other: Member;
let serial = 0;

const town = (label: string) => `${label}${run}`;
const fields = (city: string, changes: Record<string, unknown> = {}) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
  StreetNumber: String(++serial), StreetName: "Alert Ave", City: city, StateOrProvince: "WA", PostalCode: "96562",
  BedroomsTotal: "3", BathroomsTotalInteger: "2", ...changes,
});
const make = (city: string) => createListing(owner, fields(city));
const reprice = (listing: Property, price: number) =>
  updateListing(owner, listing.ListingKey, { ...fields(listing.City), StreetNumber: listing.StreetNumber, ListPrice: String(price) });
const state = async (key: string) => (await db.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key)))[0];
const forget = () => db.delete(savedSearch).where(like(savedSearch.SavedSearchName, "Alert %"));

/** A saved search for a town of its own, with its alert switched on. */
async function watching(label: string, frequency: "daily" | "weekly" = "daily") {
  const city = town(label);
  const listing = await make(city);
  const { SavedSearchKey: key } = await createSavedSearch(owner, `Alert ${city}`, { ...DEFAULT_CRITERIA, city, statuses: [] });
  await setAlertFrequency(owner, key, frequency);
  return { city, listing, key };
}

/** A stand-in mail server that takes everything and remembers it. */
function inbox() {
  const delivered: Mail[] = [];
  return { delivered, send: async (mail: Mail) => void delivered.push(mail) };
}
/** Later than any alert's schedule, so "is it due" is never what a test is waiting on. */
const later = (hours = 25) => new Date(Date.now() + hours * HOUR);
const refuse = async () => {
  throw new MailError("no", new Error("refused"));
};

beforeAll(async () => {
  const members = await db.select().from(member);
  owner = members.find((m) => m.MemberMlsId === "AG1001")!;
  other = members.find((m) => m.MemberMlsId === "AG1002")!;
  await forget();
});
// Each test's alerts are removed, so a run only ever sees the alerts of the test it belongs to.
afterEach(forget);
afterAll(async () => {
  await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, owner.MemberKey));
  await pool.end();
});

describe("what is sent", () => {
  it("emails the owner a count and a link, with no listing data, and leaves in-app activity alone", async () => {
    const { listing, key, city } = await watching("Sent");
    const mail = inbox();
    // Nothing has happened since the alert was switched on.
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ "nothing-new": 1 });
    expect(mail.delivered).toEqual([]);

    await reprice(listing, 480000);
    const seenThrough = (await state(key)).OsmlsActivitySeenThrough;
    const now = later();
    expect(await sendDueAlerts({ send: mail.send, now })).toEqual({ busy: false, outcomes: { sent: 1 } });
    expect(mail.delivered).toHaveLength(1);
    const [email] = mail.delivered;
    expect(email.to).toBe(owner.MemberEmail);
    expect(email.subject).toBe(`New activity for your saved search "Alert ${city}"`);
    expect(email.text).toContain("1 listing has new activity");
    expect(email.text).toContain(`/saved-searches/${key}/activity`);
    for (const absent of [listing.ListingId, listing.ListingKey, "Alert Ave", "480", "500"]) expect(email.text.includes(absent), absent).toBe(false);

    // The email did not mark anything as seen.
    const after = await state(key);
    expect(after.OsmlsActivitySeenThrough).toBe(seenThrough);
    expect((await getActivity(owner, key))!.matching.map((l) => l.ListingId)).toEqual([listing.ListingId]);
    // The email checkpoint moved, and the schedule starts again from this send.
    expect(after.OsmlsAlertSentThrough).toBeGreaterThan(seenThrough);
    expect(after.OsmlsAlertLastSentAt).toEqual(now);
    expect(after.OsmlsAlertAttempts).toBe(0);
  });

  it("sends at most one a day when daily and one a week when weekly", async () => {
    const daily = await watching("Daily", "daily");
    const weekly = await watching("Weekly", "weekly");
    const mail = inbox();
    await reprice(daily.listing, 480000);
    await reprice(weekly.listing, 480000);
    // Within the first day of being switched on, neither is due.
    expect((await sendDueAlerts({ send: mail.send, now: later(23) })).outcomes).toEqual({});
    // After a day, only the daily one is.
    expect((await sendDueAlerts({ send: mail.send, now: later(25) })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered.map((m) => m.subject)).toEqual([`New activity for your saved search "Alert ${daily.city}"`]);
    // A further change the same day waits for the next day.
    await reprice(daily.listing, 470000);
    expect((await sendDueAlerts({ send: mail.send, now: later(26) })).outcomes).toEqual({});
    expect((await sendDueAlerts({ send: mail.send, now: later(50) })).outcomes).toEqual({ sent: 1 });
    // After a week, the weekly one.
    expect((await sendDueAlerts({ send: mail.send, now: later(7 * 24 + 1) })).outcomes).toMatchObject({ sent: 1 });
    expect(mail.delivered.at(-1)!.subject).toBe(`New activity for your saved search "Alert ${weekly.city}"`);
  });
});

describe("nothing is skipped", () => {
  it("emails a change that was committed after the alert covering its moment was sent", async () => {
    const { listing, key, city } = await watching("Late");
    const second = await make(city);
    const mail = inbox();
    await setAlertFrequency(owner, key, "off");
    await setAlertFrequency(owner, key, "daily");
    await reprice(second, 510000);

    // A change is written but not committed while the alert is read and sent.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("begin");
    await client.query(`update "Property" set "ListPrice" = 480000 where "ListingKey" = $1`, [listing.ListingKey]);
    await client.query(
      `insert into "HistoryTransactional" ("ResourceRecordKey", "ResourceRecordID", "ClassName", "FieldName",
         "PreviousValue", "NewValue", "ChangeType", "ChangedByMemberKey", "ChangedByMemberID")
       values ($1, $2, 'Residential', 'ListPrice', '500000', '480000', 'Price Change', $3, $4)`,
      [listing.ListingKey, listing.ListingId, owner.MemberKey, owner.MemberMlsId],
    );
    expect((await sendDueAlerts({ send: mail.send, now: later(25) })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered[0].text).toContain("1 listing has new activity");
    await client.query("commit");
    await client.end();

    // The late change is in the next alert, not behind the checkpoint.
    expect((await sendDueAlerts({ send: mail.send, now: later(50) })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered[1].text).toContain("1 listing has new activity");
  });

  it("keeps the checkpoint when the mail server refuses, and pauses after repeated refusals", async () => {
    const { listing, key } = await watching("Refused");
    await reprice(listing, 480000);
    const before = await state(key);
    for (let n = 1; n < MAX_ALERT_FAILURES; n++) {
      expect((await sendDueAlerts({ send: refuse, now: later() })).outcomes).toEqual({ refused: 1 });
      expect(await state(key)).toMatchObject({
        OsmlsAlertSentThrough: before.OsmlsAlertSentThrough,
        OsmlsAlertLastSentAt: before.OsmlsAlertLastSentAt,
        OsmlsAlertFailures: n,
        // A refusal is a settled outcome, not an unknown one.
        OsmlsAlertAttempts: 0,
        OsmlsAlertPaused: null,
      });
    }
    expect((await sendDueAlerts({ send: refuse, now: later() })).outcomes).toEqual({ paused: 1 });
    expect(await state(key)).toMatchObject({ OsmlsAlertPaused: "failed", OsmlsAlertSentThrough: before.OsmlsAlertSentThrough });
    expect(pauseNotice("failed")).toContain(`refused ${MAX_ALERT_FAILURES} sends in a row`);

    // While paused nothing is sent, even by a server that now works.
    const mail = inbox();
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({});
    // Resumed, the pending activity is sent: the pause skipped nothing.
    await reprice(listing, 470000);
    await resumeAlert(owner, key);
    expect(await state(key)).toMatchObject({ OsmlsAlertPaused: null, OsmlsAlertFailures: 0, OsmlsAlertSentThrough: before.OsmlsAlertSentThrough });
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered).toHaveLength(1);
    expect((await state(key)).OsmlsAlertSentThrough).toBeGreaterThan(before.OsmlsAlertSentThrough);
  });
});

describe("a send whose outcome is not known", () => {
  /** Makes the checkpoint update fail in the database itself, as a lost connection or a full disk would. */
  const breakCheckpointUpdates = () =>
    pool.query(`
      create or replace function test_fail_alert_checkpoint() returns trigger as $$
      begin raise exception 'checkpoint update failed (test)'; end; $$ language plpgsql;
      drop trigger if exists test_fail_alert_checkpoint on "SavedSearch";
      create trigger test_fail_alert_checkpoint before update of "OsmlsAlertLastSentAt" on "SavedSearch"
        for each row execute function test_fail_alert_checkpoint();`);
  const mendCheckpointUpdates = () => pool.query(`drop trigger if exists test_fail_alert_checkpoint on "SavedSearch"`);
  afterEach(mendCheckpointUpdates);

  it("retries once the checkpoint update has failed after the server accepted, and then settles", async () => {
    const { listing, key } = await watching("Accepted");
    await reprice(listing, 480000);
    const before = await state(key);
    const mail = inbox();
    const now = later();

    // The server accepts the message; recording that then fails.
    await breakCheckpointUpdates();
    expect((await sendDueAlerts({ send: mail.send, now })).outcomes).toEqual({ error: 1 });
    expect(mail.delivered).toHaveLength(1);
    // The started attempt is on record, and the checkpoint has not moved.
    expect(await state(key)).toMatchObject({ OsmlsAlertAttempts: 1, OsmlsAlertSentThrough: before.OsmlsAlertSentThrough, OsmlsAlertPaused: null });

    // Next run: it is retried at once, whatever the schedule says, with the same Message-ID.
    await mendCheckpointUpdates();
    expect((await sendDueAlerts({ send: mail.send, now: new Date() })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered).toHaveLength(2);
    expect(mail.delivered[1].messageId).toBe(mail.delivered[0].messageId);
    expect(mail.delivered[0].messageId).toMatch(/^<alert\..+@.+>$/);
    const settled = await state(key);
    expect(settled.OsmlsAlertAttempts).toBe(0);
    expect(settled.OsmlsAlertSentThrough).toBeGreaterThan(before.OsmlsAlertSentThrough);
    // And not again.
    expect((await sendDueAlerts({ send: mail.send, now: new Date() })).outcomes).toEqual({});
    expect(mail.delivered).toHaveLength(2);
  });

  it("stops after a fixed number of deliveries when the update keeps failing, pauses, and says what is not known", async () => {
    const { listing, key } = await watching("Repeat");
    await reprice(listing, 480000);
    const before = await state(key);
    const mail = inbox();
    await breakCheckpointUpdates();
    for (let n = 1; n <= MAX_UNCERTAIN_ALERT_SENDS; n++) {
      expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ error: 1 });
      expect(mail.delivered).toHaveLength(n);
    }
    // The limit is reached: no further delivery, and the alert pauses.
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ paused: 1 });
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({});
    expect(mail.delivered).toHaveLength(MAX_UNCERTAIN_ALERT_SENDS);
    expect(await state(key)).toMatchObject({ OsmlsAlertPaused: "uncertain", OsmlsAlertSentThrough: before.OsmlsAlertSentThrough });
    expect(pauseNotice("uncertain")).toContain(`up to ${MAX_UNCERTAIN_ALERT_SENDS} times, or not at all`);

    // Resumed with the fault gone, the pending activity goes out and the alert is healthy again.
    await mendCheckpointUpdates();
    await resumeAlert(owner, key);
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ sent: 1 });
    expect(await state(key)).toMatchObject({ OsmlsAlertPaused: null, OsmlsAlertAttempts: 0 });
  });

  it("treats a dropped connection after the message was handed over the same way", async () => {
    const { listing, key } = await watching("Dropped");
    await reprice(listing, 480000);
    let attempts = 0;
    const dropped = async () => {
      attempts++;
      throw new MailError("unknown", new Error("connection closed"));
    };
    expect((await sendDueAlerts({ send: dropped, now: later() })).outcomes).toEqual({ uncertain: 1 });
    expect((await sendDueAlerts({ send: dropped, now: new Date() })).outcomes).toEqual({ uncertain: 1 });
    expect((await sendDueAlerts({ send: dropped, now: new Date() })).outcomes).toEqual({ paused: 1 });
    expect((await sendDueAlerts({ send: dropped, now: later() })).outcomes).toEqual({});
    expect(attempts).toBe(MAX_UNCERTAIN_ALERT_SENDS);
    expect((await state(key)).OsmlsAlertPaused).toBe("uncertain");
  });

  it("reads a mail failure as unknown unless the server plainly refused or was never reached", () => {
    expect(classifyMailFailure({ code: "EENVELOPE", message: "all recipients were rejected" })).toBe("no");
    expect(classifyMailFailure({ code: "ESOCKET", message: "connect ECONNREFUSED 127.0.0.1:1" })).toBe("no");
    expect(classifyMailFailure({ code: "ETIMEDOUT", message: "Timeout" })).toBe("unknown");
    expect(classifyMailFailure({ code: "ECONNECTION", message: "Connection closed unexpectedly" })).toBe("unknown");
    expect(classifyMailFailure(new Error("anything else"))).toBe("unknown");
  });
});

describe("runs and changes that overlap", () => {
  it("sends once when two runs start together", async () => {
    const { listing } = await watching("Twice");
    await reprice(listing, 480000);
    const mail = inbox();
    const slow = async (m: Mail) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await mail.send(m);
    };
    const now = later();
    const results = await Promise.all([sendDueAlerts({ send: slow, now }), sendDueAlerts({ send: slow, now })]);
    expect(results.map((r) => r.busy).sort()).toEqual([false, true]);
    expect(mail.delivered).toHaveLength(1);
  });

  it("sends nothing to a member suspended while an earlier alert in the same run was being sent", async () => {
    const first = await watching("QueuedFirst");
    const second = await watching("QueuedSecond");
    await reprice(first.listing, 480000);
    await reprice(second.listing, 480000);
    const before = await state(second.key);
    const mail = inbox();
    const suspendDuringFirst = async (m: Mail) => {
      await mail.send(m);
      await db.update(member).set({ MemberStatus: "Inactive" }).where(eq(member.MemberKey, owner.MemberKey));
    };
    try {
      expect((await sendDueAlerts({ send: suspendDuringFirst, now: later() })).outcomes).toEqual({ sent: 1, suspended: 1 });
      // The queued alert was not sent, and its checkpoint waits for the member.
      expect(mail.delivered.map((m) => m.subject)).toEqual([`New activity for your saved search "Alert ${first.city}"`]);
      expect(await state(second.key)).toMatchObject({
        OsmlsAlertSentThrough: before.OsmlsAlertSentThrough,
        OsmlsAlertLastSentAt: before.OsmlsAlertLastSentAt,
        OsmlsAlertAttempts: 0,
      });
    } finally {
      await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, owner.MemberKey));
    }
    // Reinstated, they are sent it.
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered).toHaveLength(2);
  });

  it("does not let a send that finishes late write over a criteria change made meanwhile", async () => {
    const { listing, key, city } = await watching("Meanwhile");
    await reprice(listing, 480000);
    let changedAt = new Date(0);
    const sendTime = later(72);
    const duringSend = async () => {
      // While the email is on its way: another change, then the member edits the criteria.
      await reprice(listing, 470000);
      await updateSavedSearchCriteria(owner, key, { ...DEFAULT_CRITERIA, city, statuses: [], minBeds: 1 });
      changedAt = new Date();
    };
    expect((await sendDueAlerts({ send: duringSend, now: sendTime })).outcomes).toEqual({ changed: 1 });
    const after = await state(key);
    // The checkpoint is the one the criteria change set: past the change made during the send.
    const [{ latest }] = (await pool.query(`select coalesce(max("OsmlsSequence"), 0)::int as latest from "HistoryTransactional"`)).rows;
    expect(after.OsmlsAlertSentThrough).toBe(latest);
    // The schedule is the criteria change's too, not the late send's.
    expect(after.OsmlsAlertLastSentAt).not.toEqual(sendTime);
    expect(Math.abs(after.OsmlsAlertLastSentAt!.getTime() - changedAt.getTime())).toBeLessThan(5000);
    expect(after).toMatchObject({ OsmlsAlertAttempts: 0, OsmlsAlertFailures: 0, OsmlsAlertPaused: null, OsmlsAlertFrequency: "daily" });
    // So nothing is due until a period after the change.
    const mail = inbox();
    expect((await sendDueAlerts({ send: mail.send, now: later(23) })).outcomes).toEqual({});
  });

  it("does not let a send that finishes late switch a disabled alert's state back", async () => {
    const { listing, key } = await watching("Disabled");
    await reprice(listing, 480000);
    const before = await state(key);
    expect((await sendDueAlerts({ send: () => setAlertFrequency(owner, key, "off"), now: later() })).outcomes).toEqual({ changed: 1 });
    expect(await state(key)).toMatchObject({
      OsmlsAlertFrequency: null,
      OsmlsAlertSentThrough: before.OsmlsAlertSentThrough,
      OsmlsAlertLastSentAt: before.OsmlsAlertLastSentAt,
      OsmlsAlertAttempts: 0,
    });
  });
});

describe("the checkpoint's life", () => {
  it("starts from the moment alerts are first enabled", async () => {
    const city = town("First");
    const listing = await make(city);
    const { SavedSearchKey: key } = await createSavedSearch(owner, `Alert ${city}`, { ...DEFAULT_CRITERIA, city, statuses: [] });
    // Before enabling: no alert, whatever happens.
    await reprice(listing, 480000);
    const mail = inbox();
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({});
    await setAlertFrequency(owner, key, "daily");
    // Earlier activity is not emailed, though it is still unseen in the application.
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ "nothing-new": 1 });
    expect((await getActivity(owner, key))!.matching).toHaveLength(1);
  });

  it("starts again when disabled and re-enabled, leaving out the time it was off", async () => {
    const { listing, key } = await watching("Reenabled");
    const mail = inbox();
    await setAlertFrequency(owner, key, "off");
    await reprice(listing, 480000);
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({});
    await setAlertFrequency(owner, key, "weekly");
    expect((await sendDueAlerts({ send: mail.send, now: later(8 * 24) })).outcomes).toEqual({ "nothing-new": 1 });
    await reprice(listing, 470000);
    expect((await sendDueAlerts({ send: mail.send, now: later(8 * 24) })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered).toHaveLength(1);
  });

  it("sends nothing while the account is suspended, and everything pending once it is reinstated", async () => {
    const { listing, key } = await watching("Suspended");
    const before = await state(key);
    const mail = inbox();
    // The change is made first: a suspended member can no longer save one.
    await reprice(listing, 480000);
    await db.update(member).set({ MemberStatus: "Inactive" }).where(eq(member.MemberKey, owner.MemberKey));
    try {
      expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({});
      expect((await state(key)).OsmlsAlertSentThrough).toBe(before.OsmlsAlertSentThrough);
    } finally {
      await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, owner.MemberKey));
    }
    expect((await sendDueAlerts({ send: mail.send, now: later() })).outcomes).toEqual({ sent: 1 });
    expect(mail.delivered[0].text).toContain("1 listing has new activity");
  });

  it("is reset by a criteria change, and kept by a rename and by a change of frequency", async () => {
    const { listing, key, city } = await watching("Reset");
    await reprice(listing, 480000);
    const before = await state(key);
    await renameSavedSearch(owner, key, `Alert ${city} renamed`);
    await setAlertFrequency(owner, key, "weekly");
    expect(await state(key)).toMatchObject({
      OsmlsAlertFrequency: "weekly",
      OsmlsAlertSentThrough: before.OsmlsAlertSentThrough,
      OsmlsAlertLastSentAt: before.OsmlsAlertLastSentAt,
      OsmlsAlertGeneration: before.OsmlsAlertGeneration,
    });
    await updateSavedSearchCriteria(owner, key, { ...DEFAULT_CRITERIA, city, statuses: [], minBeds: 1 });
    const after = await state(key);
    expect(after.OsmlsAlertSentThrough).toBeGreaterThan(before.OsmlsAlertSentThrough);
    expect(after.OsmlsAlertGeneration).toBe(before.OsmlsAlertGeneration + 1);
    // The earlier change was measured against other criteria: it is not emailed.
    const mail = inbox();
    expect((await sendDueAlerts({ send: mail.send, now: later(8 * 24) })).outcomes).toEqual({ "nothing-new": 1 });
  });

  it("clears a pause when the criteria change", async () => {
    const { listing, key, city } = await watching("Unpause");
    await reprice(listing, 480000);
    for (let n = 0; n < MAX_ALERT_FAILURES; n++) await sendDueAlerts({ send: refuse, now: later() });
    expect((await state(key)).OsmlsAlertPaused).toBe("failed");
    await updateSavedSearchCriteria(owner, key, { ...DEFAULT_CRITERIA, city, statuses: [], minBeds: 1 });
    expect(await state(key)).toMatchObject({ OsmlsAlertPaused: null, OsmlsAlertFailures: 0, OsmlsAlertAttempts: 0 });
  });
});

describe("who may change an alert", () => {
  it("refuses everyone but the active owner, exactly as for a saved search that does not exist", async () => {
    const { key } = await watching("Owner");
    const before = await state(key);
    const suspended = { ...owner, MemberStatus: "Inactive" };
    for (const viewer of [other, suspended, null]) {
      await expect(setAlertFrequency(viewer, key, "off")).rejects.toThrow("Not found.");
      await expect(resumeAlert(viewer, key)).rejects.toThrow("Not found.");
    }
    await expect(setAlertFrequency(owner, NO_SUCH_KEY, "daily")).rejects.toThrow("Not found.");
    expect(await state(key)).toEqual(before);
  });

  it("accepts only off, daily, and weekly", async () => {
    const { key } = await watching("Values");
    for (const value of ["hourly", "", null, "constructor", 7]) {
      await expect(setAlertFrequency(owner, key, value)).rejects.toThrow("Choose off, daily, or weekly.");
    }
  });
});
