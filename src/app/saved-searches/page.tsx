import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { MAX_SAVED_NAME_LENGTH, MAX_SAVED_SEARCHES_PER_MEMBER } from "@/lib/rules/local";
import { listSavedSearches } from "@/lib/saved-work";
import { requireMember } from "@/lib/session";
import { deleteSavedSearchAction, renameSavedSearchAction } from "../saved-work-actions";

export default async function SavedSearchesPage() {
  const current = await requireMember();
  const searches = await listSavedSearches(current);
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
