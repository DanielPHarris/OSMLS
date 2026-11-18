/*
 * Tests never touch the development or demo database. This rebuilds a separate
 * test database on the same server from scratch, then migrates and seeds it, so
 * every test run starts from the same data, locally and on GitHub.
 */
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { Client } from "pg";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL is not set. Copy it from .env.example into .env.");
if (testUrl === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must not be the same as DATABASE_URL.");

const url = new URL(testUrl);
const name = url.pathname.slice(1);
// This script deletes the database it is pointed at, so it insists on the name.
if (!/^[a-z0-9_]+_test$/.test(name))
  throw new Error(`TEST_DATABASE_URL must name a database ending in "_test", not "${name}".`);

const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`drop database if exists ${name} with (force)`);
await admin.query(`create database ${name}`);
await admin.end();
// Photos uploaded by earlier browser test runs.
await rm("./data/test-media", { recursive: true, force: true });

const env = { ...process.env, DATABASE_URL: testUrl };
for (const script of ["scripts/migrate.ts", "scripts/seed.ts"])
  execFileSync("pnpm", ["exec", "tsx", script], { env, stdio: "inherit" });
