/*
 * Overlaps made certain rather than likely. A second connection takes the lock
 * an operation needs, the operation is started and left waiting on it, the
 * second connection makes its change and commits, and only then does the
 * operation go on. What the operation then does shows what it read, and when.
 */
import { Client } from "pg";
import { expect } from "vitest";

/** The lock every change to anyone's status, role, or capabilities takes. */
export const AUTHORITY_TURN = `select pg_advisory_xact_lock(hashtext('osmls:member:authority'))`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Starts `operation` while `lock` is held elsewhere, makes `change` under that lock, then lets the operation go on. */
export async function overlapping<T>(lock: string, change: string, operation: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  const other = new Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  try {
    await other.query("begin");
    await other.query(lock);
    let done = false;
    let waitedForTheLock = false;
    const waiting = operation().finally(() => (done = true));
    const [result] = await Promise.allSettled([
      waiting,
      (async () => {
        await settle();
        waitedForTheLock = !done;
        await other.query(change);
        await other.query("commit");
      })(),
    ]);
    // It was held up by the lock, so whatever it relied on it read afterwards.
    expect(waitedForTheLock).toBe(true);
    return result;
  } finally {
    await other.end();
  }
}
