import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { formatMoney } from "@/lib/format";
import { searchListings } from "@/lib/listings";
import { STANDARD_STATUSES, type StandardStatus } from "@/lib/lookups";
import { requireMember } from "@/lib/session";

type Params = Record<string, string | string[] | undefined>;
const DEFAULT_STATUSES: StandardStatus[] = ["Active", "Coming Soon"];

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const num = (v: string | string[] | undefined) => {
  const s = one(v)?.replace(/[$,\s]/g, "");
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const current = await requireMember();
  const p = await searchParams;
  // "s" marks a submitted search, so an empty status selection means every status.
  const submitted = p.s !== undefined;
  const chosen = ([] as string[]).concat(p.status ?? []).filter((s): s is StandardStatus =>
    (STANDARD_STATUSES as readonly string[]).includes(s),
  );
  const statuses = submitted ? chosen : DEFAULT_STATUSES;
  const mine = one(p.mine) === "1" && current.OsmlsRole === "agent";

  const { rows, truncated } = await searchListings({
    listingId: one(p.listingId),
    address: one(p.address),
    city: one(p.city),
    postalCode: one(p.postalCode),
    minPrice: num(p.minPrice),
    maxPrice: num(p.maxPrice),
    minBeds: num(p.minBeds),
    minBaths: num(p.minBaths),
    statuses,
    listAgentKey: mine ? current.MemberKey : undefined,
  });

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

      <section aria-live="polite">
        <p className="mb-2 text-sm text-muted" data-testid="result-count">
          {rows.length === 0
            ? "No listings match."
            : truncated
              ? `Showing the first ${rows.length} matches. Narrow the search to see the rest.`
              : `${rows.length} ${rows.length === 1 ? "listing" : "listings"}`}
        </p>
        {rows.length > 0 && (
          <div className="card overflow-x-auto !p-0">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">Photo</th>
                  <th className="th">Listing</th>
                  <th className="th">Address</th>
                  <th className="th">Price</th>
                  <th className="th">Beds / baths</th>
                  <th className="th">Status</th>
                  <th className="th">Listing agent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ listing, agentName, officeName, firstPhotoKey }) => (
                  <tr key={listing.ListingKey} className="border-b border-line last:border-0 hover:bg-paper">
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
                    <td className="td">{listing.UnparsedAddress}</td>
                    <td className="td whitespace-nowrap font-medium">{formatMoney(listing.ListPrice)}</td>
                    <td className="td whitespace-nowrap">
                      {listing.BedroomsTotal} / {listing.BathroomsTotalInteger}
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
        )}
      </section>
    </div>
  );
}
