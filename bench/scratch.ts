/*
 * The benchmark's own storage (issue #42): scratch databases it creates and
 * drops on the server DATABASE_URL names. It never reads or writes the
 * development, demo or test database.
 */
import { execFileSync } from "node:child_process";
import { Client } from "pg";

export const urlFor = (database: string, base = process.env.DATABASE_URL!) => {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
};

export async function onServer<T>(work: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

const SCRATCH = /^osmls_bench_[a-z0-9_]+$/;
const checked = (name: string) => {
  // These functions drop databases, so they insist on the name.
  if (!SCRATCH.test(name)) throw new Error(`Not a benchmark database: ${name}`);
  return name;
};
export const dropDatabase = (name: string) => onServer((admin) => admin.query(`drop database if exists ${checked(name)} with (force)`));
export const copyDatabase = (name: string, template: string) => onServer((admin) => admin.query(`create database ${checked(name)} template ${checked(template)}`));

/** Runs one of the benchmark's or the application's scripts against a scratch database, and returns what it printed. */
export const runIn = (database: string, script: string, argument?: unknown): string =>
  execFileSync("pnpm", ["exec", "tsx", script, ...(argument === undefined ? [] : [JSON.stringify(argument)])], {
    env: { ...process.env, DATABASE_URL: urlFor(checked(database)), SMTP_URL: "" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const lastJson = (output: string) => JSON.parse(output.trim().split("\n").pop()!);

/*
 * The trigger every installation runs takes the history lock and hands out the
 * next sequence number. This one does the same and also records how long the
 * lock took to get. It exists only in a benchmark database.
 *
 * The record is written while the lock is held, which adds a little to every
 * change and, under load, to the queue behind it.
 */
const INSTRUMENT = `
CREATE UNLOGGED TABLE bench_lock_wait (txid bigint NOT NULL, waited_ms double precision NOT NULL);
CREATE OR REPLACE FUNCTION osmls_history_sequence_in_commit_order() RETURNS trigger AS $$
DECLARE
  asked timestamptz := clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('osmls:HistoryTransactional:sequence'));
  INSERT INTO bench_lock_wait VALUES (txid_current(), extract(epoch FROM clock_timestamp() - asked) * 1000);
  NEW."OsmlsSequence" := nextval(pg_get_serial_sequence('"HistoryTransactional"', 'OsmlsSequence'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;

export type Dataset = { offices: number; agents: number; listings: number };

/**
 * Makes the template every run starts from: migrated, holding the synthetic
 * dataset, and with the lock timing in place unless asked not to.
 */
export async function makeTemplate(name: string, dataset: Dataset, options: { instrumented?: boolean } = {}): Promise<void> {
  await dropDatabase(name);
  await onServer((admin) => admin.query(`create database ${checked(name)}`));
  runIn(name, "scripts/migrate.ts");
  runIn(name, "bench/dataset.ts", dataset);
  if (options.instrumented ?? true) {
    const client = new Client({ connectionString: urlFor(name) });
    await client.connect();
    try {
      await client.query(INSTRUMENT);
    } finally {
      await client.end();
    }
  }
}

export type RunRequest =
  | { mode: "load"; kind: "price"; writers: number; pool: number; warmUpMs: number; measureMs: number }
  | { mode: "held-lock"; holdMs: number };
export type Percentiles = { p50: number; p95: number; p99: number; max: number };
export type LoadResult = {
  kind: "price";
  writers: number;
  pool: number;
  seconds: number;
  // Counted by the benchmark, in the measured period only.
  commits: number;
  failures: number;
  // Counted by the database, in the measured period only.
  transactions: number;
  historyRows: number;
  // False if a change did not really change the price.
  everyPriceChanged: boolean;
  perSecond: number;
  latencyMs: Percentiles;
  lockWaitMs: Percentiles | null;
};
export type HeldLockResult = { holdMs: number; sawWaiting: boolean; waitedMs: number };

/** One run, in a process and a copy of the template of its own, dropped afterwards. */
export async function run<R extends RunRequest>(template: string, request: R): Promise<R extends { mode: "load" } ? LoadResult : HeldLockResult> {
  const name = `${template}_run`;
  await dropDatabase(name);
  await copyDatabase(name, template);
  try {
    return lastJson(runIn(name, "bench/run.ts", request));
  } finally {
    await dropDatabase(name);
  }
}
