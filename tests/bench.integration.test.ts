/*
 * The listing-change benchmark (issue #42), run small: that its timing of the
 * history lock sees a wait when there is one, and that what it counts agrees
 * with what the database recorded.
 *
 * Nothing here is a performance threshold. The one timing assertion tests the
 * measuring instrument against a lock held on purpose for a known time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropDatabase, makeTemplate, run } from "../bench/scratch";

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
  for (const writers of [1, 8]) {
    it(`with ${writers} writer${writers === 1 ? "" : "s"} counts what the database recorded, and nothing from the warm-up`, async () => {
      const result = await run(TEMPLATE, { mode: "load", kind: "price", writers, pool: 10, warmUpMs: 300, measureMs: 1000 });
      console.log(JSON.stringify(result));
      expect(result.commits).toBeGreaterThan(0);
      expect(result.failures).toBe(0);
      // One transaction and one history row for each price change, and each really changed the price.
      expect(result.transactions).toBe(result.commits);
      expect(result.historyRows).toBe(result.commits);
      expect(result.everyPriceChanged).toBe(true);
      expect(result.lockWaitMs).not.toBeNull();
    }, 120_000);
  }
});
