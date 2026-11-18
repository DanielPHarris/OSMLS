/*
 * Tests never touch the development or demo database. This creates a separate
 * test database on the same server if it is missing, then migrates and seeds it.
 */
import { execFileSync } from "node:child_process";
import { Client } from "pg";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL is not set. Copy it from .env.example into .env.");
if (testUrl === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must not be the same as DATABASE_URL.");

const url = new URL(testUrl);
const name = url.pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsupported test database name: ${name}`);

const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
if (exists.rowCount === 0) await admin.query(`create database ${name}`);
await admin.end();

const env = { ...process.env, DATABASE_URL: testUrl };
for (const script of ["scripts/migrate.ts", "scripts/seed.ts"])
  execFileSync("pnpm", ["exec", "tsx", script], { env, stdio: "inherit" });
