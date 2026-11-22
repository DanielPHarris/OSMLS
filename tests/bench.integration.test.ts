/*
 * The listing-change benchmark (issue #42), run small: that its timing of the
 * history lock sees a wait when there is one, and that what it counts agrees
 * with what the database recorded.
 *
 * Nothing here is a performance threshold. The one timing assertion tests the
 * measuring instrument against a lock held on purpose for a known time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KINDS, dropDatabase, makeTemplate, run } from "../bench/scratch";

const TEMPLATE = `osmls_bench_test_${Date.now()}`;

beforeAll(() => makeTemplate(TEMPLATE, { offices: 2, agents: 8, listings: 80 }), 180_000);
afterAll(() => dropDatabase(TEMPLATE));

describe("the benchmark's timing of the history lock", () => {
  it("records at least the time a held lock made a waiting change wait", async () => {
    const held = await run(TEMPLATE, { mode: "held-lock", holdMs: 400 });
    // The change was seen waiting for the lock before the interval began.
    expect(held.sawWaiting).toBe(true);
    expect(held.waitedMs).toBeGreaterThanOrEqual(400);
  }, 120_000);
});

describe("a small run", () => {
  for (const [kind, writers] of [["price", 1], ["price", 8], ["new", 8], ["mixed", 8]] as const) {
    it(`of ${KINDS[kind].toLowerCase()} with ${writers} writer${writers === 1 ? "" : "s"} counts what the database recorded, and nothing from the warm-up`, async () => {
      const result = await run(TEMPLATE, { mode: "load", kind, writers, pool: 10, warmUpMs: 300, measureMs: 1000 });
      expect(result.commits).toBeGreaterThan(0);
      expect(result.failures).toBe(0);
      // One transaction for each change; one price-change history row for each price change, which
      // really changed the price; one listing for each new listing.
      expect(result.transactions).toBe(result.commits);
      expect(result.priceHistoryRows).toBe(result.priceCommits);
      expect(result.newListingRows).toBe(result.newCommits);
      expect(result.everyPriceChanged).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.lockWaitMs).not.toBeNull();
      if (kind === "price") expect(result.newCommits).toBe(0);
      if (kind === "new") expect(result.priceCommits).toBe(0);
      if (kind === "mixed") expect(result.newCommits).toBeGreaterThan(0);
    }, 120_000);
  }

  it("without the lock timing still counts, and says it has no lock waits", async () => {
    const plain = `${TEMPLATE}_plain`;
    await makeTemplate(plain, { offices: 1, agents: 2, listings: 10 }, { instrumented: false });
    try {
      const result = await run(plain, { mode: "load", kind: "price", writers: 1, pool: 10, warmUpMs: 200, measureMs: 500 });
      expect(result).toMatchObject({ instrumented: false, transactions: null, lockWaitMs: null, failures: 0, valid: true });
      expect(result.priceHistoryRows).toBe(result.commits);
    } finally {
      await dropDatabase(plain);
    }
  }, 180_000);
});
