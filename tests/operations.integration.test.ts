/*
 * Monitoring (issue #40): the health checks, the record of each backup and
 * scheduled run, and reporting what is wrong by email, once when it begins,
 * once a day while it lasts, and once when it ends.
 *
 * Runs and conditions are recorded in the test database. The backups
 * themselves are of a scratch database with folders of its own. The mail
 * server is stood in for by a function.
 */
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as live } from "../src/app/api/health/live/route";
import { GET as ready } from "../src/app/api/health/ready/route";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { jobRun, member, operatingCondition, savedSearch } from "../src/db/schema";
import { setAlertFrequency } from "../src/lib/alerts";
import { createListing, updateListing } from "../src/lib/listings";
import { MailError } from "../src/lib/mail";
import { createSavedSearch } from "../src/lib/saved-work";
import { DEFAULT_CRITERIA } from "../src/lib/search-criteria";
import type { Mail } from "../src/lib/mail";
import { SCHEDULED_TASKS, ScheduledRunRefused, isReady, lastCompletedRun, openConditions, readiness, runBackup, runScheduled, type ScheduledTask } from "../src/lib/operations";

const HOUR = 60 * 60 * 1000;
const SCRATCH = `osmls_ops_${Date.now()}`;
const urlFor = (database: string) => {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${database}`;
  return u.toString();
};
const work = mkdtempSync(path.join(tmpdir(), "osmls-ops-"));
const target = { databaseUrl: urlFor(SCRATCH), mediaDir: path.join(work, "media"), backupDir: path.join(work, "backups") };
const OPS = "ops@osmls.example";
let admin: Client;
let envBefore: string | undefined;

const inbox = () => {
  const delivered: Mail[] = [];
  return { delivered, send: async (mail: Mail) => void delivered.push(mail) };
};
const backUp = (at: Date) => runBackup(target, { keep: 14, applicationVersion: "test", now: () => at });
// The scheduled command's reporting alone: its ordinary tasks belong to other tests.
const scheduled = (at: Date, send: (mail: Mail) => Promise<void>) => runScheduled({ now: at, send, tasks: [], mediaDir: target.mediaDir });
const open = async () => (await openConditions()).map((c) => c.Condition);

beforeAll(async () => {
  admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  await admin.query(`create database ${SCRATCH}`);
  execFileSync("pnpm", ["exec", "tsx", "scripts/migrate.ts"], { env: { ...process.env, DATABASE_URL: target.databaseUrl, MEDIA_DIR: target.mediaDir } });
  envBefore = process.env.OPS_EMAIL;
  process.env.OPS_EMAIL = OPS;
}, 120_000);
afterAll(async () => {
  if (envBefore === undefined) delete process.env.OPS_EMAIL;
  else process.env.OPS_EMAIL = envBefore;
  await admin.query(`drop database if exists ${SCRATCH} with (force)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.delete(jobRun);
  await db.delete(operatingCondition);
});

describe("the health checks", () => {
  it("say ok when the application can serve, and nothing more", async () => {
    expect(await live().json()).toEqual({ status: "ok" });
    const answer = await ready();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: "ok" });
  });

  it("alive still says ok, and ready says not ok, when the database is unreachable", async () => {
    const real = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://osmls:osmls@127.0.0.1:9/unreachable";
    try {
      expect(await readiness()).toMatchObject({ database: false, schema: false });
      expect(live().status).toBe(200);
      const answer = await ready();
      expect(answer.status).toBe(503);
      expect(await answer.json()).toEqual({ status: "not ok" });
    } finally {
      process.env.DATABASE_URL = real;
    }
  });
});

describe("backups that stop succeeding", () => {
  it("are reported once when overdue, once a day after, and once when a backup succeeds again, and never fail readiness", async () => {
    const start = new Date();
    const after = (h: number) => new Date(start.getTime() + h * HOUR);
    const mail = inbox();

    // Everything working: a backup has succeeded, and an hour later nothing is wrong.
    await backUp(start);
    expect(await scheduled(after(1), mail.send)).toMatchObject({ outcome: "Succeeded", reports: { sent: 0, unsent: 0 } });
    expect(await open()).toEqual([]);
    expect(mail.delivered).toEqual([]);

    // No backup succeeds. Past the threshold it is overdue, and one email says so.
    await scheduled(after(25), mail.send);
    expect(await open()).toEqual([]);
    await scheduled(after(27), mail.send);
    expect(await open()).toEqual(["backup-overdue"]);
    expect(mail.delivered).toHaveLength(1);
    expect(mail.delivered[0]).toMatchObject({ to: OPS, subject: "OSMLS: Backup overdue" });
    // The application still serves: an overdue backup is not a reason to take it out of service.
    expect(isReady(await readiness())).toBe(true);

    // The next runs say nothing more, until a day has passed.
    await scheduled(after(28), mail.send);
    await scheduled(after(50), mail.send);
    expect(mail.delivered).toHaveLength(1);
    await scheduled(after(51), mail.send);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Backup overdue", "OSMLS: Backup overdue (still)"]);

    // A backup succeeds. The condition ends, and one email says so.
    await backUp(after(52));
    await scheduled(after(53), mail.send);
    expect(await open()).toEqual([]);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Backup overdue", "OSMLS: Backup overdue (still)", "OSMLS: Backup overdue has ended"]);
    await scheduled(after(54), mail.send);
    expect(mail.delivered).toHaveLength(3);
  }, 180_000);
});

describe("the other conditions", () => {
  const start = new Date();
  const after = (h: number) => new Date(start.getTime() + h * HOUR);
  const withTasks = (at: Date, send: (mail: Mail) => Promise<void>, tasks: ScheduledTask[], media = target.mediaDir) => runScheduled({ now: at, send, tasks, mediaDir: media });
  const fine = (name: string): ScheduledTask => ({ name, run: async () => ({ detail: "done" }) });

  it("a backup that fails is recorded and reported, until one succeeds", async () => {
    const mail = inbox();
    await backUp(start);
    // The backup folder cannot be made: its parent is a file.
    const blocker = path.join(work, "a-file");
    writeFileSync(blocker, "");
    await expect(runBackup({ ...target, backupDir: path.join(blocker, "backups") }, { keep: 14, applicationVersion: "test", now: () => after(1) })).rejects.toThrow();
    expect(await lastCompletedRun("backup")).toMatchObject({ Outcome: "Failed", Tasks: [{ name: "Backup", outcome: "Failed" }] });

    await scheduled(after(2), mail.send);
    expect(await open()).toEqual(["backup-failed"]);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Backup failed"]);
    await backUp(after(3));
    await scheduled(after(4), mail.send);
    expect(await open()).toEqual([]);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Backup failed", "OSMLS: Backup failed has ended"]);
  }, 180_000);

  it("a task that does not finish is recorded and reported, and the other tasks still run", async () => {
    const mail = inbox();
    await backUp(start);
    const ran: string[] = [];
    const noting = (name: string): ScheduledTask => ({ name, run: async () => (ran.push(name), { detail: "done" }) });
    const breaking: ScheduledTask = { name: "Tidy expired links", run: async () => Promise.reject(new TypeError("with a member's address in it: someone@example.com")) };
    const run = await withTasks(after(1), mail.send, [noting("First"), breaking, noting("Last")]);
    expect(ran).toEqual(["First", "Last"]);
    expect(run.outcome).toBe("Failed");
    // The kind of error is kept, not its message, which can quote data.
    expect(run.tasks).toEqual([
      { name: "First", outcome: "Succeeded", detail: "done" },
      { name: "Tidy expired links", outcome: "Failed", detail: "TypeError" },
      { name: "Last", outcome: "Succeeded", detail: "done" },
    ]);
    expect((await lastCompletedRun("scheduled"))!.Tasks).toEqual(run.tasks);
    expect(await open()).toEqual(["scheduled-run-failed"]);
    expect(mail.delivered).toHaveLength(1);
    expect(mail.delivered[0].subject).toBe("OSMLS: Scheduled run failed");
    expect(mail.delivered[0].text).toContain("Did not finish: Tidy expired links.");
    expect(mail.delivered[0].text).not.toContain("someone@example.com");

    expect((await withTasks(after(2), mail.send, [fine("First"), fine("Tidy expired links")])).outcome).toBe("Succeeded");
    expect(await open()).toEqual([]);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Scheduled run failed", "OSMLS: Scheduled run failed has ended"]);
  }, 180_000);

  it("alerts that were not sent fail the task and the run with their counts kept, and only a run that sends shows mail has recovered", async () => {
    const mail = inbox();
    await backUp(start);
    const alerts = (sent: number, failed: number): ScheduledTask => ({ name: "Send alerts", run: async () => ({ detail: JSON.stringify({ sent, refused: failed }), alerts: { sent, failed } }) });

    // Some sent and some not: the task and the run have failed, and the counts are on record.
    const mixed = await withTasks(after(1), mail.send, [alerts(2, 1), fine("Tidy expired links")]);
    expect(mixed.outcome).toBe("Failed");
    expect(mixed.tasks[0]).toEqual({ name: "Send alerts", outcome: "Failed", detail: '{"sent":2,"refused":1}' });
    // It is alerts that are failing; every task finished.
    expect(await open()).toEqual(["alerts-failing"]);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Alerts failing"]);

    // A run with nothing to send says nothing about mail: the condition stays.
    expect((await withTasks(after(2), mail.send, [alerts(0, 0)])).outcome).toBe("Succeeded");
    expect(await open()).toEqual(["alerts-failing"]);
    // A run that sends, with none failing, ends it.
    await withTasks(after(3), mail.send, [alerts(1, 0)]);
    expect(await open()).toEqual([]);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Alerts failing", "OSMLS: Alerts failing has ended"]);
  }, 180_000);

  it("the real alert task counts a refused send as a failure", async () => {
    const [owner] = await db.select().from(member).where(eq(member.MemberMlsId, "AG1001"));
    const city = `Opsville${Date.now()}`;
    const fields = { StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01", StreetNumber: "1", StreetName: "Ops Ave", City: city, StateOrProvince: "WA", PostalCode: "96562", BedroomsTotal: "3", BathroomsTotalInteger: "2" };
    const listing = await createListing(owner, fields);
    const saved = await createSavedSearch(owner, `Ops ${city}`, { ...DEFAULT_CRITERIA, city, statuses: [] });
    await setAlertFrequency(owner, saved.SavedSearchKey, "daily");
    await updateListing(owner, listing.ListingKey, { ...fields, ListPrice: "480000" });
    await backUp(start);
    const delivered: Mail[] = [];
    // The mail server refuses everything but the operations address.
    const send = async (m: Mail) => {
      if (m.to !== OPS) throw new MailError("no", new Error("refused"));
      delivered.push(m);
    };
    try {
      const run = await runScheduled({ now: after(25), send, tasks: [SCHEDULED_TASKS[0]], mediaDir: target.mediaDir });
      expect(run.tasks[0]).toMatchObject({ name: "Send alerts", outcome: "Failed" });
      expect(JSON.parse(run.tasks[0].detail).refused).toBeGreaterThanOrEqual(1);
      expect(run.outcome).toBe("Failed");
      expect(await open()).toEqual(["alerts-failing"]);
      expect(delivered.map((m) => m.subject)).toEqual(["OSMLS: Alerts failing"]);
    } finally {
      await db.delete(savedSearch).where(eq(savedSearch.SavedSearchKey, saved.SavedSearchKey));
    }
  }, 180_000);

  it("a media folder that cannot be written to is reported, and readiness says not ok", async () => {
    const mail = inbox();
    await backUp(start);
    const blocker = path.join(work, "another-file");
    writeFileSync(blocker, "");
    const unwritable = path.join(blocker, "media");
    expect(isReady(await readiness({ mediaDir: unwritable }))).toBe(false);
    await withTasks(after(1), mail.send, [], unwritable);
    expect(await open()).toEqual(["media-not-writable"]);
    await withTasks(after(2), mail.send, []);
    expect(await open()).toEqual([]);
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Media folder not writable", "OSMLS: Media folder not writable has ended"]);
  }, 180_000);
});

describe("what cannot be sent", () => {
  const start = new Date();
  const after = (h: number) => new Date(start.getTime() + h * HOUR);

  it("with the mail server down, the report stays owed and is sent by a later run", async () => {
    await backUp(start);
    const down = async () => Promise.reject(new MailError("no", new Error("down")));
    expect((await scheduled(after(27), down)).reports).toEqual({ sent: 0, unsent: 1 });
    expect((await openConditions())[0]).toMatchObject({ Condition: "backup-overdue", LastReportedAt: null });
    const mail = inbox();
    expect((await scheduled(after(28), mail.send)).reports).toEqual({ sent: 1, unsent: 0 });
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Backup overdue"]);
  }, 180_000);

  it("with no operations address, nothing is emailed and the condition is still recorded; one never reported ends silently", async () => {
    await backUp(start);
    const mail = inbox();
    delete process.env.OPS_EMAIL;
    try {
      await scheduled(after(27), mail.send);
      expect(await open()).toEqual(["backup-overdue"]);
      await backUp(after(28));
      await scheduled(after(29), mail.send);
      expect(await open()).toEqual([]);
    } finally {
      process.env.OPS_EMAIL = OPS;
    }
    // The address is set afterwards: nothing is owed for what began and ended unreported.
    await scheduled(after(30), mail.send);
    expect(mail.delivered).toEqual([]);
  }, 180_000);
});

describe("a run that does nothing", () => {
  const start = new Date();
  const after = (h: number) => new Date(start.getTime() + h * HOUR);

  it("because another is running is recorded as skipped, is not the latest run, and reports nothing", async () => {
    await backUp(start);
    const mail = inbox();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const slow: ScheduledTask = { name: "Slow", run: async () => (started(), await held, { detail: "done" }) };
    // The first run is in the middle of its task when the second starts. A backup is overdue for both.
    const first = runScheduled({ now: after(27), send: mail.send, tasks: [slow], mediaDir: target.mediaDir });
    await running;
    const second = await runScheduled({ now: after(27.5), send: mail.send, tasks: [slow], mediaDir: target.mediaDir });
    expect(second).toEqual({ outcome: "Skipped", tasks: [], reports: { sent: 0, unsent: 0 } });
    expect(mail.delivered).toEqual([]);
    expect(await lastCompletedRun("scheduled")).toBeNull();
    release();
    expect((await first).outcome).toBe("Succeeded");

    expect((await db.select().from(jobRun).where(eq(jobRun.Job, "scheduled"))).map((r) => r.Outcome).sort()).toEqual(["Skipped", "Succeeded"]);
    expect((await lastCompletedRun("scheduled"))!.Outcome).toBe("Succeeded");
    // The condition was reported once, by the run that ran.
    expect(mail.delivered.map((m) => m.subject)).toEqual(["OSMLS: Backup overdue"]);
  }, 180_000);

  it("because the schema is another version's runs no task, records nothing and sends nothing", async () => {
    await backUp(start);
    // A copy of the migrations in which the last one differs: what a newer version of the application would hold.
    const folder = path.join(work, "other-migrations");
    cpSync("./drizzle", folder, { recursive: true });
    const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    writeFileSync(path.join(folder, `${journal.entries.at(-1)!.tag}.sql`), "-- different\n", { flag: "a" });
    const mail = inbox();
    const ran: string[] = [];
    const before = (await db.select().from(jobRun)).length;
    const attempt = runScheduled({ now: after(27), send: mail.send, tasks: [{ name: "Any", run: async () => (ran.push("Any"), { detail: "" }) }], mediaDir: target.mediaDir, migrationsFolder: folder });
    await expect(attempt).rejects.toBeInstanceOf(ScheduledRunRefused);
    await expect(attempt).rejects.toMatchObject({ reason: "schema-version" });
    expect(ran).toEqual([]);
    expect((await db.select().from(jobRun)).length).toBe(before);
    expect(mail.delivered).toEqual([]);
    expect(isReady(await readiness({ migrationsFolder: folder }))).toBe(false);
    // The lock was given back: the next run proceeds.
    expect((await scheduled(after(1), mail.send)).outcome).toBe("Succeeded");
  }, 180_000);

  it("because the database is unavailable writes one error line, sends nothing and exits with an error", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/send-alerts.ts"], {
      env: { ...process.env, DATABASE_URL: "postgres://osmls:osmls@127.0.0.1:9/unreachable", OPS_EMAIL: OPS },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("{"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", event: "scheduled-run-refused", reason: "database-unavailable" });
    expect(result.stdout).not.toContain("Reports:");
  }, 60_000);
});
