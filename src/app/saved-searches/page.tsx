import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { MAX_SAVED_NAME_LENGTH, MAX_SAVED_SEARCHES_PER_MEMBER } from "@/lib/rules/local";
import { countActivity, type ActivityCount } from "@/lib/activity";
import { ALERT_FREQUENCIES, pauseNotice } from "@/lib/alerts";
import { mailEnabled } from "@/lib/mail";
import { listSavedSearches } from "@/lib/saved-work";
import { requireMember } from "@/lib/session";
import { deleteSavedSearchAction, renameSavedSearchAction, resumeAlertAction, setAlertAction } from "../saved-work-actions";

function activityLabel(count: ActivityCount | undefined): string {
  if (!count || count.listings === 0) return "No new activity";
  if (count.more) return `Activity on ${count.listings} or more listings`;
  return `Activity on ${count.listings} ${count.listings === 1 ? "listing" : "listings"}`;
}

export default async function SavedSearchesPage() {
  const current = await requireMember();
  const searches = await listSavedSearches(current);
  // Counting activity never marks it as seen.
  const activity = await countActivity(current);
  const email = mailEnabled();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Saved searches</h1>
        <p className="text-sm text-muted">
          Yours alone: no one else can see or change these. To add one, run a search and choose &ldquo;Save this
          search&rdquo;. You have {searches.length} of {MAX_SAVED_SEARCHES_PER_MEMBER}.
        </p>
      </div>
      {searches.length === 0 ? (
        <p className="card text-sm text-muted">
          No saved searches yet. <Link href="/search" className="text-brand underline">Go to search</Link>.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="saved-searches">
          {searches.map((s) => (
            <li key={s.SavedSearchKey} className="card">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <Link href={`/saved-searches/${s.SavedSearchKey}/run`} className="font-semibold text-brand underline">
                    {s.SavedSearchName}
                  </Link>
                  <p className="text-sm text-muted">{s.SearchQueryHumanReadable}</p>
                  <p className="mt-1 text-sm" data-testid="activity-count">
                    <Link href={`/saved-searches/${s.SavedSearchKey}/activity`} className="text-brand underline">
                      {activityLabel(activity.get(s.SavedSearchKey))}
                    </Link>
                  </p>
                </div>
                <Link href={`/saved-searches/${s.SavedSearchKey}/run`} className="btn">
                  Run
                </Link>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <ActionForm action={renameSavedSearchAction.bind(null, s.SavedSearchKey)} className="flex flex-wrap items-end gap-3">
                  <label className="label">
                    Rename
                    <input
                      name="name"
                      defaultValue={s.SavedSearchName}
                      required
                      maxLength={MAX_SAVED_NAME_LENGTH}
                      aria-label={`New name for ${s.SavedSearchName}`}
                      className="field"
                    />
                  </label>
                  <button className="btn-secondary">Save name</button>
                </ActionForm>
                <ActionForm action={deleteSavedSearchAction.bind(null, s.SavedSearchKey)}>
                  <button className="btn-secondary" aria-label={`Delete ${s.SavedSearchName}`}>
                    Delete
                  </button>
                </ActionForm>
              </div>
              <div className="mt-3 border-t border-line pt-3" data-testid="alert">
                {email || s.OsmlsAlertFrequency ? (
                  <ActionForm action={setAlertAction.bind(null, s.SavedSearchKey)} className="flex flex-wrap items-end gap-3">
                    <label className="label">
                      Email alerts
                      <select
                        name="frequency"
                        defaultValue={s.OsmlsAlertFrequency ?? "off"}
                        aria-label={`Email alerts for ${s.SavedSearchName}`}
                        className="field"
                      >
                        <option value="off">Off</option>
                        {Object.entries(ALERT_FREQUENCIES).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="btn-secondary" aria-label={`Save email alerts for ${s.SavedSearchName}`}>
                      Save alert
                    </button>
                    <p className="w-full text-xs text-muted">
                      Sent to {current.MemberEmail} when this search has new activity, at most once a day (daily) or once
                      a week (weekly). An email says how many listings changed and links here; it never marks activity as seen.
                    </p>
                  </ActionForm>
                ) : (
                  <p className="text-sm text-muted">Email alerts are not available: email is not set up on this system.</p>
                )}
                {pauseNotice(s.OsmlsAlertPaused) && (
                  <div className="mt-2 rounded bg-amber-50 p-3 text-sm" role="note" data-testid="alert-paused">
                    <p>{pauseNotice(s.OsmlsAlertPaused)}</p>
                    <ActionForm action={resumeAlertAction.bind(null, s.SavedSearchKey)} className="mt-2">
                      <button className="btn-secondary" aria-label={`Resume email alerts for ${s.SavedSearchName}`}>
                        Resume alerts
                      </button>
                    </ActionForm>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
