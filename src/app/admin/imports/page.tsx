import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { listImports } from "@/lib/imports";
import { IMPORT_PREVIEW_HOURS, LISTING_COLUMNS, MAX_IMPORT_ROWS, REQUIRED_IMPORT_COLUMNS } from "@/lib/rules/imports";
import { requireMember } from "@/lib/session";
import { previewImportAction } from "../../admin-actions";

export default async function ImportsPage() {
  const current = await requireMember();
  // Null for anyone who may not import: the page does not exist for them.
  const imports = await listImports(current);
  if (!imports) notFound();
  const optional = LISTING_COLUMNS.filter((c) => !(REQUIRED_IMPORT_COLUMNS as readonly string[]).includes(c));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Import listings</h1>
        <p className="text-sm text-muted">
          Load new listings from a CSV file. Each is checked exactly as a listing entered by hand, starts as Coming Soon
          or Active, and is dated when you commit the import. This cannot bring in an MLS&rsquo;s history: ended
          listings, past changes, and earlier dates are not imported, and no existing listing is changed.
        </p>
      </div>

      <section className="card space-y-3" aria-labelledby="upload-heading" data-testid="upload-import">
        <h2 id="upload-heading" className="text-base font-semibold">
          Upload a file
        </h2>
        <p className="text-sm text-muted">
          Nothing is created when you upload. You are shown what each row would do, and you then choose whether to
          commit. A preview that is not committed is deleted after {IMPORT_PREVIEW_HOURS} hours.
        </p>
        <ActionForm action={previewImportAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">
              System the file came from
              <input name="sourceName" required maxLength={80} className="field" />
              <span className="text-xs font-normal text-muted">
                A listing from a source is imported once. The name is compared without regard to capitals or spacing.
              </span>
            </label>
            <label className="label">
              CSV file
              <input name="file" type="file" accept=".csv,text/csv" required className="field" />
            </label>
          </div>
          <button className="btn">Upload and preview</button>
        </ActionForm>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-brand">The columns a file may have</summary>
          <p className="mt-2">
            The first row names the columns, each exactly as written here. Up to {MAX_IMPORT_ROWS} rows. A column that is
            not on this list refuses the file.
          </p>
          <p className="mt-2">
            <span className="font-medium">Required:</span> {REQUIRED_IMPORT_COLUMNS.join(", ")}
          </p>
          <p className="mt-2">
            <span className="font-medium">Optional:</span> {optional.join(", ")}
          </p>
          <p className="mt-2 text-muted">
            ListAgentMlsId is the listing agent&rsquo;s member ID. SourceListingId is the listing&rsquo;s identifier in
            the system it came from. Where a field takes several choices, separate them with |.
          </p>
        </details>
      </section>

      <section className="card overflow-x-auto" aria-labelledby="imports-heading">
        <h2 id="imports-heading" className="mb-3 text-base font-semibold">
          Imports
        </h2>
        {imports.length === 0 ? (
          <p className="text-sm text-muted">There are none.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="imports">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">File</th>
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Uploaded</th>
                <th className="py-2 pr-3">Rows</th>
                <th className="py-2">State</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr key={i.importKey} className="border-b border-line align-top last:border-0">
                  <td className="py-2 pr-3">
                    <Link href={`/admin/imports/${i.importKey}`} className="font-medium text-brand underline">
                      {i.fileName}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">{i.sourceName}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {formatDateTime(i.createdAt)}
                    <span className="block text-xs text-muted">by {i.createdBy}</span>
                  </td>
                  <td className="py-2 pr-3">{i.rows}</td>
                  <td className="py-2">
                    {i.state === "Committed" ? `Committed: ${i.created} created` : `Preview: ${i.accepted} would be created`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
