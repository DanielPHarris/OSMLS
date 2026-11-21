/*
 * Gives the media folder in MEDIA_DIR to the database in DATABASE_URL, so that
 * `pnpm backup` may delete files in it that no record refers to any more.
 *
 * Run this only if that database is the only one that uses the folder. Files
 * that some other database put there would be deleted by the next backup run,
 * and that other database could no longer upload to it.
 */
import path from "node:path";
import { claimMediaFolder } from "../src/lib/backup";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
const mediaDir = path.resolve(process.env.MEDIA_DIR ?? "./data/media");
const claimed = await claimMediaFolder({ databaseUrl, mediaDir });
console.log(claimed.already ? `${mediaDir} already belongs to this database.` : `${mediaDir} now belongs to this database. Its backup runs will delete files there that no record refers to.`);
