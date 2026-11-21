/*
 * The restore drill (issue #37): a backup of the database and the uploaded
 * files is taken while files are being replaced and removed, everything is
 * destroyed, and the backup is restored and used.
 *
 * The drill has storage of its own. It creates two scratch databases and drops
 * them, and works in temporary folders it removes. It never reads or writes
 * the test database's listings or the development media folder. The parts that
 * use the application run as separate processes pointed at that storage
 * (tests/drill-steps.ts).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackupError, knownMigrations, listBackups, pruneBackups, restoreBackup, sweepUnreferencedFiles, takeBackup, verifyBackup, type Manifest } from "../src/lib/backup";

const run = Date.now();
const SOURCE = `osmls_drill_source_${run}`;
const RESTORED = `osmls_drill_restored_${run}`;
const urlFor = (database: string) => {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${database}`;
  return u.toString();
};
const work = mkdtempSync(path.join(tmpdir(), "osmls-drill-"));
const mediaDir = path.join(work, "media");
const restoredMediaDir = path.join(work, "restored-media");
const backupDir = path.join(work, "backups");
let admin: Client;

/** Runs a step of the drill, or one of the application's own scripts, against the drill's storage. */
const app = (script: string, database: string, media: string, ...args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { env: { ...process.env, DATABASE_URL: urlFor(database), MEDIA_DIR: media, SMTP_URL: "" }, encoding: "utf8" });
const step = (name: string, database: string, media: string, argument?: unknown) =>
  JSON.parse(app("tests/drill-steps.ts", database, media, name, ...(argument === undefined ? [] : [JSON.stringify(argument)])).trim().split("\n").pop()!);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const query = async (database: string, text: string) => {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return (await client.query(text)).rows;
  } finally {
    await client.end();
  }
};
const target = () => ({ databaseUrl: urlFor(SOURCE), mediaDir, backupDir });

beforeAll(async () => {
  admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  for (const name of [SOURCE, RESTORED]) {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  }
  // The drill's own installation: migrated and given the demo data, like a new one.
  app("scripts/migrate.ts", SOURCE, mediaDir);
  app("scripts/seed.ts", SOURCE, mediaDir);
}, 120_000);
afterAll(async () => {
  for (const name of [SOURCE, RESTORED]) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
});

describe("the restore drill", () => {
  let loaded: { listingKey: string; photos: string[]; documents: Record<string, string>; listingNumber: number; historySequence: number };
  let backup: { name: string; dir: string; manifest: Manifest };
  let before: { counts: Record<string, number>; media: { MediaKey: string; OsmlsStoragePath: string; MediaCategory: string }[]; listPrice: number };

  it("takes a backup that is unaffected by files replaced, deleted and removed while it runs", async () => {
    loaded = step("load", SOURCE, mediaDir);
    const media = await query(SOURCE, `select "MediaKey", "OsmlsStoragePath", "MediaCategory" from "Media" order by "MediaKey"`);
    expect(media).toHaveLength(5);
    before = {
      counts: Object.fromEntries((await query(SOURCE, `select 'Media' as t, count(*)::int as n from "Media" union all select 'Property', count(*)::int from "Property" union all select 'HistoryTransactional', count(*)::int from "HistoryTransactional"`)).map((r) => [r.t, r.n])),
      media: media as typeof before.media,
      listPrice: 500000,
    };

    backup = await takeBackup(target(), {
      applicationVersion: "drill",
      // Between the snapshot and the copying of files: a document is replaced, another deleted, and a photo removed.
      afterSnapshot: async () => {
        step("change-during-backup", SOURCE, mediaDir, loaded);
      },
    });

    // The live system has moved on: three records are gone or changed.
    expect(await query(SOURCE, `select count(*)::int as n from "Media"`)).toEqual([{ n: 3 }]);
    // The backup holds the snapshot: all five records' files, each as it was.
    expect(backup.manifest.tables["public.Media"]).toBe(5);
    expect(backup.manifest.files).toHaveLength(5);
    expect(backup.manifest.files.map((f) => f.path).sort()).toEqual(before.media.map((m) => (m.MediaCategory === "Document" ? path.join("documents", m.OsmlsStoragePath) : m.OsmlsStoragePath)).sort());
    expect(await listBackups(backupDir)).toEqual([backup.name]);
    expect(readdirSync(backupDir).filter((e) => e.startsWith("incomplete-"))).toEqual([]);
    // Nothing was deleted from the media folder by the removals: the superseded files are still there.
    for (const file of backup.manifest.files) expect(sha(path.join(mediaDir, file.path)), file.path).toBe(file.sha256);
  }, 120_000);

  it("restores the database and the files together after everything is destroyed, and the result can be used", async () => {
    // Things that happen after the backup, and are therefore lost.
    const later = step("change-after-backup", SOURCE, mediaDir, loaded);

    // Destroyed: the database, and the media folder with every file in it.
    await admin.query(`drop database ${SOURCE} with (force)`);
    rmSync(mediaDir, { recursive: true, force: true });

    const manifest = await restoreBackup(backup.dir, { databaseUrl: urlFor(RESTORED), mediaDir: restoredMediaDir }, { knownMigrations: await knownMigrations() });
    expect(manifest).toEqual(backup.manifest);

    // The records are the snapshot's.
    const counts = Object.fromEntries((await query(RESTORED, `select 'Media' as t, count(*)::int as n from "Media" union all select 'Property', count(*)::int from "Property" union all select 'HistoryTransactional', count(*)::int from "HistoryTransactional"`)).map((r) => [r.t, r.n]));
    expect(counts).toEqual(before.counts);
    const media = await query(RESTORED, `select "MediaKey", "OsmlsStoragePath", "MediaCategory", "OsmlsFileHash" from "Media" order by "MediaKey"`);
    expect(media.map((m) => m.MediaKey)).toEqual(before.media.map((m) => m.MediaKey));
    // Every record has its file, with the manifest's hash: including the document that was replaced (as the
    // original), the document that was deleted, and the photo that was removed.
    for (const record of media) {
      const relative = record.MediaCategory === "Document" ? path.join("documents", record.OsmlsStoragePath) : record.OsmlsStoragePath;
      const saved = manifest.files.find((f) => f.path === relative)!;
      expect(sha(path.join(restoredMediaDir, relative)), relative).toBe(saved.sha256);
      if (record.OsmlsFileHash) expect(record.OsmlsFileHash, relative).toBe(saved.sha256);
    }
    const original = media.find((m) => m.MediaKey === loaded.documents.replaced)!;
    expect(readFileSync(path.join(restoredMediaDir, "documents", original.OsmlsStoragePath), "utf8")).toContain("the original");
    expect(media.map((m) => m.MediaKey)).toEqual(expect.arrayContaining([loaded.documents.deleted, loaded.photos[1]]));
    // Only the files the snapshot refers to were restored.
    expect(readdirSync(restoredMediaDir).filter((e) => e !== "documents").length + readdirSync(path.join(restoredMediaDir, "documents")).length).toBe(5);

    // What happened after the backup is absent.
    expect(await query(RESTORED, `select count(*)::int as n from "Property" where "ListingKey" = '${later.laterListingKey}'`)).toEqual([{ n: 0 }]);

    // The restored system is used. The migration step finds nothing to do, a member signs in, and a new listing
    // takes the next listing number and the next place in history: neither starts again.
    expect(app("scripts/migrate.ts", RESTORED, restoredMediaDir)).toContain("Migrations applied.");
    const used = step("use-after-restore", RESTORED, restoredMediaDir);
    expect(used.signedIn).toBe(true);
    expect(used.restoredListPrice).toBe(before.listPrice);
    // Before anything new is done, the restored system is where the snapshot was: the same highest listing number
    // and the same place in history as when the files were loaded, with none of what came after.
    expect(used.before).toEqual({ listingNumber: loaded.listingNumber, historySequence: loaded.historySequence });
    expect(used.newListingNumber).toBe(loaded.listingNumber + 1);
    expect(used.after.historySequence).toBeGreaterThan(used.before.historySequence);
  }, 180_000);

  it("refuses to restore over anything, a backup that has been altered, and a backup from a newer schema", async () => {
    const known = await knownMigrations();
    const empty = path.join(work, "empty-media");
    // The restored database now holds an installation: it is not overwritten.
    await expect(restoreBackup(backup.dir, { databaseUrl: urlFor(RESTORED), mediaDir: empty }, { knownMigrations: known })).rejects.toThrow("The database is not empty.");
    // Nor is a folder with anything in it.
    await expect(restoreBackup(backup.dir, { databaseUrl: urlFor("postgres"), mediaDir: restoredMediaDir }, { knownMigrations: known })).rejects.toThrow("The media folder is not empty.");
    // A backup made at a schema this application does not know.
    await expect(restoreBackup(backup.dir, { databaseUrl: urlFor("postgres"), mediaDir: empty }, { knownMigrations: known.slice(0, -1) })).rejects.toThrow(/schema this version of the application does not know/);
    await expect(restoreBackup(backup.dir, { databaseUrl: urlFor("postgres"), mediaDir: empty }, { knownMigrations: ["something-else", ...known.slice(1)] })).rejects.toThrow(/schema this version/);

    // A file changed after the backup was made, and a file missing from it.
    const victim = path.join(backup.dir, "files", backup.manifest.files[0].path);
    const good = readFileSync(victim);
    writeFileSync(victim, "altered");
    await expect(verifyBackup(backup.dir)).rejects.toThrow(/does not match its manifest/);
    await expect(restoreBackup(backup.dir, { databaseUrl: urlFor("postgres"), mediaDir: empty }, { knownMigrations: known })).rejects.toThrow(BackupError);
    rmSync(victim);
    await expect(verifyBackup(backup.dir)).rejects.toThrow(/missing or has been altered/);
    writeFileSync(victim, good);
    await expect(verifyBackup(backup.dir)).resolves.toMatchObject({ format: 1 });
  }, 60_000);
});

describe("a backup that does not complete", () => {
  it("leaves no backup, is never listed, and causes nothing to be pruned", async () => {
    const scratch = `osmls_drill_failing_${run}`;
    await admin.query(`create database ${scratch}`);
    const media = path.join(work, "failing-media");
    const backups = path.join(work, "failing-backups");
    try {
      app("scripts/migrate.ts", scratch, media);
      app("scripts/seed.ts", scratch, media);
      const loaded = step("load", scratch, media);
      const here = { databaseUrl: urlFor(scratch), mediaDir: media, backupDir: backups };
      const good = await takeBackup(here, { applicationVersion: "drill" });

      // A file a record refers to has gone missing from the disk: there is no state to save.
      const [document] = await query(scratch, `select "OsmlsStoragePath" from "Media" where "MediaKey" = '${loaded.documents.kept}'`);
      const lost = path.join(media, "documents", document.OsmlsStoragePath);
      const bytes = readFileSync(lost);
      rmSync(lost);
      await expect(takeBackup(here, { applicationVersion: "drill" })).rejects.toThrow(/A file a record refers to is missing/);
      // A document whose bytes no longer match the hash recorded for it.
      writeFileSync(lost, "not what was uploaded");
      await expect(takeBackup(here, { applicationVersion: "drill" })).rejects.toThrow(/does not match the hash recorded/);
      // A backup interrupted from outside, part-way through.
      await expect(takeBackup(here, { applicationVersion: "drill", afterSnapshot: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");

      // None of the three exists, in any form. The good backup is still the only one, and still good.
      expect(await listBackups(backups)).toEqual([good.name]);
      expect(readdirSync(backups)).toEqual([good.name]);
      await expect(verifyBackup(good.dir)).resolves.toBeTruthy();

      // Pruning keeps the newest complete backups, and counts only complete ones.
      writeFileSync(lost, bytes);
      const second = await takeBackup(here, { applicationVersion: "drill" });
      const third = await takeBackup(here, { applicationVersion: "drill" });
      expect(await pruneBackups(here, 2)).toEqual({ deleted: [good.name] });
      expect(await listBackups(backups)).toEqual([third.name, second.name].sort().reverse());
    } finally {
      await admin.query(`drop database if exists ${scratch} with (force)`);
    }
  }, 180_000);
});

describe("files no record refers to", () => {
  it("are deleted by the sweep and by nothing else, and the files in use are kept", async () => {
    const scratch = `osmls_drill_sweep_${run}`;
    await admin.query(`create database ${scratch}`);
    const media = path.join(work, "sweep-media");
    try {
      app("scripts/migrate.ts", scratch, media);
      app("scripts/seed.ts", scratch, media);
      const loaded = step("load", scratch, media);
      step("change-during-backup", scratch, media, loaded);
      const here = { databaseUrl: urlFor(scratch), mediaDir: media };
      const onDisk = () => readdirSync(media).filter((e) => e !== "documents").length + readdirSync(path.join(media, "documents")).length;
      // Removing and replacing deleted no file: five were uploaded, a sixth replaced one, and all six remain.
      expect(onDisk()).toBe(6);
      // The sweep deletes the three that no record refers to, and keeps the three in use.
      const swept = await sweepUnreferencedFiles(here);
      expect(swept.deleted).toHaveLength(3);
      expect(onDisk()).toBe(3);
      const kept = await query(scratch, `select "OsmlsStoragePath", "MediaCategory" from "Media"`);
      for (const record of kept) expect(readFileSync(path.join(media, record.MediaCategory === "Document" ? "documents" : "", record.OsmlsStoragePath)).length).toBeGreaterThan(0);
      // And a backup taken now is whole.
      await expect(takeBackup({ ...here, backupDir: path.join(work, "sweep-backups") }, { applicationVersion: "drill" })).resolves.toBeTruthy();
    } finally {
      await admin.query(`drop database if exists ${scratch} with (force)`);
    }
  }, 180_000);
});

describe("backups, pruning and uploads at the same moment", () => {
  const scratch = `osmls_drill_overlap_${run}`;
  const media = path.join(work, "overlap-media");
  const backups = path.join(work, "overlap-backups");
  const here = { databaseUrl: urlFor(scratch), mediaDir: media, backupDir: backups };
  let loaded: { listingKey: string };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const filesOnDisk = () => readdirSync(media).filter((e) => e !== "documents");

  beforeAll(async () => {
    await admin.query(`create database ${scratch}`);
    app("scripts/migrate.ts", scratch, media);
    app("scripts/seed.ts", scratch, media);
    loaded = step("load", scratch, media);
  }, 120_000);
  afterAll(() => admin.query(`drop database if exists ${scratch} with (force)`));

  it("never removes a running backup's files by pruning, and lets overlapping backups both complete", async () => {
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const running = new Promise<void>((resolve) => (reached = resolve));
    // A backup that is part-way through: its snapshot taken, its files not yet copied.
    const first = takeBackup(here, { applicationVersion: "drill", afterSnapshot: async () => { reached(); await held; } });
    await running;
    const working = readdirSync(backups).filter((e) => e.startsWith("incomplete-"));
    expect(working).toHaveLength(1);

    // Meanwhile, as an on-demand run overlapping the scheduled one would: pruning, and a second backup.
    let pruned = false;
    const pruning = pruneBackups(here, 14).then((result) => { pruned = true; return result; });
    const second = takeBackup(here, { applicationVersion: "drill" });
    await pause(1500);
    // The running backup's working folder is untouched, and the pruning has not gone ahead without it.
    expect(readdirSync(backups).filter((e) => e.startsWith("incomplete-"))).toEqual(working);
    expect(pruned).toBe(false);

    release();
    const [a, b] = await Promise.all([first, second]);
    await pruning;
    // Both backups completed and are whole; nothing incomplete is left.
    expect((await listBackups(backups)).sort()).toEqual([a.name, b.name].sort());
    for (const made of [a, b]) await expect(verifyBackup(made.dir)).resolves.toBeTruthy();
    expect(readdirSync(backups).filter((e) => e.startsWith("incomplete-"))).toEqual([]);
  }, 120_000);

  it("removes what an abandoned backup left behind, once no backup is running", async () => {
    // A working folder with no backup behind it, as a run that was killed would leave.
    mkdirSync(path.join(backups, "incomplete-backup-20200101T000000Z-abcdef", "files"), { recursive: true });
    const before = await listBackups(backups);
    expect((await pruneBackups(here, 14)).deleted).toEqual([]);
    expect(readdirSync(backups).filter((e) => e.startsWith("incomplete-"))).toEqual([]);
    expect(await listBackups(backups)).toEqual(before);
  }, 60_000);

  it("never deletes the file of an upload that is still in progress, however long it takes", async () => {
    const before = new Set(filesOnDisk());
    // The listing is held by another transaction, so the upload has written its file and is waiting to record it.
    const holder = new Client({ connectionString: urlFor(scratch) });
    await holder.connect();
    try {
    await holder.query("begin");
    await holder.query(`select 1 from "Property" where "ListingKey" = '${loaded.listingKey}' for update`);
    const upload = new Promise<{ mediaKey: string; file: string }>((resolve, reject) => {
      const child = spawn("pnpm", ["exec", "tsx", "tests/drill-steps.ts", "upload-photo", JSON.stringify(loaded)], { env: { ...process.env, DATABASE_URL: urlFor(scratch), MEDIA_DIR: media, SMTP_URL: "" } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(`upload exited ${code}: ${out}`))));
    });
    let written: string[] = [];
    for (let i = 0; i < 100 && written.length === 0; i++) {
      await pause(100);
      written = filesOnDisk().filter((f) => !before.has(f));
    }
    expect(written).toHaveLength(1);
    // The upload has been stuck for a long time: its file is hours old, and no record refers to it yet.
    const longAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(path.join(media, written[0]), longAgo, longAgo);

    let swept = false;
    const sweeping = sweepUnreferencedFiles(here).then((result) => { swept = true; return result; });
    await pause(1500);
    // The sweep has not deleted it, and has not finished: it waits for the upload.
    expect(filesOnDisk()).toContain(written[0]);
    expect(swept).toBe(false);

    await holder.query("rollback");
    const uploaded = await upload;
    const result = await sweeping;
    expect(uploaded.file).toBe(written[0]);
    expect(result.deleted).not.toContain(written[0]);
    // The record exists and so does its file.
    expect(await query(scratch, `select count(*)::int as n from "Media" where "MediaKey" = '${uploaded.mediaKey}'`)).toEqual([{ n: 1 }]);
    expect(readFileSync(path.join(media, uploaded.file)).length).toBeGreaterThan(0);
    } finally {
      // Whatever happened above, the listing is let go, so nothing is left waiting on it.
      await holder.end().catch(() => {});
    }
  }, 120_000);
});

describe("a backup made by an earlier version", () => {
  it("is restored as it was, and the migration step then brings it forward", async () => {
    const older = `osmls_drill_older_${run}`;
    const restored = `osmls_drill_older_restored_${run}`;
    for (const name of [older, restored]) await admin.query(`create database ${name}`);
    try {
      // An installation one migration behind this one: migrated from a copy of the migrations without the newest.
      const folder = path.join(work, "older-drizzle");
      cpSync("drizzle", folder, { recursive: true });
      const journalFile = path.join(folder, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8"));
      const newest = journal.entries.pop();
      writeFileSync(journalFile, JSON.stringify(journal));
      const client = new Client({ connectionString: urlFor(older) });
      await client.connect();
      await migrate(drizzle(client), { migrationsFolder: folder });
      await client.query(`insert into "Office" ("OfficeMlsId", "OfficeName") values ('OLD1', 'From the older version')`);
      await client.end();
      const known = await knownMigrations();
      const backups = path.join(work, "older-backups");
      const made = await takeBackup({ databaseUrl: urlFor(older), mediaDir: path.join(work, "older-media"), backupDir: backups }, { applicationVersion: "older" });
      expect(made.manifest.schema.migrations).toEqual(known.slice(0, -1));

      const media = path.join(work, "older-restored-media");
      await restoreBackup(made.dir, { databaseUrl: urlFor(restored), mediaDir: media }, { knownMigrations: known });
      // Restored as it was: the older schema, without what the newest migration adds.
      const tables = async () => (await query(restored, `select table_name from information_schema.tables where table_schema = 'public'`)).map((r) => r.table_name);
      const added = /CREATE TABLE "([^"]+)"/.exec(readFileSync(path.join("drizzle", `${newest.tag}.sql`), "utf8"))![1];
      expect(await tables()).not.toContain(added);
      expect(await query(restored, `select "OfficeName" from "Office"`)).toEqual([{ OfficeName: "From the older version" }]);
      // The application's own migration step brings it to the current schema, and the data is still there.
      expect(app("scripts/migrate.ts", restored, media)).toContain("Migrations applied.");
      expect(await tables()).toContain(added);
      expect((await query(restored, `select count(*)::int as n from drizzle.__drizzle_migrations`))[0].n).toBe(known.length);
      expect(await query(restored, `select "OfficeName" from "Office"`)).toEqual([{ OfficeName: "From the older version" }]);
    } finally {
      for (const name of [older, restored]) await admin.query(`drop database if exists ${name} with (force)`);
    }
  }, 180_000);
});

