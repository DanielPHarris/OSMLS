/*
 * Monitoring, through the commands an installation runs and a real mail
 * server (issue #40): `pnpm backup` and the scheduled command are run as
 * themselves against the test database, and what they email is read from the
 * mail catcher.
 *
 * Time is moved by making every recorded time 27 hours earlier, which is what
 * 27 hours passing looks like to the commands. Nothing waits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const run = Date.now();
const mailpit = process.env.MAILPIT_URL!;
const OPS = `operations-${run}@osmls.example`;
const backups = mkdtempSync(path.join(tmpdir(), "osmls-ops-e2e-"));
let db: Client;

test.beforeAll(async () => {
  if (!mailpit) throw new Error("MAILPIT_URL is not set. Copy it from .env.example into .env and run `docker compose up -d mail`.");
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  // Earlier tests leave photo and document records that never had a file. A real backup rightly refuses
  // a database like that, so those records are removed first. This test runs after all the others.
  const { rows } = await db.query(`select "MediaKey", "MediaCategory", "OsmlsStoragePath" from "Media"`);
  const fileless = rows.filter((m) => !existsSync(path.join("./data/test-media", m.MediaCategory === "Document" ? "documents" : "", m.OsmlsStoragePath)));
  if (fileless.length) await db.query(`delete from "Media" where "MediaKey" = any($1)`, [fileless.map((m) => m.MediaKey)]);
});
test.afterAll(async () => {
  await db.end();
  rmSync(backups, { recursive: true, force: true });
});

test("an overdue backup is emailed once, not again, and once more when a backup succeeds", async ({ request, baseURL }) => {
  const command = (script: string) =>
    execFileSync("pnpm", ["exec", "tsx", script], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, MEDIA_DIR: "./data/test-media", BACKUP_DIR: backups, OPS_EMAIL: OPS, BETTER_AUTH_URL: baseURL },
      encoding: "utf8",
    });
  const backUp = () => command("scripts/backup.ts");
  const scheduled = () => command("scripts/send-alerts.ts");
  /** The subjects of every email the mail catcher holds for the operations address, oldest first. */
  const received = async (count: number) => {
    let subjects: string[] = [];
    await expect(async () => {
      const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${OPS}`)}`);
      const messages = (await response.json()).messages as { Subject: string; Created: string }[];
      subjects = messages.sort((a, b) => a.Created.localeCompare(b.Created)).map((m) => m.Subject);
      expect(subjects).toHaveLength(count);
    }).toPass({ timeout: 10_000 });
    return subjects;
  };
  const hoursPass = async (hours: number) => {
    await db.query(`update "OsmlsJobRun" set "StartedAt" = "StartedAt" - make_interval(hours => $1), "FinishedAt" = "FinishedAt" - make_interval(hours => $1)`, [hours]);
    await db.query(
      `update "OsmlsCondition" set "BeganAt" = "BeganAt" - make_interval(hours => $1), "LastReportedAt" = "LastReportedAt" - make_interval(hours => $1),
         "ClearedAt" = "ClearedAt" - make_interval(hours => $1), "ClearSettledAt" = "ClearSettledAt" - make_interval(hours => $1)`,
      [hours],
    );
  };
  const overdue = async () => (await db.query(`select 1 from "OsmlsCondition" where "Condition" = 'backup-overdue' and "ClearedAt" is null`)).rowCount;

  // A backup succeeds, and the scheduled command finds nothing to report.
  expect(backUp()).toContain("Backup: ");
  scheduled();
  expect(await overdue()).toBe(0);
  expect(await received(0)).toEqual([]);

  // 27 hours pass with no backup. The scheduled command says so, once.
  await hoursPass(27);
  scheduled();
  expect(await overdue()).toBe(1);
  expect(await received(1)).toEqual(["OSMLS: Backup overdue"]);
  // The application is still in service.
  const ready = await request.get("/api/health/ready");
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toEqual({ status: "ok" });
  expect(await (await request.get("/api/health/live")).json()).toEqual({ status: "ok" });

  // An hour later it runs again and sends nothing more.
  await hoursPass(1);
  scheduled();
  expect(await received(1)).toEqual(["OSMLS: Backup overdue"]);

  // A backup succeeds. The next run says the trouble has ended, once.
  expect(backUp()).toContain("Backup: ");
  scheduled();
  expect(await overdue()).toBe(0);
  expect(await received(2)).toEqual(["OSMLS: Backup overdue", "OSMLS: Backup overdue has ended"]);
  scheduled();
  expect(await received(2)).toHaveLength(2);
});
