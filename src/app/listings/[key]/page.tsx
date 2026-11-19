import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import {
  fieldLabel,
  formatDate,
  formatDateTime,
  formatFileSize,
  formatFileType,
  formatHistoryValue,
  formatMoney,
} from "@/lib/format";
import { DOCUMENT_PERMISSION_LABELS, type DocumentPermission } from "@/lib/lookups";
import { canEdit, canViewHistory, getHistory, getListing } from "@/lib/listings";
import { getMarketTimeline } from "@/lib/market-research";
import { getMarketTime } from "@/lib/market-time";
import { collectionsForListing } from "@/lib/saved-work";
import { ActionForm } from "@/components/action-form";
import { addToCollectionAction, removeFromCollectionAction } from "../../saved-work-actions";
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
  // getListing leaves out whatever this viewer may not see.
  const found = await getListing((await params).key, current);
  if (!found) notFound();
  const { listing, agent, office, photos, documents, showingVisible } = found;
  const notice = NOTICES[(await searchParams).notice ?? ""];
  const isStaff = current.OsmlsRole === "staff";
  const editable = canEdit(current, listing) && (isStaff || !isTerminal(listing.StandardStatus as StandardStatus));
  const history = canViewHistory(current) ? await getHistory(listing.ListingKey) : null;
  const marketTime = (await getMarketTime([listing.ListingKey])).get(listing.ListingKey);
  const timeline = await getMarketTimeline(listing.ListingKey);
  // The viewer's own collections only.
  const collections = await collectionsForListing(current, listing.ListingKey);

  const facts: [string, string][] = [
    ["Property type", listing.PropertyType],
    ["Bedrooms", String(listing.BedroomsTotal)],
    ["Bathrooms", String(listing.BathroomsTotalInteger)],
    ["Living area", listing.LivingArea ? `${listing.LivingArea.toLocaleString("en-US")} sq ft` : "—"],
    ["Lot size", listing.LotSizeAcres != null ? `${listing.LotSizeAcres} acres` : "—"],
    ["Year built", listing.YearBuilt ? String(listing.YearBuilt) : "—"],
    [
      "Map location",
      listing.Latitude != null && listing.Longitude != null
        ? `${listing.Latitude}, ${listing.Longitude}`
        : "Not set",
    ],
    ["County", listing.CountyOrParish ?? "—"],
    ["Parcel number", listing.ParcelNumber ?? "—"],
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
        <div className="flex flex-wrap gap-3">
          <Link href={`/listings/${listing.ListingKey}/comparables`} className="btn-secondary">
            Find comparables
          </Link>
          {editable && (
            <Link href={`/listings/${listing.ListingKey}/edit`} className="btn">
              {isStaff ? "Correct listing" : "Edit listing"}
            </Link>
          )}
        </div>
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

      <section className="card" aria-labelledby="market-heading" data-testid="market">
        <h2 id="market-heading" className="text-base font-semibold">
          Time on market
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Days on market</dt>
            <dd className="text-sm font-medium" data-testid="dom">
              {marketTime?.daysOnMarket ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Cumulative days on market</dt>
            <dd className="text-sm font-medium" data-testid="cdom">
              {marketTime?.cumulativeDaysOnMarket ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">First on market</dt>
            <dd className="text-sm font-medium">{formatDate(marketTime?.firstOnMarketDate)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Off market</dt>
            <dd className="text-sm font-medium">{formatDate(marketTime?.offMarketDate)}</dd>
          </div>
        </dl>
        {marketTime && marketTime.continues.length > 0 && (
          <p className="mt-3 text-sm text-muted">
            The cumulative figure includes earlier listings of this property: {marketTime.continues.join(", ")}.
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          Counted by this MLS&apos;s own rules. Figures from different MLSs are not comparable.
        </p>
        <h3 className="mt-4 text-sm font-semibold">Price and status timeline</h3>
        <table className="mt-2 w-full border-collapse" data-testid="timeline">
          <tbody>
            {timeline.map((entry, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="td w-32 whitespace-nowrap">{formatDate(entry.date)}</td>
                <td className="td w-40">{entry.event}</td>
                <td className="td">{entry.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="collections-heading" data-testid="listing-collections">
        <h2 id="collections-heading" className="text-base font-semibold">
          Your collections
        </h2>
        {collections.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            You have no collections yet.{" "}
            <Link href="/collections" className="text-brand underline">
              Create one
            </Link>{" "}
            to keep listings together.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {collections.map((c) => (
              <li key={c.CollectionKey} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <Link href={`/collections/${c.CollectionKey}`} className="text-sm font-medium text-brand underline">
                  {c.CollectionName}
                </Link>
                {c.contains ? (
                  <ActionForm action={removeFromCollectionAction.bind(null, c.CollectionKey, listing.ListingKey)} className="flex items-center gap-3">
                    <span className="text-sm text-muted">In this collection</span>
                    <button className="btn-secondary !px-3 !py-1" aria-label={`Remove from ${c.CollectionName}`}>
                      Remove
                    </button>
                  </ActionForm>
                ) : (
                  <ActionForm action={addToCollectionAction}>
                    <input type="hidden" name="collection" value={c.CollectionKey} />
                    <input type="hidden" name="listing" value={listing.ListingKey} />
                    <button className="btn-secondary !px-3 !py-1" aria-label={`Add to ${c.CollectionName}`}>
                      Add
                    </button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Only you can see which collections a listing is in.</p>
      </section>

      {showingVisible && (
        <section className="card" aria-labelledby="showing-heading" data-testid="showing">
          <h2 id="showing-heading" className="text-base font-semibold">
            Showing instructions
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
            {(
              [
                ["Requirements", listing.ShowingRequirements.join(", ")],
                ["Contact", [listing.ShowingContactName, listing.ShowingContactPhone].filter(Boolean).join(", ")],
                ["Contact is the", listing.ShowingContactType.join(", ")],
                ["Lockbox type", listing.LockBoxType.join(", ")],
                ["Lockbox location", listing.LockBoxLocation ?? ""],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                <dd className="text-sm font-medium">{value || "—"}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-4 text-sm font-semibold">Instructions</h3>
          <p className="mt-1 whitespace-pre-line text-sm">{listing.ShowingInstructions ?? "None entered."}</p>
        </section>
      )}

      {documents.length > 0 && (
        <section className="card" aria-labelledby="documents-heading" data-testid="documents">
          <h2 id="documents-heading" className="text-base font-semibold">
            Documents
          </h2>
          <ul className="mt-3 divide-y divide-line">
            {documents.map((d) => (
              <li key={d.MediaKey} className="flex flex-wrap items-baseline justify-between gap-3 py-2">
                <div>
                  <a href={`/documents/${d.MediaKey}`} className="font-medium text-brand underline">
                    {d.ShortDescription}
                  </a>
                  <span className="ml-2 text-sm text-muted">
                    {formatFileType(d.MediaType)}, {formatFileSize(d.OsmlsFileSize)}
                  </span>
                </div>
                <span className="text-xs text-muted">
                  Visible to: {DOCUMENT_PERMISSION_LABELS[d.Permission as DocumentPermission] ?? "restricted"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
