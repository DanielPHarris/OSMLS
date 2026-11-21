import { access, constants, mkdir } from "node:fs/promises";
import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { Client } from "pg";
import { db, pool } from "@/db";
import { jobRun, operatingCondition, type JobRun, type Member, type OperatingCondition, type RunTask } from "@/db/schema";
import { can } from "./access";
import { sendDueAlerts } from "./alerts";
import { INSTALLATION_ID_SQL, knownMigrations, mediaFolderOwner, pruneBackups, sweepUnreferencedFiles, takeBackup, type BackupTarget } from "./backup";
import { cleanUpImports } from "./imports";
import { mediaDir } from "./listings";
import { mailEnabled, sendMail, type Mail } from "./mail";
import { cleanUpShares } from "./shares";

/*
 * Watching the installation from inside it: whether it can serve, what its
 * scheduled work did, and telling someone when something is wrong.
 *
 * What this cannot do is said as plainly as what it can. It runs inside the
 * installation and records in its database. So it cannot report that the
 * machine is off, that the database is unreachable, or that the scheduled
 * command which does the reporting has stopped. An independent monitor calling
 * the health checks is needed for those.
 */

const HOUR = 60 * 60 * 1000;
const hours = (name: string, fallback: number) => {
  const set = Number(process.env[name]);
  return Number.isFinite(set) && set > 0 ? set : fallback;
};
/** How long without a successful backup before one is overdue. */
export const backupOverdueAfter = () => hours("BACKUP_OVERDUE_HOURS", 26) * HOUR;
/** How long without a completed scheduled run before one is overdue. Shown, never emailed. */
export const scheduledOverdueAfter = () => hours("SCHEDULED_OVERDUE_HOURS", 2) * HOUR;
/** How often an open condition is reported again. */
export const REMINDER_EVERY = 24 * HOUR;
/** Where reports go. With none set, nothing is emailed. */
export const operationsAddress = (): string | null => process.env.OPS_EMAIL?.trim() || null;

// ---- Health ----

export type Readiness = { database: boolean; schema: boolean; media: boolean };
export const isReady = (r: Readiness) => r.database && r.schema && r.media;

async function mediaWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const schemaAsExpected = async (client: { query: (text: string) => Promise<{ rows: { hash: string }[] }> }, folder?: string): Promise<boolean> => {
  const applied = (await client.query(`select hash from drizzle.__drizzle_migrations order by id`)).rows.map((r) => r.hash);
  const known = await knownMigrations(folder);
  return applied.length === known.length && applied.every((hash, i) => hash === known[i]);
};

/**
 * Whether the application can serve: the database answers, its schema is the
 * one this version expects, and the media folder can be written to. Backups
 * are not part of it: an overdue backup is reported, and is no reason to take
 * a working application out of service.
 */
export async function readiness(options: { databaseUrl?: string; mediaDir?: string; migrationsFolder?: string } = {}): Promise<Readiness> {
  const media = await mediaWritable(options.mediaDir ?? mediaDir());
  // Its own short-lived connection, so that a database that does not answer is found out quickly.
  const client = new Client({ connectionString: options.databaseUrl ?? process.env.DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => {});
    return { database: false, schema: false, media };
  }
  try {
    return { database: true, schema: await schemaAsExpected(client, options.migrationsFolder), media };
  } catch {
    return { database: true, schema: false, media };
  } finally {
    await client.end().catch(() => {});
  }
}

// ---- Recorded runs ----

type Job = "scheduled" | "backup";
const record = (job: Job, startedAt: Date, finishedAt: Date, outcome: JobRun["Outcome"], tasks: RunTask[]) =>
  db.insert(jobRun).values({ Job: job, StartedAt: startedAt, FinishedAt: finishedAt, Outcome: outcome, Tasks: tasks });

/** The latest run of a job that actually ran. A skipped run is not one. */
export const lastCompletedRun = async (job: Job): Promise<JobRun | null> =>
  (await db.select().from(jobRun).where(and(eq(jobRun.Job, job), ne(jobRun.Outcome, "Skipped"))).orderBy(desc(jobRun.FinishedAt), desc(jobRun.RunKey)).limit(1))[0] ?? null;
export const lastSuccessfulRun = async (job: Job): Promise<JobRun | null> =>
  (await db.select().from(jobRun).where(and(eq(jobRun.Job, job), eq(jobRun.Outcome, "Succeeded"))).orderBy(desc(jobRun.FinishedAt), desc(jobRun.RunKey)).limit(1))[0] ?? null;

// What went wrong, for the record: the kind of error only. A message can quote data.
const kindOf = (err: unknown) => (err instanceof Error ? err.name : "Error");

/**
 * Takes a backup, prunes and sweeps, as `pnpm backup` does, and records how it
 * ended. A failed backup is recorded and thrown. If the record itself cannot
 * be written, the backup's own outcome still stands: an absent success is what
 * makes a backup overdue.
 */
export async function runBackup(target: BackupTarget, options: { keep: number; applicationVersion: string; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  try {
    const made = await takeBackup(target, { applicationVersion: options.applicationVersion });
    const pruned = await pruneBackups(target, options.keep);
    const swept = await sweepUnreferencedFiles(target);
    await record("backup", startedAt, now(), "Succeeded", [
      { name: "Backup", outcome: "Succeeded", detail: `${made.manifest.files.length} files` },
      { name: "Prune", outcome: "Succeeded", detail: `${pruned.deleted.length} older backups deleted` },
      { name: "Sweep", outcome: "Succeeded", detail: swept.skipped ? "Not swept: the media folder has not been given to this database" : `${swept.deleted.length} files deleted` },
    ]).catch((err) => console.error("The backup succeeded but could not be recorded:", kindOf(err)));
    return { made, pruned, swept };
  } catch (err) {
    await record("backup", startedAt, now(), "Failed", [{ name: "Backup", outcome: "Failed", detail: kindOf(err) }]).catch(() => {});
    throw err;
  }
}

// ---- Conditions ----

export const CONDITIONS = {
  "backup-overdue": "Backup overdue",
  "backup-failed": "Backup failed",
  "scheduled-run-failed": "Scheduled run failed",
  "alerts-failing": "Alerts failing",
  "media-not-writable": "Media folder not writable",
} as const;
export type Condition = keyof typeof CONDITIONS;

/** What a check found: the condition holds (with what to say), does not, or nothing was learned either way. */
type Verdict = { holds: true; detail: string } | { holds: false } | "unknown";
type Send = (mail: Mail) => Promise<void>;

export const openConditions = (): Promise<OperatingCondition[]> =>
  db.select().from(operatingCondition).where(isNull(operatingCondition.ClearedAt)).orderBy(operatingCondition.BeganAt);

async function backupVerdicts(now: Date): Promise<Pick<Record<Condition, Verdict>, "backup-overdue" | "backup-failed">> {
  const good = await lastSuccessfulRun("backup");
  const latest = await lastCompletedRun("backup");
  // With no backup ever, the count starts from the first thing this installation recorded.
  const [first] = await db.select({ at: sql<Date>`min(${jobRun.StartedAt})` }).from(jobRun);
  const since = good?.FinishedAt ?? first?.at ?? now;
  const overdue = now.getTime() - new Date(since).getTime() > backupOverdueAfter();
  return {
    "backup-overdue": overdue ? { holds: true, detail: good ? `The last successful backup finished at ${good.FinishedAt.toISOString()}.` : "No backup has succeeded yet." } : { holds: false },
    "backup-failed": latest?.Outcome === "Failed" ? { holds: true, detail: `The backup that finished at ${latest.FinishedAt.toISOString()} failed.` } : { holds: false },
  };
}

/**
 * Brings the recorded conditions in line with what was found, and emails what
 * is owed: once when a condition begins, once every 24 hours while it lasts,
 * and once when it clears. An email that could not be sent is owed still, and
 * is tried at the next run.
 */
async function settleConditions(verdicts: Partial<Record<Condition, Verdict>>, now: Date, send: Send): Promise<{ sent: number; unsent: number }> {
  for (const [name, verdict] of Object.entries(verdicts) as [Condition, Verdict][]) {
    if (verdict === "unknown") continue;
    if (verdict.holds) {
      await db.insert(operatingCondition).values({ Condition: name, Detail: verdict.detail, BeganAt: now }).onConflictDoNothing();
    } else {
      await db.update(operatingCondition).set({ ClearedAt: now }).where(and(eq(operatingCondition.Condition, name), isNull(operatingCondition.ClearedAt)));
    }
  }
  const to = operationsAddress();
  let sent = 0;
  let unsent = 0;
  const email = async (row: OperatingCondition, subject: string, text: string, settled: Partial<OperatingCondition>) => {
    if (!to) return;
    try {
      await send({ to, subject, text });
      await db.update(operatingCondition).set(settled).where(eq(operatingCondition.ConditionKey, row.ConditionKey));
      sent++;
    } catch {
      unsent++;
    }
  };
  for (const row of await openConditions()) {
    if (row.LastReportedAt && now.getTime() - row.LastReportedAt.getTime() < REMINDER_EVERY) continue;
    const label = CONDITIONS[row.Condition as Condition] ?? row.Condition;
    await email(
      row,
      `OSMLS: ${label}${row.LastReportedAt ? " (still)" : ""}`,
      [`${label}, since ${row.BeganAt.toISOString()}.`, "", row.Detail, "", "You will be told once a day while this lasts, and once when it ends."].join("\n"),
      { LastReportedAt: now },
    );
  }
  const cleared = await db.select().from(operatingCondition).where(and(isNotNull(operatingCondition.ClearedAt), isNull(operatingCondition.ClearSettledAt)));
  for (const row of cleared) {
    // Never reported, so there is nothing to take back.
    if (!row.LastReportedAt) {
      await db.update(operatingCondition).set({ ClearSettledAt: now }).where(eq(operatingCondition.ConditionKey, row.ConditionKey));
      continue;
    }
    const label = CONDITIONS[row.Condition as Condition] ?? row.Condition;
    await email(row, `OSMLS: ${label} has ended`, `${label}, which began at ${row.BeganAt.toISOString()}, ended at ${row.ClearedAt!.toISOString()}.`, { ClearSettledAt: now });
  }
  return { sent, unsent };
}

// ---- The scheduled command ----

export type ScheduledTask = { name: string; run: (now: Date, send: Send) => Promise<{ detail: string; alerts?: { sent: number; failed: number } }> };

// An alert send that did not end in the mail server accepting it, or an alert that could not be prepared.
const ALERT_FAILURES = ["refused", "uncertain", "paused", "error"] as const;

export const SCHEDULED_TASKS: ScheduledTask[] = [
  {
    name: "Send alerts",
    run: async (now, send) => {
      const { busy, outcomes } = await sendDueAlerts({ now, send });
      if (busy) throw new Error("Another alert run was in progress.");
      const failed = ALERT_FAILURES.reduce((n, o) => n + (outcomes[o] ?? 0), 0);
      return { detail: JSON.stringify(outcomes), alerts: { sent: outcomes.sent ?? 0, failed } };
    },
  },
  {
    name: "Tidy expired links",
    run: async () => {
      const links = await cleanUpShares();
      return { detail: `${links.addressesDeleted} expired addresses deleted, ${links.recordsDeleted} old records deleted` };
    },
  },
  {
    name: "Tidy import previews",
    run: async () => ({ detail: `${(await cleanUpImports()).previewsDeleted} uncommitted previews deleted` }),
  },
];

/** Why the scheduled command did nothing at all: it could not safely start, so it recorded and reported nothing. */
export class ScheduledRunRefused extends Error {
  constructor(public reason: "database-unavailable" | "schema-version") {
    super(reason === "schema-version" ? "The database's schema is not the version this application expects." : "The database is unavailable.");
    this.name = "ScheduledRunRefused";
  }
}

export type ScheduledRun = { outcome: JobRun["Outcome"]; tasks: RunTask[]; reports: { sent: number; unsent: number } };

/**
 * One run of the scheduled command: each task in turn, one failing not
 * stopping the others; then the record of the run; then what is wrong is
 * worked out and reported. Only one run proceeds at a time. A second started
 * meanwhile does nothing, and is recorded as skipped, not as a run.
 *
 * It needs the database for all of this, at the schema this version expects.
 * If the database is unavailable, or its schema is another version's, it
 * refuses before any task runs: nothing is changed, recorded or sent, and the
 * caller logs that and exits. An email cannot be promised for either, since
 * what has already been reported is itself recorded in that database.
 */
export async function runScheduled(options: { now?: Date; send?: Send; tasks?: ScheduledTask[]; mediaDir?: string; migrationsFolder?: string } = {}): Promise<ScheduledRun> {
  const { now = new Date(), send = sendMail, tasks = SCHEDULED_TASKS } = options;
  // Held on one connection for the whole run, and gone with it if the process dies.
  const holder = await pool.connect().catch(() => {
    throw new ScheduledRunRefused("database-unavailable");
  });
  try {
    const expected = await schemaAsExpected(holder, options.migrationsFolder).catch(() => false);
    if (!expected) throw new ScheduledRunRefused("schema-version");
    const held = (await holder.query(`select pg_try_advisory_lock(hashtext('osmls:scheduled:run')) as held`)).rows[0].held as boolean;
    if (!held) {
      await record("scheduled", now, now, "Skipped", []);
      return { outcome: "Skipped", tasks: [], reports: { sent: 0, unsent: 0 } };
    }
    try {
      const done: RunTask[] = [];
      // Tasks that did not finish. Alerts that finished with some unsent are "alerts failing" instead.
      const broke: string[] = [];
      let alerts: { sent: number; failed: number } | undefined;
      for (const task of tasks) {
        try {
          const result = await task.run(now, send);
          alerts = result.alerts ?? alerts;
          // Alerts that were not sent make the task, and so the run, a failed one. What was counted is kept.
          done.push({ name: task.name, outcome: result.alerts && result.alerts.failed > 0 ? "Failed" : "Succeeded", detail: result.detail });
        } catch (err) {
          console.error(`Scheduled task "${task.name}" failed:`, err);
          done.push({ name: task.name, outcome: "Failed", detail: kindOf(err) });
          broke.push(task.name);
        }
      }
      const outcome = done.some((t) => t.outcome === "Failed") ? "Failed" : "Succeeded";
      await record("scheduled", now, options.now ? now : new Date(), outcome, done);

      const verdicts: Partial<Record<Condition, Verdict>> = {
        ...(await backupVerdicts(now)),
        "scheduled-run-failed": broke.length ? { holds: true, detail: `Did not finish: ${broke.join(", ")}.` } : { holds: false },
        // A run that sent nothing says nothing about whether mail works.
        "alerts-failing": !alerts ? "unknown" : alerts.failed > 0 ? { holds: true, detail: `${alerts.failed} alert emails were not sent or may not have been.` } : alerts.sent > 0 ? { holds: false } : "unknown",
        "media-not-writable": (await mediaWritable(options.mediaDir ?? mediaDir())) ? { holds: false } : { holds: true, detail: "Photos and documents cannot be stored." },
      };
      return { outcome, tasks: done, reports: await settleConditions(verdicts, now, send) };
    } finally {
      await holder.query(`select pg_advisory_unlock(hashtext('osmls:scheduled:run'))`).catch(() => {});
    }
  } finally {
    holder.release();
  }
}

// ---- The status screen ----

export type OperationsStatus = {
  readiness: Readiness;
  scheduled: { last: JobRun | null; overdue: boolean };
  backup: { last: JobRun | null; lastSuccessful: JobRun | null; overdue: boolean };
  mediaFolder: "this-database" | "another-database" | "unclaimed";
  reports: { address: boolean; mail: boolean };
  conditions: OperatingCondition[];
};

/**
 * What staff see on the status screen. Null for anyone who does not manage
 * settings: the screen does not exist for them.
 *
 * Whether a scheduled run is overdue is worked out here, when someone looks.
 * It is never emailed: a scheduled command that has stopped cannot report its
 * own absence.
 */
export async function getOperationsStatus(actor: Member | null, now = new Date()): Promise<OperationsStatus | null> {
  if (!can(actor, "settings")) return null;
  const lastScheduled = await lastCompletedRun("scheduled");
  const lastBackup = await lastCompletedRun("backup");
  const lastSuccessful = await lastSuccessfulRun("backup");
  const overdue = (await backupVerdicts(now))["backup-overdue"];
  const owner = await mediaFolderOwner(mediaDir());
  const id = (await pool.query(`select ${INSTALLATION_ID_SQL} as id`)).rows[0].id as string;
  return {
    readiness: await readiness(),
    scheduled: { last: lastScheduled, overdue: !lastScheduled || now.getTime() - lastScheduled.FinishedAt.getTime() > scheduledOverdueAfter() },
    backup: { last: lastBackup, lastSuccessful, overdue: overdue !== "unknown" && overdue.holds },
    mediaFolder: !owner ? "unclaimed" : owner === id ? "this-database" : "another-database",
    reports: { address: operationsAddress() !== null, mail: mailEnabled() },
    conditions: await openConditions(),
  };
}
