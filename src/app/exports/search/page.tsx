import Link from "next/link";
import { notFound } from "next/navigation";
import { exportDisclosure, parseExportKind, searchExport } from "@/lib/exports";
import { MAX_SEARCH_RESULTS } from "@/lib/rules/local";
import { criteriaFromParams, criteriaToParams, describeCriteria } from "@/lib/search-criteria";
import { requireMember } from "@/lib/session";

type Params = Record<string, string | string[] | undefined>;

/** What a file would hold, stated before it is taken. The file itself is made again when it is downloaded. */
export default async function SearchExportPage({ searchParams }: { searchParams: Promise<Params> }) {
  const current = await requireMember();
  const p = await searchParams;
  const kind = parseExportKind(p.kind);
  if (!kind) notFound();
  // The same reading of the address as the search page, run again now.
  const criteria = criteriaFromParams(p);
  const file = await searchExport(current, criteria, kind);
  if (!file) notFound();
  const query = criteriaToParams(criteria).toString();
  const other = kind === "agent" ? "client" : "agent";
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href={`/search?${query}`} className="text-sm text-brand">
          ← Back to the search
        </Link>
        <h1 className="mt-1 text-2xl font-semibold" data-testid="export-kind">
          {kind === "client" ? "Client export" : "Agent export"}
        </h1>
        <p className="text-sm text-muted">{describeCriteria(criteria)}</p>
      </div>
      <section className="card space-y-3" data-testid="export-summary">
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="export-disclosure">
          {exportDisclosure(file, MAX_SEARCH_RESULTS).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-sm">
          <span className="font-medium">Columns:</span> <span data-testid="export-columns">{file.columns.join(", ")}</span>
        </p>
        <p className="text-sm text-muted">
          {kind === "client"
            ? "A client export holds what a client copy holds. "
            : "An agent export is for MLS members only and is not for distribution. "}
          No file holds showing instructions, lock box details, or documents. The file is made when you download it, so
          it can differ from the figures here if listings change in between. Each download is recorded.
        </p>
        <div className="flex flex-wrap gap-3">
          {/* A plain link, not a client-side one: the browser must fetch the file itself. */}
          <a href={`/exports/search/file?${query}&kind=${kind}`} className="btn" data-testid="export-download">
            Download CSV
          </a>
          <Link href={`/exports/search?${query}&kind=${other}`} className="btn-secondary">
            Switch to {other} export
          </Link>
        </div>
      </section>
    </div>
  );
}
