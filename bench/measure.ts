/*
 * Measures what committing listing changes one at a time costs (issue #42):
 * throughput, latency and time waiting for the history lock, at increasing
 * numbers of simultaneous writers.
 *
 *   pnpm measure                      the full exercise: about 45 minutes
 *   pnpm measure --seconds 2 --warm-up 1 --repeats 1 --listings 500
 *                                     a quick look that the command works
 *
 *   --listings N   listings in the synthetic dataset (default 10000)
 *   --seconds N    measured seconds for each run (default 20)
 *   --warm-up N    seconds before measuring, not counted (default 5)
 *   --repeats N    times each level is run (default 3)
 *   --note TEXT    what the command cannot find out for itself: the storage,
 *                  and where PostgreSQL runs
 *   --out DIR      where the results are written (default bench/results)
 *
 * It works in databases named osmls_bench_*, which it creates on the server
 * DATABASE_URL names and drops. It reads and writes no other database. Run it
 * on a machine doing nothing else: it is a timing exercise, and is not part of
 * the checks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KINDS, dropDatabase, makeTemplate, onServer, run, type HeldLockResult, type Kind, type LoadResult, type Percentiles } from "./scratch";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const listings = Number(option("listings", "10000"));
const measureMs = Number(option("seconds", "20")) * 1000;
const warmUpMs = Number(option("warm-up", "5")) * 1000;
const repeats = Number(option("repeats", "3"));
const note = option("note", "");
const out = path.resolve(option("out", "bench/results"));

const WRITERS = [1, 2, 4, 8, 16, 32, 64];
/** The pool the application ships with. */
const SHIPPED_POOL = 10;
// Beyond the shipped pool a call may wait for a connection first, so these levels are also run with a pool as large as the writers.
const ALSO_WITH_OWN_POOL = WRITERS.filter((w) => w > SHIPPED_POOL);
const dataset = { offices: Math.max(1, Math.round(listings / 500)), agents: Math.max(64, Math.round(listings / 50)), listings };

const stamp = Date.now();
const TIMED = `osmls_bench_${stamp}_timed`;
const PLAIN = `osmls_bench_${stamp}_plain`;
const say = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${text}`);

const server = await onServer(async (admin) => {
  const setting = async (name: string) => (await admin.query(`show ${name}`)).rows[0][name] as string;
  return {
    version: await setting("server_version"),
    shared_buffers: await setting("shared_buffers"),
    synchronous_commit: await setting("synchronous_commit"),
    fsync: await setting("fsync"),
    max_connections: await setting("max_connections"),
  };
});
const machine = {
  processor: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  memoryGb: Math.round(os.totalmem() / 2 ** 30),
  system: `${os.type()} ${os.release()} ${os.arch()}`,
  node: process.version,
  note,
};

type Plan = { kind: Kind; writers: number; pool: number };
const plans: Plan[] = (Object.keys(KINDS) as Kind[]).flatMap((kind) => [
  ...WRITERS.map((writers) => ({ kind, writers, pool: SHIPPED_POOL })),
  ...ALSO_WITH_OWN_POOL.map((writers) => ({ kind, writers, pool: writers })),
]);

let held: HeldLockResult;
const results: (LoadResult & { repeat: number })[] = [];
const plain: LoadResult[] = [];
try {
  say(`Building the dataset twice: ${dataset.listings} listings, ${dataset.agents} agents, ${dataset.offices} offices.`);
  await makeTemplate(TIMED, dataset);
  await makeTemplate(PLAIN, dataset, { instrumented: false });

  held = await run(TIMED, { mode: "held-lock", holdMs: 500 });
  say(`Instrument check: a change seen waiting (${held.sawWaiting}) for a lock held ${held.holdMs} ms recorded a wait of ${held.waitedMs.toFixed(1)} ms.`);
  if (!held.sawWaiting || !(held.waitedMs >= held.holdMs)) throw new Error("The lock timing did not record a held lock. Its figures would mean nothing, so nothing was measured.");

  // One writer with and without the timing, for an estimate of what the timing itself costs.
  for (let repeat = 1; repeat <= repeats; repeat++) plain.push(await run(PLAIN, { mode: "load", kind: "price", writers: 1, pool: SHIPPED_POOL, warmUpMs, measureMs }));
  say(`Without the timing, one writer: ${plain.map((r) => r.perSecond.toFixed(0)).join(", ")} price changes a second.`);

  for (const [n, plan] of plans.entries()) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const result = await run(TIMED, { mode: "load", ...plan, warmUpMs, measureMs });
      results.push({ ...result, repeat });
      say(`${n + 1}/${plans.length} ${plan.kind}, ${plan.writers} writers, pool ${plan.pool}, run ${repeat}: ${result.perSecond.toFixed(0)} a second${result.valid ? "" : "  NOT VALID"}`);
    }
  }
} finally {
  await dropDatabase(TIMED);
  await dropDatabase(PLAIN);
}

// ---- The report ----

const ms = (n: number) => (n < 1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(1));
const four = (p: Percentiles | null) => (p ? `${ms(p.p50)} / ${ms(p.p95)} / ${ms(p.p99)} / ${ms(p.max)}` : "not timed");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const range = (values: number[], show: (n: number) => string) => `${show(median(values))} (${show(Math.min(...values))} to ${show(Math.max(...values))})`;
const whole = (n: number) => n.toFixed(0);

const timedOne = results.filter((r) => r.kind === "price" && r.writers === 1 && r.pool === SHIPPED_POOL);
const lines: string[] = [
  "# Listing changes: measured throughput, latency and lock wait",
  "",
  `Run on ${new Date().toISOString().slice(0, 10)} by \`pnpm measure\`. Every figure below is from this one run on this one machine.`,
  "",
  "## Machine",
  "",
  `- Processor: ${machine.processor}, ${machine.cores} cores. Memory: ${machine.memoryGb} GB. System: ${machine.system}. Node.js ${machine.node}.`,
  `- PostgreSQL ${server.version}: shared_buffers ${server.shared_buffers}, synchronous_commit ${server.synchronous_commit}, fsync ${server.fsync}, max_connections ${server.max_connections}.`,
  ...(note ? [`- ${note}`] : []),
  "- The benchmark, the application's code and the database all ran on this machine.",
  "",
  "## Dataset and method",
  "",
  `- A synthetic benchmark dataset: ${dataset.listings} listings, ${dataset.agents} agents, ${dataset.offices} office${dataset.offices === 1 ? "" : "s"}. It is not a model of any MLS.`,
  `- Each run: a copy of the same dataset, ${warmUpMs / 1000} seconds of warm-up that is not counted, then ${measureMs / 1000} seconds measured. Each level was run ${repeats} time${repeats === 1 ? "" : "s"}.`,
  "- Writers call the application's own functions for changing and entering listings. Each price-change writer has listings of its own.",
  `- The pool is the number of database connections the writers share. The application ships with ${SHIPPED_POOL}.`,
  "- Lock wait is the time a change waited for the history lock, recorded by a trigger that exists only in the benchmark's database.",
  "",
  "## Instrument check",
  "",
  `A price change was seen waiting for the history lock, which was then held for ${held.holdMs} ms. The wait recorded for it was ${held.waitedMs.toFixed(1)} ms.`,
  "",
  "## What the lock timing itself costs",
  "",
  `One writer changing prices, pool ${SHIPPED_POOL}: ${range(plain.map((r) => r.perSecond), whole)} a second without the timing, ${range(timedOne.map((r) => r.perSecond), whole)} with it (median, lowest to highest of ${repeats}).`,
  "",
  "This is an estimate of the timing's cost with one writer. It is not a correction for the other results: the record is written while the lock is held, and work done while holding the lock can lengthen the queue behind it under load.",
  "",
  "## Summary",
  "",
  `Median of ${repeats} runs, with the lowest and highest. Times are milliseconds.`,
  "",
];
for (const kind of Object.keys(KINDS) as Kind[]) {
  lines.push(`### ${KINDS[kind]}`, "", "| Writers | Pool | Commits a second | Latency, median | Latency, 99th percentile | Lock wait, median | Lock wait, 99th percentile |", "| ---: | ---: | --- | --- | --- | --- | --- |");
  for (const plan of plans.filter((p) => p.kind === kind)) {
    const runs = results.filter((r) => r.kind === kind && r.writers === plan.writers && r.pool === plan.pool && r.valid);
    if (!runs.length) {
      lines.push(`| ${plan.writers} | ${plan.pool} | no valid run | | | | |`);
      continue;
    }
    const wait = (pick: (p: Percentiles) => number) => range(runs.map((r) => pick(r.lockWaitMs!)), ms);
    lines.push(`| ${plan.writers} | ${plan.pool} | ${range(runs.map((r) => r.perSecond), whole)} | ${range(runs.map((r) => r.latencyMs.p50), ms)} | ${range(runs.map((r) => r.latencyMs.p99), ms)} | ${wait((p) => p.p50)} | ${wait((p) => p.p99)} |`);
  }
  lines.push("");
}
lines.push(
  "## Every run",
  "",
  "Latency and lock wait are median / 95th / 99th percentile / longest, in milliseconds. A run is valid when the commits the benchmark counted are the transactions, price-change history rows and new listings the database recorded.",
  "",
  "| Workload | Writers | Pool | Run | Commits | Failures | A second | Latency | Lock wait | Valid |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
  ...results.map((r) => `| ${r.kind} | ${r.writers} | ${r.pool} | ${r.repeat} | ${r.commits} | ${r.failures} | ${whole(r.perSecond)} | ${four(r.latencyMs)} | ${four(r.lockWaitMs)} | ${r.valid ? "yes" : "NO"} |`),
  ...plain.map((r, i) => `| price, lock not timed | 1 | ${r.pool} | ${i + 1} | ${r.commits} | ${r.failures} | ${whole(r.perSecond)} | ${four(r.latencyMs)} | not timed | ${r.valid ? "yes" : "NO"} |`),
  "",
);

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "RESULTS.md"), lines.join("\n"));
writeFileSync(path.join(out, "results.json"), JSON.stringify({ machine, server, dataset, warmUpMs, measureMs, repeats, held, plain, results }, null, 2));
const invalid = results.filter((r) => !r.valid).length + plain.filter((r) => !r.valid).length;
say(`Written to ${out}. ${results.length + plain.length} runs, ${invalid} not valid.`);
if (invalid) process.exitCode = 1;
