/*
 * Monitoring (issue #40): the health checks, the record of each backup and
 * scheduled run, and reporting what is wrong by email, once when it begins,
 * once a day while it lasts, and once when it ends.
 *
 * Runs and conditions are recorded in the test database. The backups
 * themselves are of a scratch database with folders of its own. The mail
 * server is stood in for by a function.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as live } from "../src/app/api/health/live/route";
import { GET as ready } from "../src/app/api/health/ready/route";
import { db } from "../src/db";
import { jobRun, operatingCondition } from "../src/db/schema";
import type { Mail } from "../src/lib/mail";
import { isReady, openConditions, readiness, runBackup, runScheduled } from "../src/lib/operations";

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
