import { notFound } from "next/navigation";
import { ReportView } from "@/components/report-view";
import { parseCopy, searchReport } from "@/lib/reports";
import { criteriaFromParams, criteriaToParams } from "@/lib/search-criteria";
import { requireMember } from "@/lib/session";

type Params = Record<string, string | string[] | undefined>;

export default async function SearchReportPage({ searchParams }: { searchParams: Promise<Params> }) {
  const current = await requireMember();
  const p = await searchParams;
  const copy = parseCopy(p.copy);
  if (!copy) notFound();
  // The same reading of the address as the search page, run again now.
  const criteria = criteriaFromParams(p);
  const report = await searchReport(current, criteria, copy);
  if (!report) notFound();
  const query = criteriaToParams(criteria).toString();
  return (
    <ReportView
      report={report}
      back={{ href: `/search?${query}`, label: "Back to the search" }}
      otherCopyHref={`/reports/search?${query}&copy=${copy === "agent" ? "client" : "agent"}`}
    />
  );
}
