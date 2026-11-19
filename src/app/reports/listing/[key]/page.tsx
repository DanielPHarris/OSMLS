import Link from "next/link";
import { notFound } from "next/navigation";
import { ReportView } from "@/components/report-view";
import { listingReport, parseCopy } from "@/lib/reports";
import { CLIENT_COPY_STATUSES } from "@/lib/rules/client-copy";
import { requireMember } from "@/lib/session";

export default async function ListingReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ copy?: string | string[] }>;
}) {
  const current = await requireMember();
  const { key } = await params;
  // No default: a report is one kind of copy or the other, by name.
  const copy = parseCopy((await searchParams).copy);
  if (!copy) notFound();
  const report = await listingReport(current, key, copy);
  if (!report) notFound();
  const listingHref = `/listings/${key}`;
  if ("refused" in report) {
    return (
      <div className="card space-y-3" data-testid="report-refused">
        <h1 className="text-xl font-semibold">No client copy for this listing</h1>
        <p className="text-sm">
          This listing is {report.status}. Client copies are made only for {CLIENT_COPY_STATUSES.join(", ")} listings.
        </p>
        <Link href={listingHref} className="text-sm text-brand">
          ← Back to the listing
        </Link>
      </div>
    );
  }
  return (
    <ReportView
      report={report}
      back={{ href: listingHref, label: "Back to the listing" }}
      otherCopyHref={`/reports/listing/${key}?copy=${copy === "agent" ? "client" : "agent"}`}
    />
  );
}
