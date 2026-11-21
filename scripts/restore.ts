/*
 * Restores a backup into the database in DATABASE_URL and the folder in
 * MEDIA_DIR. Both must be empty: nothing is overwritten.
 *
 *   pnpm restore ./data/backups/backup-20261121T010203Z-ab12cd
 *
 * Afterwards run `pnpm db:migrate`, which changes nothing if the backup was
 * made by this version and brings an older backup's schema forward.
 */
import path from "node:path";
import { knownMigrations, restoreBackup } from "../src/lib/backup";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("Name the backup folder to restore.");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
const manifest = await restoreBackup(path.resolve(dir), { databaseUrl, mediaDir: path.resolve(process.env.MEDIA_DIR ?? "./data/media") }, { knownMigrations: await knownMigrations() });
console.log(`Restored the backup of ${manifest.createdAt}: ${manifest.files.length} files, ${Object.values(manifest.tables).reduce((a, b) => a + b, 0)} records. Run pnpm db:migrate next.`);
