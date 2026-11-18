import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { fieldLabel, formatDate, formatDateTime, formatHistoryValue, formatMoney } from "@/lib/format";
import { canEdit, canViewHistory, getHistory, getListing } from "@/lib/listings";
import type { StandardStatus } from "@/lib/lookups";
import { isTerminal } from "@/lib/rules/status";
import { requireMember } from "@/lib/session";

const NOTICES: Record<string, string> = {
  created: "Listing created.",
  saved: "Changes saved.",
  unchanged: "Nothing was changed.",
};

export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const current = await requireMember();
  const found = await getListing((await params).key);
  if (!found) notFound();
  const { listing, agent, office, photos } = found;
  const notice = NOTICES[(await searchParams).notice ?? ""];
  const isStaff = current.OsmlsRole === "staff";
  const editable = canEdit(current, listing) && (isStaff || !isTerminal(listing.StandardStatus as StandardStatus));
  const history = canViewHistory(current) ? await getHistory(listing.ListingKey) : null;

  const facts: [string, string][] = [
    ["Property type", listing.PropertyType],
    ["Bedrooms", String(listing.BedroomsTotal)],
    ["Bathrooms", String(listing.BathroomsTotalInteger)],
    ["Living area", listing.LivingArea ? `${listing.LivingArea.toLocaleString("en-US")} sq ft` : "—"],
    ["Lot size", listing.LotSizeAcres != null ? `${listing.LotSizeAcres} acres` : "—"],
    ["Year built", listing.YearBuilt ? String(listing.YearBuilt) : "—"],
    ["Listing contract date", formatDate(listing.ListingContractDate)],
    ["On market date", formatDate(listing.OnMarketDate)],
    ["Original list price", formatMoney(listing.OriginalListPrice)],
    ...(listing.StandardStatus === "Closed"
      ? ([
          ["Close price", formatMoney(listing.ClosePrice)],
          ["Close date", formatDate(listing.CloseDate)],
        ] as [string, string][])
      : []),
    ["Last changed", formatDateTime(listing.ModificationTimestamp)],
  ];

  return (
    <div className="space-y-6">
      {notice && (
        <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-900">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted">
            Listing <span data-testid="listing-id">{listing.ListingId}</span>
          </p>
          <h1 className="text-2xl font-semibold">{listing.UnparsedAddress}</h1>
          <div className="mt-2 flex items-center gap-3">
            <span className="text-2xl font-bold" data-testid="list-price">
              {formatMoney(listing.ListPrice)}
            </span>
            <StatusBadge status={listing.StandardStatus} />
          </div>
        </div>
        {editable && (
          <Link href={`/listings/${listing.ListingKey}/edit`} className="btn">
            {isStaff ? "Correct listing" : "Edit listing"}
          </Link>
        )}
      </div>

      {photos.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((p) => (
            <li key={p.MediaKey}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/media/${p.MediaKey}`} alt={`Photo ${p.Order} of ${listing.UnparsedAddress}`} className="aspect-[4/3] w-full rounded-lg object-cover" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="card text-sm text-muted">No photos have been added to this listing.</p>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <section className="card md:col-span-2">
          <h2 className="text-base font-semibold">Details</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                <dd className="text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-5 text-sm font-semibold">Public remarks</h3>
          <p className="mt-1 whitespace-pre-line text-sm">{listing.PublicRemarks ?? "—"}</p>
        </section>
        <section className="card">
          <h2 className="text-base font-semibold">Listing agent</h2>
          <p className="mt-3 text-sm font-medium">{agent.MemberFullName}</p>
          <p className="text-sm text-muted">Member ID {agent.MemberMlsId}</p>
          <p className="mt-2 text-sm">{office.OfficeName}</p>
          <p className="text-sm text-muted">Office ID {office.OfficeMlsId}</p>
          <p className="mt-2 text-sm">{agent.MemberEmail}</p>
          {agent.MemberDirectPhone && <p className="text-sm">{agent.MemberDirectPhone}</p>}
        </section>
      </div>

      {history && (
        <section className="card overflow-x-auto" aria-labelledby="history-heading">
          <h2 id="history-heading" className="text-base font-semibold">
            Change history
          </h2>
          <p className="text-sm text-muted">Visible to MLS staff only. Entries cannot be edited or deleted.</p>
          <table className="mt-3 w-full border-collapse" data-testid="history-table">
            <thead>
              <tr className="border-b border-line">
                <th className="th">When</th>
                <th className="th">Who</th>
                <th className="th">Field</th>
                <th className="th">Previous</th>
                <th className="th">New</th>
                <th className="th">Note</th>
              </tr>
            </thead>
            <tbody>
              {history.map(({ entry, changedByName, changedByRole }) => (
                <tr key={entry.HistoryTransactionalKey} className="border-b border-line last:border-0">
                  <td className="td whitespace-nowrap">{formatDateTime(entry.ModificationTimestamp)}</td>
                  <td className="td">
                    {changedByName}
                    <span className="block text-xs text-muted">
                      {entry.ChangedByMemberID} · {changedByRole === "staff" ? "MLS staff" : "Agent"}
                    </span>
                  </td>
                  <td className="td">{fieldLabel(entry.FieldName)}</td>
                  <td className="td">{formatHistoryValue(entry.FieldName, entry.PreviousValue)}</td>
                  <td className="td">{formatHistoryValue(entry.FieldName, entry.NewValue)}</td>
                  <td className="td">
                    {entry.ChangeType}
                    {entry.OsmlsStaffCorrection && (
                      <span className="block text-amber-900">
                        <strong>Staff correction:</strong> {entry.OsmlsCorrectionReason}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
