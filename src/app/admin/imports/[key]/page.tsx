import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { getImport } from "@/lib/imports";
import { requireMember } from "@/lib/session";
import { commitImportAction } from "../../../admin-actions";

const OUTCOME = { Accepted: "Would be created", Refused: "Refused", Duplicate: "Left out: possible duplicate" } as const;

export default async function ImportPage({ params }: { params: Promise<{ key: string }> }) {
  const current = await requireMember();
  // Null for anyone who may not import, for an import that does not exist, and for a preview that has expired, alike.
  const found = await getImport(current, (await params).key);
  if (!found) notFound();
  const committed = found.import.State === "Committed";
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/imports" className="text-sm text-brand">
          ← All imports
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{found.import.FileName}</h1>
        <p className="text-sm text-muted">
          From {found.import.SourceName}. Uploaded {formatDateTime(found.import.OriginalEntryTimestamp)} by {found.import.createdBy}.
        </p>
      </div>

      <section className="card space-y-3" data-testid="import-summary">
        <h2 className="text-base font-semibold" data-testid="import-state">
          {committed ? "Committed" : "Preview: nothing has been created"}
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li data-testid="import-accepted">
            {found.accepted} {found.accepted === 1 ? "row" : "rows"} {committed ? "created a listing" : "would create a listing"}.
          </li>
          <li data-testid="import-refused">
            {found.refused} {found.refused === 1 ? "row was" : "rows were"} refused.
          </li>
          <li data-testid="import-duplicates">
            {found.duplicates} {found.duplicates === 1 ? "row was" : "rows were"} left out as possible duplicates.
          </li>
        </ul>
        {!committed && (
          <>
            <p className="text-sm text-muted">
              Committing creates exactly the rows marked &ldquo;Would be created&rdquo;, all of them or none. Every row is
              checked again when you commit; if any no longer passes, nothing is created and this preview is brought up
              to date. Rows that were refused or left out are never created. Each listing is recorded as made by you, on
              behalf of its listing agent.
            </p>
            {found.accepted > 0 ? (
              <ActionForm action={commitImportAction.bind(null, found.import.ImportKey)}>
                <button className="btn">
                  Commit: create {found.accepted} {found.accepted === 1 ? "listing" : "listings"}
                </button>
              </ActionForm>
            ) : (
              <p className="text-sm">There is nothing to commit. Correct the file and upload it again.</p>
            )}
          </>
        )}
      </section>

      <section className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm" data-testid="import-rows">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-3">Row</th>
              <th className="py-2 pr-3">Source ID</th>
              <th className="py-2 pr-3">{committed ? "Listing" : "For"}</th>
              <th className="py-2 pr-3">Outcome</th>
              <th className="py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            {found.rows.map((row) => (
              <tr key={row.RowNumber} className="border-b border-line align-top last:border-0" data-testid="import-row">
                <td className="py-2 pr-3">{row.RowNumber}</td>
                <td className="py-2 pr-3">{row.SourceListingId || "—"}</td>
                <td className="py-2 pr-3">
                  {row.listingKey ? (
                    <Link href={`/listings/${row.listingKey}`} className="font-medium text-brand underline">
                      {row.listingId}
                    </Link>
                  ) : (
                    <>
                      {row.address ?? "—"}
                      {row.listAgentMlsId && <span className="block text-xs text-muted">Agent {row.listAgentMlsId}</span>}
                    </>
                  )}
                </td>
                <td className="py-2 pr-3" data-testid="import-row-outcome">
                  {row.listingKey ? "Created" : OUTCOME[row.Outcome as keyof typeof OUTCOME]}
                </td>
                <td className="py-2">
                  {row.Reasons.length === 0 ? "" : row.Reasons.map((reason) => <div key={reason}>{reason}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
