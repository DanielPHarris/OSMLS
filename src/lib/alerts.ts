import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db } from "../db";
import { member, savedSearch, type Member, type SavedSearch } from "../db/schema";
import { canUseSavedSearch } from "./access";
import { latestSequence, listingsWithActivity } from "./activity";
import { formatDateTime } from "./format";
import { ListingError } from "./listings";
import { MailError, appUrl, mailEnabled, sendMail, type Mail } from "./mail";
import { MAX_ACTIVITY_LISTINGS, MAX_ALERT_FAILURES, MAX_UNCERTAIN_ALERT_SENDS } from "./rules/local";
import { LATEST_HISTORY_SEQUENCE } from "./saved-work";
import { isOwnKey } from "./validation";

/*
 * Scheduled email alerts: activity on a saved search, emailed to its owner.
 *
 * An alert has its own checkpoint, separate from the in-app one, so an email
 * never marks anything as seen in the application and marking as seen never
 * holds back an email. The email says how many listings have activity and
 * links to the in-app page; it carries no listing data.
 *
 * Nothing is skipped: the checkpoint moves only once the mail server has
 * accepted the message, to the boundary read in the same snapshot as the
 * activity that was counted.
 *
 * Exactly-once delivery is not possible over email. A send is recorded as
 * started before it is made, so a send whose outcome is not known (a dropped
 * connection after the message was handed over, or a crash before the
 * checkpoint was moved) is recognised next time. It is tried again a bounded
 * number of times, then the alert pauses and says so.
 *
 * Every change the member makes raises the alert's generation, and a send only
 * writes its result if the generation is still the one it started under.
 */

export const ALERT_FREQUENCIES = { daily: "Daily", weekly: "Weekly" } as const;
export type AlertFrequency = keyof typeof ALERT_FREQUENCIES;

const notFound = () => new ListingError("Not found.");
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const snapshot = { isolationLevel: "repeatable read" } as const;
const bump = sql`${savedSearch.OsmlsAlertGeneration} + 1`;
type Values = PgUpdateSetSource<typeof savedSearch>;
const cleared = { OsmlsAlertAttempts: 0, OsmlsAlertFailures: 0, OsmlsAlertPaused: null } as const;

/** Runs a change to the viewer's own saved search with its row locked. */
async function change(viewer: Member | null, key: unknown, set: (row: SavedSearch) => Values | null) {
  if (!viewer || viewer.MemberStatus !== "Active" || !isKey(key)) throw notFound();
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key)).for("update");
    if (!row || !canUseSavedSearch(viewer, row)) throw notFound();
    const values = set(row);
    if (values) await tx.update(savedSearch).set(values).where(eq(savedSearch.SavedSearchKey, key));
  });
}

/**
 * Switches a saved search's alert on, off, or to another frequency.
 * Switching on (first time or again) starts from now: earlier activity is not
 * emailed. Changing between daily and weekly keeps the checkpoint.
 */
export async function setAlertFrequency(viewer: Member | null, key: unknown, value: unknown): Promise<void> {
  if (value !== "off" && !isOwnKey(ALERT_FREQUENCIES, value)) throw new ListingError("Choose off, daily, or weekly.");
  if (value !== "off" && !mailEnabled()) throw new ListingError("Email is not set up on this system.");
  await change(viewer, key, (row) => {
    if (value === "off") return row.OsmlsAlertFrequency ? { OsmlsAlertFrequency: null, ...cleared, OsmlsAlertGeneration: bump } : null;
    if (row.OsmlsAlertFrequency) return row.OsmlsAlertFrequency === value ? null : { OsmlsAlertFrequency: value };
    return {
      OsmlsAlertFrequency: value,
      OsmlsAlertSentThrough: LATEST_HISTORY_SEQUENCE,
      OsmlsAlertLastSentAt: new Date(),
      ...cleared,
      OsmlsAlertGeneration: bump,
    };
  });
}

/** Lifts a pause. The checkpoint is kept, so the next run emails everything pending. */
export async function resumeAlert(viewer: Member | null, key: unknown): Promise<void> {
  await change(viewer, key, (row) => (row.OsmlsAlertPaused ? { ...cleared, OsmlsAlertGeneration: bump } : null));
}

/** What a paused alert tells its owner. */
export function pauseNotice(paused: string | null): string | null {
  if (paused === "failed") {
    return `Email alerts are paused: the mail server refused ${MAX_ALERT_FAILURES} sends in a row. No email was delivered and no activity was skipped. Resuming sends what is pending.`;
  }
  if (paused === "uncertain") {
    return `Email alerts are paused: ${MAX_UNCERTAIN_ALERT_SENDS} sends ended without the mail server confirming them. The same alert may have reached you up to ${MAX_UNCERTAIN_ALERT_SENDS} times, or not at all. No activity was skipped. Resuming sends what is pending.`;
  }
  return null;
}

export type AlertOutcome = "sent" | "nothing-new" | "refused" | "uncertain" | "paused" | "changed";
type Send = (mail: Mail) => Promise<void>;

/** One alert, from reading to recording the result. */
async function sendOne(key: string, owner: Member, send: Send, now: Date): Promise<AlertOutcome> {
  // One snapshot: the alert's state, the boundary, and what has activity up to it.
  const reading = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key));
    if (!row?.OsmlsAlertFrequency || row.OsmlsAlertPaused) return null;
    const through = await latestSequence(tx);
    const { rows, more } = await listingsWithActivity(tx, owner, row, row.OsmlsAlertSentThrough, through, MAX_ACTIVITY_LISTINGS);
    return { row, through, listings: rows.length, more };
  }, snapshot);
  if (!reading) return "changed";
  const { row, through } = reading;
  // Every write below applies only if the member has changed nothing since the reading.
  const unchanged = and(eq(savedSearch.SavedSearchKey, key), eq(savedSearch.OsmlsAlertGeneration, row.OsmlsAlertGeneration));
  const write = async (values: Values) =>
    (await db.update(savedSearch).set(values).where(unchanged).returning({ key: savedSearch.SavedSearchKey })).length > 0;

  if (row.OsmlsAlertAttempts >= MAX_UNCERTAIN_ALERT_SENDS) {
    await write({ OsmlsAlertPaused: "uncertain" });
    return "paused";
  }
  if (reading.listings === 0) {
    // Nothing to send. Moving the checkpoint skips nothing: there was nothing up to the boundary.
    await write({ OsmlsAlertSentThrough: through, OsmlsAlertAttempts: 0 });
    return "nothing-new";
  }
  // Recorded and committed before the send, so an unfinished send is known about afterwards.
  if (!(await write({ OsmlsAlertAttempts: sql`${savedSearch.OsmlsAlertAttempts} + 1` }))) return "changed";
  const attempts = row.OsmlsAlertAttempts + 1;

  const count = `${reading.listings}${reading.more ? " or more" : ""} ${reading.listings === 1 && !reading.more ? "listing has" : "listings have"}`;
  try {
    await send({
      to: owner.MemberEmail,
      subject: `New activity for your saved search "${row.SavedSearchName}"`,
      text: [
        `${count} new activity for your saved search "${row.SavedSearchName}" since ${formatDateTime(row.OsmlsAlertLastSentAt ?? row.OriginalEntryTimestamp)}.`,
        "",
        `See it (sign-in required): ${appUrl()}/saved-searches/${key}/activity`,
        "",
        "This email does not mark anything as seen. Activity stays on that page until you mark it as seen there.",
        "",
        `To stop these emails, set this search's email alert to Off: ${appUrl()}/saved-searches`,
      ].join("\n"),
      // The same for every attempt at this alert. Some mail systems use it to hide repeats; that is not relied on.
      messageId: `<alert.${key}.${row.OsmlsAlertGeneration}.${row.OsmlsAlertSentThrough}@${new URL(appUrl()).hostname}>`,
    });
  } catch (err) {
    if (err instanceof MailError && err.delivered === "no") {
      // Definitely not delivered: this attempt is settled, and the checkpoint stays for the next run.
      const failures = row.OsmlsAlertFailures + 1;
      await write({
        OsmlsAlertAttempts: sql`greatest(${savedSearch.OsmlsAlertAttempts} - 1, 0)`,
        OsmlsAlertFailures: failures,
        OsmlsAlertPaused: failures >= MAX_ALERT_FAILURES ? "failed" : null,
      });
      return failures >= MAX_ALERT_FAILURES ? "paused" : "refused";
    }
    // Anything else: it may have been delivered. The started attempt stays on record.
    if (attempts >= MAX_UNCERTAIN_ALERT_SENDS) {
      await write({ OsmlsAlertPaused: "uncertain" });
      return "paused";
    }
    return "uncertain";
  }
  // Accepted. If this write fails, the started attempt stays on record and the next run treats it as uncertain.
  const recorded = await write({ OsmlsAlertSentThrough: through, OsmlsAlertLastSentAt: now, OsmlsAlertAttempts: 0, OsmlsAlertFailures: 0 });
  return recorded ? "sent" : "changed";
}

/**
 * Sends every alert that is due. Only one run proceeds at a time; a second
 * started meanwhile reports busy and does nothing. Suspended members are sent
 * nothing, and their checkpoints wait for them.
 */
export async function sendDueAlerts(
  options: { send?: Send; now?: Date } = {},
): Promise<{ busy: boolean; outcomes: Partial<Record<AlertOutcome | "error", number>> }> {
  const { send = sendMail, now = new Date() } = options;
  return db.transaction(async (lock) => {
    const held = await lock.execute(sql`select pg_try_advisory_xact_lock(hashtext('osmls:alerts:send')) as held`);
    if (!held.rows[0]?.held) return { busy: true, outcomes: {} };
    const period = sql`case ${savedSearch.OsmlsAlertFrequency} when 'weekly' then interval '7 days' else interval '1 day' end`;
    const due = await db
      .select({ key: savedSearch.SavedSearchKey, owner: member })
      .from(savedSearch)
      .innerJoin(member, eq(member.MemberKey, savedSearch.MemberKey))
      .where(
        and(
          isNotNull(savedSearch.OsmlsAlertFrequency),
          isNull(savedSearch.OsmlsAlertPaused),
          eq(member.MemberStatus, "Active"),
          // Due by the schedule, or owed a retry after a send whose outcome is not known.
          sql`(${savedSearch.OsmlsAlertAttempts} > 0 or ${savedSearch.OsmlsAlertLastSentAt} is null or ${savedSearch.OsmlsAlertLastSentAt} + ${period} <= ${now})`,
        ),
      )
      .orderBy(savedSearch.OriginalEntryTimestamp);
    const outcomes: Partial<Record<AlertOutcome | "error", number>> = {};
    for (const { key, owner } of due) {
      let outcome: AlertOutcome | "error";
      try {
        outcome = await sendOne(key, owner, send, now);
      } catch (err) {
        // One alert's trouble does not stop the others. Whatever it had started stays on record.
        console.error(`Alert for saved search ${key} failed:`, err);
        outcome = "error";
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { busy: false, outcomes };
  });
}
