/*
 * The scheduled command: sends saved-search alerts that are due, deletes
 * client addresses, link records, and uncommitted import previews that are
 * past keeping, records how each of those went, and reports by email what is
 * wrong with the installation. Run it as often as alerts should be checked
 * for, for example hourly. A second copy started while one is running does
 * nothing.
 *
 * All of it needs the database, at the schema this version expects. If the
 * database is unavailable or its schema is another version's, no task runs
 * and nothing can be recorded or reported from here: one error line is
 * written and the command exits with an error. Noticing that is an independent monitor's job.
 */
import { pool } from "../src/db";
import { ScheduledRunRefused, runScheduled } from "../src/lib/operations";

try {
  const run = await runScheduled();
  if (run.outcome === "Skipped") console.log("Another run is in progress; nothing done.");
  for (const task of run.tasks) console.log(`${task.name}: ${task.outcome === "Failed" ? "FAILED: " : ""}${task.detail}`);
  if (run.reports.sent || run.reports.unsent) console.log(`Reports: ${run.reports.sent} sent, ${run.reports.unsent} could not be sent.`);
  if (run.outcome === "Failed") process.exitCode = 1;
} catch (err) {
  // One line, for whatever reads the log. Nothing was changed, recorded or emailed.
  const reason = err instanceof ScheduledRunRefused ? err.reason : "error";
  console.error(JSON.stringify({ level: "error", event: "scheduled-run-refused", reason, error: err instanceof Error ? err.name : "Error", at: new Date().toISOString() }));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
