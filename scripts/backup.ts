/*
 * Takes one backup of the database and the photo and document files together,
 * then deletes backups beyond the number kept and files no record refers to
 * any more. If the backup fails, nothing is pruned and nothing is swept, and
 * the command exits with an error.
 *
 *   BACKUP_DIR   where backups are written (default ./data/backups)
 *   BACKUP_KEEP  how many complete backups to keep (default 14)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pruneBackups, sweepUnreferencedFiles, takeBackup } from "../src/lib/backup";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
const target = {
  databaseUrl,
  mediaDir: path.resolve(process.env.MEDIA_DIR ?? "./data/media"),
  backupDir: path.resolve(process.env.BACKUP_DIR ?? "./data/backups"),
};
const keep = Number(process.env.BACKUP_KEEP ?? 14);
const applicationVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;

const made = await takeBackup(target, { applicationVersion });
console.log(`Backup: ${made.dir} (${made.manifest.files.length} files, ${Object.values(made.manifest.tables).reduce((a, b) => a + b, 0)} records).`);
const pruned = await pruneBackups(target, keep);
console.log(`Backups: ${pruned.deleted.length} older than the last ${keep} deleted.`);
const swept = await sweepUnreferencedFiles(target);
console.log(`Files: ${swept.deleted.length} that no record refers to deleted.`);
