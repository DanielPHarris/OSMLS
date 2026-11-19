import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatMoney } from "@/lib/format";
import { MAX_LISTINGS_PER_COLLECTION, MAX_SAVED_NAME_LENGTH } from "@/lib/rules/local";
import { getCollection } from "@/lib/saved-work";
import { requireMember } from "@/lib/session";
import { deleteCollectionAction, removeFromCollectionAction, renameCollectionAction } from "../../saved-work-actions";

export default async function CollectionPage({ params }: { params: Promise<{ key: string }> }) {
  const current = await requireMember();
  // Null for someone else's collection and for one that does not exist alike.
  const found = await getCollection(current, (await params).key);
  if (!found) notFound();
  const { collection, rows } = found;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/collections" className="text-sm text-brand">
          ← All collections
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{collection.CollectionName}</h1>
        <p className="text-sm text-muted">
          {rows.length} of {MAX_LISTINGS_PER_COLLECTION} listings, in the order you added them. Each is shown as it is
          today. Add listings from search results or from a listing&apos;s page.
        </p>
      </div>
      <div className="card flex flex-wrap items-end gap-3">
        <ActionForm action={renameCollectionAction.bind(null, collection.CollectionKey)} className="flex flex-wrap items-end gap-3">
          <label className="label">
            Rename
            <input name="name" defaultValue={collection.CollectionName} required maxLength={MAX_SAVED_NAME_LENGTH} className="field" />
          </label>
          <button className="btn-secondary">Save name</button>
        </ActionForm>
        <ActionForm action={deleteCollectionAction.bind(null, collection.CollectionKey)}>
          <button className="btn-secondary">Delete collection</button>
        </ActionForm>
      </div>
      {rows.length === 0 ? (
        <p className="card text-sm text-muted">This collection is empty.</p>
      ) : (
        <div className="card overflow-x-auto !p-0">
          <table className="w-full border-collapse" data-testid="collection-listings">
            <thead>
              <tr className="border-b border-line">
                <th className="th">Listing</th>
                <th className="th">Address</th>
                <th className="th">Price</th>
                <th className="th">Beds / baths</th>
                <th className="th">DOM / CDOM</th>
                <th className="th">Status</th>
                <th className="th">Listing agent</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ listing, agentName, officeName, marketTime }) => (
                <tr key={listing.ListingKey} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="td">
                    <Link href={`/listings/${listing.ListingKey}`} className="font-medium text-brand underline">
                      {listing.ListingId}
                    </Link>
                    <span className="block text-xs text-muted">{listing.PropertyType}</span>
                  </td>
                  <td className="td">{listing.UnparsedAddress}</td>
                  <td className="td whitespace-nowrap font-medium">
                    {formatMoney(listing.ListPrice)}
                    {listing.StandardStatus === "Closed" && (
                      <span className="block text-xs font-normal text-muted">
                        Closed {formatMoney(listing.ClosePrice)} on {formatDate(listing.CloseDate)}
                      </span>
                    )}
                  </td>
                  <td className="td whitespace-nowrap">
                    {listing.BedroomsTotal} / {listing.BathroomsTotalInteger}
                  </td>
                  <td className="td whitespace-nowrap">
                    {marketTime.daysOnMarket} / {marketTime.cumulativeDaysOnMarket}
                  </td>
                  <td className="td">
                    <StatusBadge status={listing.StandardStatus} />
                  </td>
                  <td className="td">
                    {agentName}
                    <span className="block text-xs text-muted">{officeName}</span>
                  </td>
                  <td className="td">
                    <ActionForm action={removeFromCollectionAction.bind(null, collection.CollectionKey, listing.ListingKey)}>
                      <button className="btn-secondary !px-3 !py-1" aria-label={`Remove ${listing.ListingId} from this collection`}>
                        Remove
                      </button>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
