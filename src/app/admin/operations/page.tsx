import { notFound } from "next/navigation";
import type { JobRun } from "@/db/schema";
import { formatDateTime } from "@/lib/format";
import { CONDITIONS, getOperationsStatus, type Condition } from "@/lib/operations";
import { requireMember } from "@/lib/session";

const Check = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className="flex justify-between gap-4">
    <span>{children}</span>
    <span className={ok ? "font-medium" : "font-semibold text-red-700"}>{ok ? "OK" : "Not OK"}</span>
  </li>
);

const Tasks = ({ run }: { run: JobRun }) => (
  <ul className="text-sm">
    {run.Tasks.map((task) => (
      <li key={task.name}>
        {task.name}: {task.outcome === "Failed" ? <strong className="text-red-700">failed</strong> : "done"} <span className="text-muted">({task.detail})</span>
      </li>
    ))}
  </ul>
);

export default async function OperationsPage() {
  const current = await requireMember();
  // Null for anyone who does not manage settings: the screen does not exist for them.
  const status = await getOperationsStatus(current);
  if (!status) notFound();
  const { readiness, scheduled, backup, conditions } = status;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Operations</h1>
        <p className="text-sm text-muted">
          What this installation can tell about itself. It cannot tell you that the machine is off, that the database is
          unreachable, or that its scheduled command has stopped: a monitor outside it is needed for those.
        </p>
      </div>

      <section className="card space-y-2" aria-labelledby="conditions-heading" data-testid="conditions">
        <h2 id="conditions-heading" className="text-base font-semibold">
          Needing attention
        </h2>
        {conditions.length === 0 ? (
          <p className="text-sm">Nothing is recorded as wrong.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {conditions.map((c) => (
              <li key={c.ConditionKey}>
                <strong>{CONDITIONS[c.Condition as Condition] ?? c.Condition}</strong> since {formatDateTime(c.BeganAt)}. {c.Detail}{" "}
                <span className="text-muted">{c.LastReportedAt ? `Last emailed ${formatDateTime(c.LastReportedAt)}.` : "Not emailed."}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted" data-testid="reporting">
          {!status.reports.address
            ? "No operations address is set (OPS_EMAIL), so none of this is emailed."
            : !status.reports.mail
              ? "An operations address is set, but email is off, so none of this is emailed."
              : "Each of these is emailed to the operations address when it begins, once a day while it lasts, and when it ends."}
        </p>
      </section>

      <section className="card space-y-2" aria-labelledby="ready-heading" data-testid="readiness">
        <h2 id="ready-heading" className="text-base font-semibold">
          Able to serve
        </h2>
        <ul className="max-w-md space-y-1 text-sm">
          <Check ok={readiness.database}>The database answers</Check>
          <Check ok={readiness.schema}>Its schema is the version this application expects</Check>
          <Check ok={readiness.media}>The media folder can be written to</Check>
        </ul>
      </section>

      <section className="card space-y-2" aria-labelledby="scheduled-heading" data-testid="scheduled">
        <h2 id="scheduled-heading" className="text-base font-semibold">
          Scheduled command
        </h2>
        {scheduled.overdue && (
          <p className="text-sm font-semibold text-red-700" role="alert">
            {scheduled.last ? "No run has completed recently. It may have stopped." : "It has never completed a run here."} Alerts are not being sent and nothing on this
            screen is being reported by email.
          </p>
        )}
        {scheduled.last && (
          <>
            <p className="text-sm">
              Last completed run: {formatDateTime(scheduled.last.FinishedAt)}, {scheduled.last.Outcome === "Failed" ? <strong className="text-red-700">failed</strong> : "succeeded"}.
            </p>
            <Tasks run={scheduled.last} />
          </>
        )}
      </section>

      <section className="card space-y-2" aria-labelledby="backup-heading" data-testid="backup">
        <h2 id="backup-heading" className="text-base font-semibold">
          Backups
        </h2>
        {backup.overdue && (
          <p className="text-sm font-semibold text-red-700" role="alert">
            A backup is overdue.
          </p>
        )}
        <p className="text-sm">{backup.lastSuccessful ? `Last successful backup: ${formatDateTime(backup.lastSuccessful.FinishedAt)}.` : "No backup has succeeded yet."}</p>
        {backup.last && backup.last.Outcome === "Failed" && <p className="text-sm">The latest backup, at {formatDateTime(backup.last.FinishedAt)}, failed.</p>}
        <p className="text-sm">
          {status.mediaFolder === "this-database"
            ? "The media folder has been given to this database, so backup runs delete files that no record refers to."
            : status.mediaFolder === "another-database"
              ? "The media folder has been given to another database. Files cannot be stored here."
              : "The media folder has not been given to this database, so files of removed photos and documents stay on disk."}
        </p>
      </section>
    </div>
  );
}
