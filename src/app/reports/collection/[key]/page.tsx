import { notFound } from "next/navigation";
import { ReportView } from "@/components/report-view";
import { collectionReport, parseCopy } from "@/lib/reports";
import { requireMember } from "@/lib/session";

export default async function CollectionReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ copy?: string | string[] }>;
}) {
  const current = await requireMember();
  const { key } = await params;
  const copy = parseCopy((await searchParams).copy);
  if (!copy) notFound();
  // Null for someone else's collection and for one that does not exist alike.
  const report = await collectionReport(current, key, copy);
  if (!report) notFound();
  return (
    <ReportView
      report={report}
      back={{ href: `/collections/${key}`, label: "Back to the collection" }}
      otherCopyHref={`/reports/collection/${key}?copy=${copy === "agent" ? "client" : "agent"}`}
    />
  );
}
