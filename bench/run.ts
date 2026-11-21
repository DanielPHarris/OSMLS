/*
 * One benchmark run against the database in DATABASE_URL, which must be a
 * benchmark copy. Prints its result as one line of JSON.
 *
 * The application's functions are loaded only after a connection pool of the
 * chosen size has been put where the application looks for one, so the pool's
 * size is the benchmark's to choose and the application's own default is
 * untouched.
 */
import { Client, Pool } from "pg";
import type { HeldLockResult, LoadResult, Percentiles, RunRequest } from "./scratch";

const request = JSON.parse(process.argv[2]) as RunRequest;
const databaseUrl = process.env.DATABASE_URL!;
if (!/\/osmls_bench_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) throw new Error("bench/run.ts runs only against a benchmark database.");

const pool = new Pool({ connectionString: databaseUrl, max: request.mode === "load" ? request.pool : 10 });
(globalThis as unknown as { osmlsPool?: Pool }).osmlsPool = pool;
const { createListing, updateListing } = await import("../src/lib/listings");
const { formFor } = await import("./dataset");
type Actor = Parameters<typeof updateListing>[0];

const agents = new Map<string, Actor>((await pool.query(`select * from "Member"`)).rows.map((m) => [m.MemberKey, m]));
const listings = (await pool.query(`select "ListingKey", "ListAgentKey", "StreetNumber", "City" from "Property" order by "ListingId"`)).rows as {
  ListingKey: string; ListAgentKey: string; StreetNumber: string; City: string;
}[];

// Each change gives the listing a price it did not have just before: prices step through a cycle.
const visits = new Map<string, number>();
const reprice = async (listing: (typeof listings)[number]) => {
  const visit = (visits.get(listing.ListingKey) ?? 0) + 1;
  visits.set(listing.ListingKey, visit);
  const { changedFields } = await updateListing(agents.get(listing.ListAgentKey)!, listing.ListingKey, formFor(listing.StreetNumber, listing.City, 400000 + (visit % 500) * 1000));
  return changedFields.includes("ListPrice");
};

const percentiles = (values: number[]): Percentiles => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] };
};
// New listings get addresses no listing has, each writer's from a range of its own.
const enter = async (writer: number, n: number) => {
  const agent = [...agents.values()][writer % agents.size];
  await createListing(agent, formFor(String(10_000_000 + writer * 1_000_000 + n), `Benchtown new ${writer}`, 400000));
};

const waitsByTransaction = async () => (await pool.query(`select sum(waited_ms)::float8 as waited from bench_lock_wait group by txid`)).rows.map((r) => r.waited as number);
const counts = async () =>
  (
    await pool.query(
      `select (select count(*) from "HistoryTransactional")::int as history,
              (select count(*) from "HistoryTransactional" where "ChangeType" = 'Price Change')::int as price,
              (select count(*) from "Property")::int as listings`,
    )
  ).rows[0] as { history: number; price: number; listings: number };
const instrumented = async () => (await pool.query(`select to_regclass('bench_lock_wait') as t`)).rows[0].t !== null;

async function load(r: Extract<RunRequest, { mode: "load" }>): Promise<LoadResult> {
  if (listings.length < r.writers) throw new Error("The dataset has fewer listings than there are writers.");
  // Each writer has listings of its own, so no two ever wait on the same listing's row.
  const mine = (writer: number) => listings.filter((_, i) => i % r.writers === writer);
  const latencies: number[] = [];
  let priceCommits = 0;
  let newCommits = 0;
  let failures = 0;
  let everyPriceChanged = true;
  let entered = 0;
  const period = async (ms: number, counted: boolean) => {
    const until = performance.now() + ms;
    await Promise.all(
      Array.from({ length: r.writers }, async (_, writer) => {
        const own = mine(writer);
        for (let i = 0; performance.now() < until; i++) {
          const isNew = r.kind === "new" || (r.kind === "mixed" && i % 10 === 9);
          const began = performance.now();
          try {
            const changed = isNew ? (await enter(writer, entered++), true) : await reprice(own[i % own.length]);
            if (!counted) continue;
            latencies.push(performance.now() - began);
            if (isNew) newCommits++;
            else priceCommits++;
            everyPriceChanged &&= changed;
          } catch {
            if (counted) failures++;
          }
        }
      }),
    );
  };

  // The warm-up ends with every writer idle. What it did is then put out of the counts.
  await period(r.warmUpMs, false);
  const timed = await instrumented();
  if (timed) await pool.query(`truncate bench_lock_wait`);
  const before = await counts();
  const began = performance.now();
  await period(r.measureMs, true);
  const seconds = (performance.now() - began) / 1000;

  const waits = timed ? await waitsByTransaction() : null;
  const after = await counts();
  const commits = priceCommits + newCommits;
  const priceHistoryRows = after.price - before.price;
  const newListingRows = after.listings - before.listings;
  return {
    kind: r.kind, writers: r.writers, pool: r.pool, instrumented: timed, seconds, commits, priceCommits, newCommits, failures,
    transactions: waits ? waits.length : null,
    priceHistoryRows, newListingRows, historyRows: after.history - before.history,
    everyPriceChanged,
    valid: commits > 0 && everyPriceChanged && priceHistoryRows === priceCommits && newListingRows === newCommits && (!waits || waits.length === commits),
    perSecond: commits / seconds,
    latencyMs: percentiles(latencies),
    lockWaitMs: waits && waits.length ? percentiles(waits) : null,
  };
}

/**
 * Shows that the timing sees a wait when there is one. The history lock is
 * taken from another connection; a price change is started; once its session
 * is seen to be waiting for the lock, the lock is kept for a set interval and
 * then released.
 */
async function heldLock(r: Extract<RunRequest, { mode: "held-lock" }>): Promise<HeldLockResult> {
  const holder = new Client({ connectionString: databaseUrl });
  await holder.connect();
  await holder.query(`truncate bench_lock_wait`);
  await holder.query(`begin`);
  await holder.query(`select pg_advisory_xact_lock(hashtext('osmls:HistoryTransactional:sequence'))`);
  const change = reprice(listings[0]);
  let sawWaiting = false;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && !sawWaiting; ) {
    const { rows } = await holder.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
    sawWaiting = rows[0].n > 0;
    if (!sawWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, r.holdMs));
  await holder.query(`commit`);
  await holder.end();
  await change;
  const waits = await waitsByTransaction();
  return { holdMs: r.holdMs, sawWaiting, waitedMs: waits.length === 1 ? waits[0] : NaN };
}

const result = request.mode === "load" ? await load(request) : await heldLock(request);
await pool.end();
console.log(JSON.stringify(result));
