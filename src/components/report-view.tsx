import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/format";
import { REPORT_COPIES, disclosureLines, type AgentListing, type Report } from "@/lib/reports";
import type { ClientListing } from "@/lib/rules/client-copy";
import { PrintButton } from "./print-button";

/*
 * A report on screen and on paper. It draws only what it is handed: for a client
 * copy that is the client-safe data and nothing else.
 */

type Fact = [label: string, value: string];
const list = (values: string[]) => (values.length ? values.join(", ") : null);

function clientFacts(l: ClientListing): Fact[] {
  return [
    ["Property type", l.PropertyType],
    ["Bedrooms", String(l.BedroomsTotal)],
    ["Bathrooms", String(l.BathroomsTotalInteger)],
    ["Living area", l.LivingArea ? `${l.LivingArea.toLocaleString("en-US")} sq ft` : "—"],
    ["Lot size", l.LotSizeAcres != null ? `${l.LotSizeAcres} acres` : "—"],
    ["Year built", l.YearBuilt ? String(l.YearBuilt) : "—"],
    ...(l.ClosePrice != null
      ? ([
          ["Close price", formatMoney(l.ClosePrice)],
          ["Close date", formatDate(l.CloseDate)],
        ] as Fact[])
      : []),
    ["Listed by", `${l.ListAgentFullName}, ${l.ListOfficeName}`],
  ];
}

function agentFacts(l: AgentListing): Fact[] {
  return [
    ["Days on market", `${l.daysOnMarket} (cumulative ${l.cumulativeDaysOnMarket})`],
    ["Original list price", formatMoney(l.OriginalListPrice)],
    ["County", l.CountyOrParish ?? "—"],
    ["Parcel number", l.ParcelNumber ?? "—"],
  ];
}

function showingFacts(showing: NonNullable<AgentListing["showing"]>): Fact[] {
  const facts: [string, string | null][] = [
    ["Requirements", list(showing.ShowingRequirements)],
    ["Contact", [showing.ShowingContactName, showing.ShowingContactPhone].filter(Boolean).join(", ") || null],
    ["Contact type", list(showing.ShowingContactType)],
    ["Lock box", [list(showing.LockBoxType), showing.LockBoxLocation].filter(Boolean).join(", ") || null],
    ["Instructions", showing.ShowingInstructions],
  ];
  return facts.filter((fact): fact is Fact => fact[1] != null);
}

const Facts = ({ facts }: { facts: Fact[] }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
    {facts.map(([label, value]) => (
      <div key={label} className="contents">
        <dt className="text-muted">{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

export function ReportListing({ listing, agent, single }: { listing: ClientListing; agent: AgentListing | null; single: boolean }) {
  const photos = listing.photoUrls;
  return (
    <article className="report-listing border-t border-line py-4 first:border-0" data-testid="report-listing">
      {/* The heading, first photo, and facts stay on one page. */}
      <div className="report-keep">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2 className="text-lg font-semibold">{listing.UnparsedAddress}</h2>
          <p className="text-sm text-muted">
            Listing {listing.ListingId} · {listing.StandardStatus}
          </p>
        </div>
        <p className="text-xl font-bold">{formatMoney(listing.ListPrice)}</p>
        <div className={`mt-2 grid gap-4 ${single ? "" : "grid-cols-[11rem_1fr]"}`}>
          {single ? null : photos[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photos[0]} alt="" className="h-28 w-44 rounded object-cover" />
          ) : (
            <div className="flex h-28 w-44 items-center justify-center rounded border border-line text-xs text-muted">No photo</div>
          )}
          <div className="space-y-2">
            <Facts facts={clientFacts(listing)} />
            {agent && <Facts facts={agentFacts(agent)} />}
          </div>
        </div>
      </div>
      {single && photos.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2" data-testid="report-photos">
          {photos.map((url) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={url} src={url} alt="" className="report-keep aspect-[4/3] w-full rounded object-cover" />
          ))}
        </div>
      )}
      {listing.PublicRemarks && (
        // In a list, remarks start on the page their listing is on. A single listing's
        // remarks follow its photos, which may themselves start a page.
        <p className={`${single ? "" : "report-follow "}mt-3 whitespace-pre-line text-sm`} data-testid="report-remarks">
          {listing.PublicRemarks}
        </p>
      )}
      {agent && (
        <div className="report-keep mt-3 rounded border border-line p-3" data-testid="report-showing">
          <h3 className="mb-1 text-sm font-semibold">Showing</h3>
          {agent.showing ? (
            showingFacts(agent.showing).length > 0 ? (
              <Facts facts={showingFacts(agent.showing)} />
            ) : (
              <p className="text-sm text-muted">None entered.</p>
            )
          ) : (
            <p className="text-sm text-muted">Not available to you for this listing.</p>
          )}
        </div>
      )}
    </article>
  );
}

const HEADINGS = { listing: "Listing", collection: "Listings", search: "Listings" } as const;

export function ReportView({
  report,
  back,
  otherCopyHref,
}: {
  report: Report;
  back: { href: string; label: string };
  /** The same report as the other kind of copy. */
  otherCopyHref: string;
}) {
  const lines = disclosureLines(report);
  const { preparedBy } = report;
  const other = report.copy === "agent" ? "client" : "agent";
  const notes = (where: string) =>
    lines.length > 0 && (
      <ul className="report-keep rounded border border-line p-3 text-sm" data-testid={`report-notes-${where}`}>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden" data-testid="report-toolbar">
        <Link href={back.href} className="text-sm text-brand">
          ← {back.label}
        </Link>
        <span className="ml-auto text-sm text-muted">Printing uses your browser, including &ldquo;Save as PDF&rdquo;.</span>
        <Link href={otherCopyHref} className="btn-secondary">
          Switch to {REPORT_COPIES[other].toLowerCase()}
        </Link>
        <PrintButton />
      </div>

      <div className={`report card report-${report.copy} space-y-3`} data-testid="report" data-copy={report.copy}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide" data-testid="report-copy-label">
              {report.copy === "agent" ? "Agent copy. For MLS members only. Not for distribution." : REPORT_COPIES.client}
            </p>
            <h1 className="text-2xl font-semibold">{HEADINGS[report.kind]}</h1>
            {report.copy === "agent" && report.title && <p className="text-sm text-muted">{report.title}</p>}
          </div>
          <p className="text-right text-sm" data-testid="report-prepared-by">
            Prepared by {preparedBy.name}
            {preparedBy.officeName && <span className="block">{preparedBy.officeName}</span>}
            {preparedBy.phone && <span className="block">{preparedBy.phone}</span>}
            <span className="block">{preparedBy.email}</span>
            <span className="block text-muted">{formatDate(report.preparedOn)}</span>
          </p>
        </header>
        {notes("top")}
        {report.listings.length === 0 ? (
          <p className="text-sm text-muted">No listings to show.</p>
        ) : (
          <div>
            {report.copy === "agent"
              ? report.listings.map((l) => <ReportListing key={l.ListingId} listing={l} agent={l} single={report.kind === "listing"} />)
              : report.listings.map((l) => <ReportListing key={l.ListingId} listing={l} agent={null} single={report.kind === "listing"} />)}
          </div>
        )}
        {notes("bottom")}
        <p className="text-xs text-muted">
          Information is believed to be reliable but is not guaranteed. Listings are shown as they were on{" "}
          {formatDate(report.preparedOn)}.
        </p>
      </div>
    </div>
  );
}

/** Links to both copies of a report, for the page the report is made from. */
export function ReportLinks({ href }: { href: (copy: "agent" | "client") => string }) {
  return (
    <>
      <Link href={href("agent")} className="btn-secondary">
        Print agent copy
      </Link>
      <Link href={href("client")} className="btn-secondary">
        Print client copy
      </Link>
    </>
  );
}
