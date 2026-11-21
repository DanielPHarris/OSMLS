import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

/*
 * Backing up and restoring an installation: its database and its photo and
 * document files, together.
 *
 * A backup is a state the system was actually in. It is made from one database
 * snapshot: the dump is of that snapshot, and the files copied are the ones
 * that snapshot refers to. That is enough because of two things the rest of
 * the application keeps to. A file is never changed once written: every upload
 * goes under a new generated name, and its record is committed only after the
 * file is complete. And a file is not deleted when its record is: files no
 * record refers to are deleted only by `sweepUnreferencedFiles`, which takes
 * the same lock a backup holds. So every file the snapshot refers to is still
 * there, whole, when it is copied, whatever is uploaded, replaced or removed
 * meanwhile, and the application stays in use throughout.
 *
 * A backup is complete or it does not exist: it is written under a name that
 * marks it incomplete, checked against its manifest, and only then given its
 * final name. One backup runs at a time; another started meanwhile waits for
 * it. Nothing here uses the application's own database connection, so
 * the same functions serve the scheduled command, the restore command, and a
 * drill against storage of its own.
 */

export const BACKUP_FORMAT = 1;
const COMPLETE = /^backup-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
/**
 * Held by a backup from before its working folder exists until it has a final
 * name or is gone, by pruning, and by the sweep. So a folder with an
 * incomplete name is abandoned, and safe to remove, exactly when this lock can
 * be taken: no backup is running.
 */
const BACKUP_LOCK = `hashtext('osmls:backup')`;

/**
 * Held shared by every upload from before its file is written until its record
 * is committed, and exclusively by the sweep. So while the sweep looks for
 * files no record refers to, no upload is part-way through: every file on disk
 * either has its record or never will. An upload does not wait for a backup,
 * only, briefly, for a sweep.
 */
export const FILES_LOCK = `hashtext('osmls:files')`;

export type Manifest = {
  format: number;
  createdAt: string;
  application: { version: string };
  /** The migrations the database had applied, oldest first, by their content hash. */
  schema: { migrations: string[] };
  database: { file: string; bytes: number; sha256: string; serverVersion: number };
  /** How many records each table held in the snapshot. */
  tables: Record<string, number>;
  /** Every file the snapshot refers to, by its path under the media folder. */
  files: { path: string; bytes: number; sha256: string }[];
};

export class BackupError extends Error {}

// ---- The PostgreSQL tools ----

/*
 * pg_dump and pg_restore must be of the server's major version. Where the ones
 * on the PATH are, they are used. Where they are not (a developer's machine, a
 * test runner), the same tools are run from the PostgreSQL image of the
 * server's version, which a machine running the database in Docker already
 * has. OSMLS_PG_TOOLS=path or =docker settles it without looking.
 */
function toolCommand(tool: "pg_dump" | "pg_restore", serverMajor: number, url: string, args: string[]): { command: string; args: string[] } {
  const direct = { command: tool, args: [...args, `--dbname=${url}`] };
  const wanted = process.env.OSMLS_PG_TOOLS;
  if (wanted === "path") return direct;
  if (wanted !== "docker") {
    const found = spawnSync(tool, ["--version"], { encoding: "utf8" });
    const major = Number(/\(PostgreSQL\) (\d+)/.exec(found.stdout ?? "")?.[1]);
    if (found.status === 0 && major === serverMajor) return direct;
  }
  // From inside a container, the machine's own "localhost" is reached by another name.
  const inside = new URL(url);
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(inside.hostname)) inside.hostname = "host.docker.internal";
  return {
    command: "docker",
    args: ["run", "--rm", "-i", "--add-host=host.docker.internal:host-gateway", `postgres:${serverMajor}`, tool, ...args, `--dbname=${inside.toString()}`],
  };
}

/** Runs one of the tools, with a file as its input or its output, and fails loudly with what it said. */
function runTool(tool: "pg_dump" | "pg_restore", serverMajor: number, url: string, args: string[], io: { stdoutTo?: string; stdinFrom?: string }): Promise<void> {
  const { command, args: full } = toolCommand(tool, serverMajor, url, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, full, { stdio: [io.stdinFrom ? "pipe" : "ignore", io.stdoutTo ? "pipe" : "ignore", "pipe"] });
    let said = "";
    child.stderr!.on("data", (chunk) => (said += chunk));
    if (io.stdoutTo) child.stdout!.pipe(createWriteStream(io.stdoutTo));
    if (io.stdinFrom) createReadStream(io.stdinFrom).pipe(child.stdin!);
    child.on("error", (err) => reject(new BackupError(`${tool} could not be run: ${err.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new BackupError(`${tool} failed: ${said.trim().slice(-600)}`))));
  });
}

const hashFile = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

const serverMajorOf = async (client: Client) => Math.floor(Number((await client.query("show server_version_num")).rows[0].server_version_num) / 10000);

/** Where a media record's file is, under the media folder. Documents are kept in a folder of their own. */
const filePathOf = (record: { MediaCategory: string; OsmlsStoragePath: string }) =>
  record.MediaCategory === "Document" ? path.join("documents", path.basename(record.OsmlsStoragePath)) : path.basename(record.OsmlsStoragePath);

async function referencedFiles(client: Client) {
  const { rows } = await client.query(`select "MediaCategory", "OsmlsStoragePath", "OsmlsFileHash" from "Media" where "OsmlsStoragePath" is not null order by "MediaKey"`);
  return rows as { MediaCategory: string; OsmlsStoragePath: string; OsmlsFileHash: string | null }[];
}

async function tableCounts(client: Client): Promise<Record<string, number>> {
  const tables = (await client.query(`select table_schema, table_name from information_schema.tables where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE' order by 1, 2`)).rows;
  const counts: Record<string, number> = {};
  for (const t of tables) counts[`${t.table_schema}.${t.table_name}`] = Number((await client.query(`select count(*) as n from "${t.table_schema}"."${t.table_name}"`)).rows[0].n);
  return counts;
}

const appliedMigrations = async (client: Client): Promise<string[]> =>
  (await client.query(`select hash from drizzle.__drizzle_migrations order by id`)).rows.map((r) => r.hash as string);

/**
 * The migrations this copy of the application can apply, oldest first, each by
 * the hash the migration step records for it once applied.
 */
export async function knownMigrations(folder = "./drizzle"): Promise<string[]> {
  const journal = JSON.parse(await readFile(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const hashes: string[] = [];
  for (const entry of journal.entries) hashes.push(createHash("sha256").update(await readFile(path.join(folder, `${entry.tag}.sql`), "utf8")).digest("hex"));
  return hashes;
}

// ---- Taking a backup ----

export type BackupTarget = { databaseUrl: string; mediaDir: string; backupDir: string };

/**
 * Takes one backup and returns its folder, or throws and leaves no backup.
 *
 * `afterSnapshot` runs once the snapshot is taken and before any file is
 * copied. It exists for the restore drill, which changes files at exactly that
 * moment to show that the backup is unaffected.
 */
export async function takeBackup(target: BackupTarget, options: { applicationVersion: string; afterSnapshot?: () => Promise<void> }): Promise<{ name: string; dir: string; manifest: Manifest }> {
  const createdAt = new Date();
  const stamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `backup-${stamp}-${randomBytes(3).toString("hex")}`;
  const working = path.join(target.backupDir, `incomplete-${name}`);

  // One connection holds the lock for the whole backup; another holds the snapshot.
  const lock = new Client({ connectionString: target.databaseUrl });
  const snapshot = new Client({ connectionString: target.databaseUrl });
  await lock.connect();
  await snapshot.connect();
  try {
    // The lock first, and only then the working folder: a working folder never exists without its backup holding the lock.
    await lock.query(`select pg_advisory_lock(${BACKUP_LOCK})`);
    await mkdir(path.join(working, "files", "documents"), { recursive: true });
    await snapshot.query("begin isolation level repeatable read read only");
    const snapshotId = (await snapshot.query("select pg_export_snapshot() as id")).rows[0].id as string;
    const serverMajor = await serverMajorOf(snapshot);
    // Read from the snapshot, so that these describe exactly what the dump holds.
    const records = await referencedFiles(snapshot);
    const tables = await tableCounts(snapshot);
    const migrations = await appliedMigrations(snapshot);
    const dump = path.join(working, "database.dump");
    await runTool("pg_dump", serverMajor, target.databaseUrl, ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshotId}`], { stdoutTo: dump });
    await snapshot.query("commit");

    await options.afterSnapshot?.();

    const files: Manifest["files"] = [];
    for (const record of records) {
      const relative = filePathOf(record);
      const copy = path.join(working, "files", relative);
      try {
        await copyFile(path.join(target.mediaDir, relative), copy);
      } catch {
        throw new BackupError(`A file a record refers to is missing: ${relative}. No backup was made.`);
      }
      const sha256 = await hashFile(copy);
      if (record.OsmlsFileHash && record.OsmlsFileHash !== sha256) throw new BackupError(`A document does not match the hash recorded for it: ${relative}. No backup was made.`);
      files.push({ path: relative, bytes: (await stat(copy)).size, sha256 });
    }
    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      createdAt: createdAt.toISOString(),
      application: { version: options.applicationVersion },
      schema: { migrations },
      database: { file: "database.dump", bytes: (await stat(dump)).size, sha256: await hashFile(dump), serverVersion: serverMajor },
      tables,
      files,
    };
    await writeFile(path.join(working, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    // Checked as a restore would check it, and only then given the name that makes it a backup.
    await verifyBackup(working);
    const dir = path.join(target.backupDir, name);
    await rename(working, dir);
    return { name, dir, manifest };
  } catch (err) {
    await rm(working, { recursive: true, force: true });
    throw err;
  } finally {
    await snapshot.end().catch(() => {});
    await lock.end().catch(() => {});
  }
}

/** A backup's manifest, after checking that everything it lists is there and unaltered. Throws if not. */
export async function verifyBackup(dir: string): Promise<Manifest> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    throw new BackupError("This is not a complete backup: it has no readable manifest.");
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupError(`This backup is in a format this version does not read (${manifest.format}).`);
  const check = async (relative: string, expected: { bytes: number; sha256: string }) => {
    const file = path.join(dir, relative);
    const size = await stat(file).then((s) => s.size, () => -1);
    if (size !== expected.bytes || (await hashFile(file)) !== expected.sha256) throw new BackupError(`The backup does not match its manifest: ${relative} is missing or has been altered.`);
  };
  await check(manifest.database.file, manifest.database);
  for (const file of manifest.files) await check(path.join("files", file.path), file);
  return manifest;
}

/** The complete backups in a directory, newest first. A backup that did not finish is not among them. */
export async function listBackups(backupDir: string): Promise<string[]> {
  const entries = await readdir(backupDir).catch(() => [] as string[]);
  return entries.filter((e) => COMPLETE.test(e)).sort().reverse();
}

/**
 * Deletes the oldest complete backups beyond the number to keep, and what an
 * abandoned backup left behind. It holds the backup lock while it does, so it
 * waits for any backup that is running: a working folder it finds belongs to
 * no one. Called only after a backup has completed, so a run of failures never
 * removes a good backup.
 */
export async function pruneBackups(target: Pick<BackupTarget, "databaseUrl" | "backupDir">, keep: number): Promise<{ deleted: string[] }> {
  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    await client.query(`select pg_advisory_lock(${BACKUP_LOCK})`);
    const complete = await listBackups(target.backupDir);
    const deleted = complete.slice(Math.max(keep, 1));
    for (const name of deleted) await rm(path.join(target.backupDir, name), { recursive: true, force: true });
    for (const entry of await readdir(target.backupDir).catch(() => [] as string[])) {
      if (entry.startsWith("incomplete-")) await rm(path.join(target.backupDir, entry), { recursive: true, force: true });
    }
    return { deleted };
  } finally {
    await client.end().catch(() => {});
  }
}

// ---- Deleting files nothing refers to ----

/**
 * Deletes photo and document files that no record refers to. This is the only
 * place such a file is deleted.
 *
 * It holds the backup lock, so it never runs while a backup is between its
 * snapshot and its copy. And it holds the files lock exclusively, which every
 * upload holds shared from before it writes its file until its record is
 * committed. So it waits for uploads in progress, however long they take, and
 * none can begin while it works: a file it finds with no record is one whose
 * upload failed or whose record has been removed, never one still on its way.
 */
export async function sweepUnreferencedFiles(target: Pick<BackupTarget, "databaseUrl" | "mediaDir">): Promise<{ deleted: string[] }> {
  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    await client.query(`select pg_advisory_lock(${BACKUP_LOCK})`);
    await client.query(`select pg_advisory_lock(${FILES_LOCK})`);
    const referenced = new Set((await referencedFiles(client)).map(filePathOf));
    const deleted: string[] = [];
    for (const folder of ["", "documents"]) {
      for (const entry of await readdir(path.join(target.mediaDir, folder), { withFileTypes: true }).catch(() => [])) {
        const relative = path.join(folder, entry.name);
        if (!entry.isFile() || referenced.has(relative)) continue;
        await unlink(path.join(target.mediaDir, relative));
        deleted.push(relative);
      }
    }
    return { deleted };
  } finally {
    await client.end().catch(() => {});
  }
}

// ---- Restoring ----

export type RestoreTarget = { databaseUrl: string; mediaDir: string };

/**
 * Restores a backup into an empty database and an empty media folder, and
 * checks the result against the manifest. It overwrites nothing: a database
 * that holds anything, or a folder that holds anything, is refused.
 *
 * `knownMigrations` is what the application doing the restore can apply,
 * oldest first. A backup whose schema it does not know (one made by a newer
 * version) is refused. One made by an older version is restored as it was;
 * the application's migration step then brings it forward.
 */
export async function restoreBackup(dir: string, target: RestoreTarget, options: { knownMigrations: readonly string[] }): Promise<Manifest> {
  const manifest = await verifyBackup(dir);
  const known = options.knownMigrations;
  if (manifest.schema.migrations.length > known.length || manifest.schema.migrations.some((hash, i) => hash !== known[i])) {
    throw new BackupError("This backup was made at a schema this version of the application does not know. Restore it with the version that made it, or a later one.");
  }
  const existing = await readdir(target.mediaDir).catch(() => [] as string[]);
  if (existing.length > 0) throw new BackupError("The media folder is not empty. A backup is restored only into an empty folder.");

  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_%' and c.relkind in ('r', 'S', 'v', 'm')`);
    if (rows[0].n > 0) throw new BackupError("The database is not empty. A backup is restored only into an empty database.");
    const serverMajor = await serverMajorOf(client);
    if (serverMajor < manifest.database.serverVersion) throw new BackupError(`This backup was made on PostgreSQL ${manifest.database.serverVersion} and cannot be restored on ${serverMajor}.`);
    await runTool("pg_restore", serverMajor, target.databaseUrl, ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"], { stdinFrom: path.join(dir, manifest.database.file) });

    await mkdir(path.join(target.mediaDir, "documents"), { recursive: true });
    for (const file of manifest.files) await copyFile(path.join(dir, "files", file.path), path.join(target.mediaDir, file.path));

    // What was restored is checked against what was saved, record for record and file for file.
    const counts = await tableCounts(client);
    for (const [table, n] of Object.entries(manifest.tables)) if (counts[table] !== n) throw new BackupError(`After the restore, ${table} holds ${counts[table] ?? 0} records and the backup recorded ${n}.`);
    const saved = new Map(manifest.files.map((f) => [f.path, f.sha256]));
    for (const record of await referencedFiles(client)) {
      const relative = filePathOf(record);
      const restored = await hashFile(path.join(target.mediaDir, relative)).catch(() => null);
      if (!restored || restored !== saved.get(relative)) throw new BackupError(`After the restore, a record's file is missing or differs: ${relative}.`);
    }
    return manifest;
  } finally {
    await client.end().catch(() => {});
  }
}
