import Link from "next/link";
import { Suspense } from "react";
import { SearchMap, type MapPin } from "@/components/search-map";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatMoney } from "@/lib/format";
import { SEARCH_SORTS, parseBounds, searchListings } from "@/lib/listings";
import { getMapConfig } from "@/lib/map-config";
import { STANDARD_STATUSES } from "@/lib/lookups";
import { MAX_SAVED_NAME_LENGTH } from "@/lib/rules/local";
import { listCollections, openSavedSearch } from "@/lib/saved-work";
import { criteriaFromParams, criteriaToFilters, criteriaToParams } from "@/lib/search-criteria";
import { ActionForm } from "@/components/action-form";
import { addToCollectionAction, saveSearch, updateSavedSearch } from "../saved-work-actions";
import { requireMember } from "@/lib/session";

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const current = await requireMember();
  const p = await searchParams;
  // Everything the search is asked for comes through this one definition.
  const criteria = criteriaFromParams(p);
  const { statuses, sort } = criteria;
  const mine = criteria.mine && current.OsmlsRole === "agent";
  const bounds = parseBounds(criteria.bounds);

  const { rows, truncated, withoutLocation } = await searchListings(criteriaToFilters(criteria, current));

  // The saved search this page was opened from, if it is this member's. Someone
  // else's key, or a made-up one, is simply not a saved search here.
  const opened = one(p.saved) ? await openSavedSearch(current, one(p.saved)) : null;
  // Only on arrival from "Run": which stored criteria had to be dropped.
  const ignored = opened && p.ran !== undefined ? opened.ignored : [];
  const notice = { "search-saved": "Search saved.", "search-updated": "Saved search updated." }[one(p.notice) ?? ""];
  const collections = await listCollections(current);
  // The current criteria, for the forms that save them.
  const criteriaFields = [...criteriaToParams(criteria).entries()].map(([name, value], i) => (
    <input key={`${name}-${i}`} type="hidden" name={name} value={value} />
  ));

  const pins: MapPin[] = rows.flatMap(({ listing }) =>
    listing.Latitude != null && listing.Longitude != null
      ? [
          {
            key: listing.ListingKey,
            id: listing.ListingId,
            latitude: listing.Latitude,
            longitude: listing.Longitude,
            address: listing.UnparsedAddress,
            price: formatMoney(listing.ListPrice),
            status: listing.StandardStatus,
          },
        ]
      : [],
  );
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const locationNote =
    withoutLocation === 0
      ? null
      : bounds
        ? `${plural(withoutLocation, "matching listing")} with no map location ${withoutLocation === 1 ? "was" : "were"} left out, because ${withoutLocation === 1 ? "it" : "they"} cannot be placed inside the area.`
        : `${plural(withoutLocation, "matching listing")} ${withoutLocation === 1 ? "has" : "have"} no map location and ${withoutLocation === 1 ? "is" : "are"} not on the map.`;

  const text = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="label">
      {label}
      <input name={name} defaultValue={one(p[name])} className="field" {...props} />
    </label>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{mine ? "My listings" : "Search listings"}</h1>
      <form method="get" className="card space-y-4">
        <input type="hidden" name="s" value="1" />
        {mine && <input type="hidden" name="mine" value="1" />}
        {opened && <input type="hidden" name="saved" value={opened.savedSearch.SavedSearchKey} />}
        {bounds && <input type="hidden" name="bounds" value={one(p.bounds)} />}
        <div className="grid gap-4 sm:grid-cols-4">
          {text("listingId", "Listing number", { placeholder: "OS1000001" })}
          <div className="sm:col-span-2">{text("address", "Address contains")}</div>
          {text("city", "City")}
          {text("postalCode", "ZIP code")}
          {text("minPrice", "Minimum price", { inputMode: "numeric" })}
          {text("maxPrice", "Maximum price", { inputMode: "numeric" })}
          <div className="grid grid-cols-2 gap-4">
            {text("minBeds", "Min beds", { inputMode: "numeric" })}
            {text("minBaths", "Min baths", { inputMode: "numeric" })}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-5">
          {text("closedFrom", "Closed on or after", { type: "date" })}
          {text("closedTo", "Closed on or before", { type: "date" })}
          {text("minClosePrice", "Minimum close price", { inputMode: "numeric" })}
          {text("maxClosePrice", "Maximum close price", { inputMode: "numeric" })}
          <label className="label">
            Sort by
            <select name="sort" defaultValue={sort in SEARCH_SORTS ? sort : "changed"} className="field">
              {Object.entries(SEARCH_SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="-mt-2 text-xs text-muted">
          Close dates and close prices match closed listings only. Tick Closed below to include them.
        </p>
        <fieldset>
          <legend className="label">Status</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {STANDARD_STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="status" value={s} defaultChecked={statuses.includes(s)} />
                {s}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">Leave every box clear to search all statuses.</p>
        </fieldset>
        <div className="flex gap-3">
          <button className="btn">Search</button>
          <Link href={mine ? "/search?mine=1&s=1" : "/search"} className="btn-secondary">
            Reset
          </Link>
        </div>
      </form>

      <section className="card space-y-3" aria-labelledby="save-heading" data-testid="save-search">
        <h2 id="save-heading" className="text-base font-semibold">
          {opened ? `Saved search: ${opened.savedSearch.SavedSearchName}` : "Save this search"}
        </h2>
        {notice && (
          <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-900">
            {notice}
          </p>
        )}
        {ignored.length > 0 && (
          <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900" data-testid="ignored-criteria">
            Some of what this search was saved with is no longer available and was ignored: {ignored.join(", ")}. The
            results below may be wider than you expect. Choose &ldquo;Update&rdquo; to save the search as it is now.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          {opened && (
            <ActionForm action={updateSavedSearch.bind(null, opened.savedSearch.SavedSearchKey)}>
              {criteriaFields}
              <button className="btn">Update &ldquo;{opened.savedSearch.SavedSearchName}&rdquo; with these criteria</button>
            </ActionForm>
          )}
          <ActionForm action={saveSearch} className="flex flex-wrap items-end gap-3">
            {criteriaFields}
            <label className="label">
              {opened ? "Save as a new search named" : "Name"}
              <input name="name" required maxLength={MAX_SAVED_NAME_LENGTH} className="field" />
            </label>
            <button className={opened ? "btn-secondary" : "btn"}>Save this search</button>
          </ActionForm>
        </div>
        <p className="text-xs text-muted">
          Saves the criteria above, not the results. Only you can see your <Link href="/saved-searches" className="underline">saved searches</Link>.
        </p>
      </section>

      <Suspense>
        <SearchMap config={getMapConfig()} pins={pins} activeBounds={bounds ?? null} statuses={statuses} />
      </Suspense>

      <section aria-live="polite">
        {bounds && (
          <p className="mb-1 text-sm font-medium" data-testid="area-note">
            Showing only listings inside the map area.
          </p>
        )}
        {locationNote && (
          <p className="mb-1 text-sm text-muted" data-testid="location-note">
            {locationNote}
          </p>
        )}
        <p className="mb-2 text-sm text-muted" data-testid="result-count">
          {rows.length === 0
            ? "No listings match."
            : truncated
              ? `Showing the first ${rows.length} matches. Narrow the search to see the rest.`
              : `${rows.length} ${rows.length === 1 ? "listing" : "listings"}`}
        </p>
        {rows.length > 0 && (
          <>
          <ActionForm action={addToCollectionAction} id="add-to-collection" className="mb-2 flex flex-wrap items-end gap-3">
            <label className="label">
              Add ticked listings to
              <select name="collection" className="field" defaultValue="" required disabled={collections.length === 0}>
                <option value="" disabled>
                  {collections.length === 0 ? "No collections yet" : "Choose a collection"}
                </option>
                {collections.map(({ collection }) => (
                  <option key={collection.CollectionKey} value={collection.CollectionKey}>
                    {collection.CollectionName}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-secondary" disabled={collections.length === 0}>
              Add to collection
            </button>
            {collections.length === 0 && (
              <Link href="/collections" className="pb-2 text-sm text-brand underline">
                Create a collection
              </Link>
            )}
          </ActionForm>
          <div className="card overflow-x-auto !p-0">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">
                    <span className="sr-only">Tick to add to a collection</span>
                  </th>
                  <th className="th">Photo</th>
                  <th className="th">Listing</th>
                  <th className="th">Address</th>
                  <th className="th">Price</th>
                  <th className="th">Beds / baths</th>
                  <th className="th" title="Days on market / cumulative days on market">
                    DOM / CDOM
                  </th>
                  <th className="th">Status</th>
                  <th className="th">Listing agent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ listing, agentName, officeName, firstPhotoKey, marketTime }) => (
                  <tr key={listing.ListingKey} className="border-b border-line last:border-0 hover:bg-paper">
                    <td className="td w-8">
                      <input
                        type="checkbox"
                        name="listing"
                        value={listing.ListingKey}
                        form="add-to-collection"
                        aria-label={`Tick ${listing.ListingId} to add to a collection`}
                      />
                    </td>
                    <td className="td w-24">
                      {firstPhotoKey ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/media/${firstPhotoKey}`} alt="" className="h-14 w-20 rounded object-cover" />
                      ) : (
                        <div className="flex h-14 w-20 items-center justify-center rounded bg-paper text-xs text-muted">No photo</div>
                      )}
                    </td>
                    <td className="td">
                      <Link href={`/listings/${listing.ListingKey}`} className="font-medium text-brand underline">
                        {listing.ListingId}
                      </Link>
                      <span className="block text-xs text-muted">{listing.PropertyType}</span>
                    </td>
                    <td className="td">
                      {listing.UnparsedAddress}
                      {listing.Latitude == null && (
                        <span className="block text-xs text-muted">Location unavailable</span>
                      )}
                    </td>
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
                    <td className="td whitespace-nowrap" data-testid="market-time">
                      {marketTime.daysOnMarket} / {marketTime.cumulativeDaysOnMarket}
                    </td>
                    <td className="td">
                      <StatusBadge status={listing.StandardStatus} />
                    </td>
                    <td className="td">
                      {agentName}
                      <span className="block text-xs text-muted">{officeName}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </div>
  );
}
