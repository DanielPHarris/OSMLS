import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatMoney } from "@/lib/format";
import { getListing } from "@/lib/listings";
import type { StandardStatus } from "@/lib/lookups";
import {
  COMPARABLE_STATUSES,
  defaultComparableCriteria,
  findComparables,
  summarizeComparables,
  type ComparableCriteria,
} from "@/lib/market-research";
import { COMPARABLE_DEFAULTS } from "@/lib/rules/market-time";
import { requireMember } from "@/lib/session";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** A number from the page address, kept within sensible limits; otherwise the fallback. */
function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export default async function ComparablesPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Params>;
}) {
  const current = await requireMember();
  const found = await getListing((await params).key, current);
  if (!found) notFound();
  const subject = found.listing;
  const p = await searchParams;

  const defaults = defaultComparableCriteria(subject);
  const hasPin = subject.Latitude != null && subject.Longitude != null;
  // "s" marks a submitted form, so an unticked box means "no", not "use the default".
  const submitted = p.s !== undefined;
  const chosen = ([] as string[]).concat(p.status ?? []).filter((s): s is StandardStatus =>
    (COMPARABLE_STATUSES as readonly string[]).includes(s),
  );
  const criteria: ComparableCriteria = submitted
    ? {
        statuses: chosen,
        closedWithinDays: bounded(one(p.days), defaults.closedWithinDays, 1, 3650),
        area: one(p.area) === "zip" || !hasPin ? "zip" : "radius",
        radiusMiles: bounded(one(p.miles), defaults.radiusMiles, 0.1, 50),
        samePropertyType: one(p.sameType) === "1",
        livingAreaPercent: one(p.useSize) === "1" ? bounded(one(p.size), COMPARABLE_DEFAULTS.livingAreaPercent, 1, 100) : null,
        bedroomRange: one(p.useBeds) === "1" ? bounded(one(p.beds), COMPARABLE_DEFAULTS.bedroomRange, 0, 10) : null,
      }
    : defaults;

  const comparables = await findComparables(subject, criteria);
  const summary = summarizeComparables(comparables);
  const number = (name: string, label: string, value: number, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="label">
      {label}
      <input name={name} type="number" defaultValue={value} className="field" {...props} />
    </label>
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/listings/${subject.ListingKey}`} className="text-sm text-brand">
          ← Back to listing
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Comparables for {subject.ListingId}</h1>
        <p className="text-sm text-muted">
          {subject.UnparsedAddress} · {subject.PropertyType} · {subject.BedroomsTotal} bed ·{" "}
          {subject.LivingArea ? `${subject.LivingArea.toLocaleString("en-US")} sq ft` : "living area not given"}
        </p>
      </div>

      <form method="get" className="card space-y-4">
        <input type="hidden" name="s" value="1" />
        <fieldset>
          <legend className="label">Status</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {COMPARABLE_STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="status" value={s} defaultChecked={criteria.statuses.includes(s)} />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-4">
          {number("days", "Closed within (days)", criteria.closedWithinDays, { min: 1, max: 3650 })}
          <label className="label">
            Area
            <select name="area" defaultValue={criteria.area} className="field">
              <option value="radius" disabled={!hasPin}>
                Within a distance
              </option>
              <option value="zip">Same ZIP code</option>
            </select>
          </label>
          {number("miles", "Distance (miles)", criteria.radiusMiles, { min: 0.1, max: 50, step: 0.1 })}
          <label className="flex items-center gap-1.5 self-end pb-2 text-sm">
            <input type="checkbox" name="sameType" value="1" defaultChecked={criteria.samePropertyType} />
            Same property type
          </label>
          <label className="flex items-center gap-1.5 self-end pb-2 text-sm">
            <input type="checkbox" name="useSize" value="1" defaultChecked={criteria.livingAreaPercent != null} />
            Similar living area
          </label>
          {number("size", "Living area within (%)", criteria.livingAreaPercent ?? COMPARABLE_DEFAULTS.livingAreaPercent, { min: 1, max: 100 })}
          <label className="flex items-center gap-1.5 self-end pb-2 text-sm">
            <input type="checkbox" name="useBeds" value="1" defaultChecked={criteria.bedroomRange != null} />
            Similar bedrooms
          </label>
          {number("beds", "Bedrooms within", criteria.bedroomRange ?? COMPARABLE_DEFAULTS.bedroomRange, { min: 0, max: 10 })}
        </div>
        {!hasPin && (
          <p role="status" className="text-sm text-amber-900">
            This listing has no map location, so comparables cannot be found by distance. The same ZIP code is used
            in its place.
          </p>
        )}
        <div className="flex gap-3">
          <button className="btn">Find comparables</button>
          <Link href={`/listings/${subject.ListingKey}/comparables`} className="btn-secondary">
            Reset to defaults
          </Link>
        </div>
      </form>

      <section className="card" aria-labelledby="summary-heading" data-testid="comparables-summary">
        <h2 id="summary-heading" className="text-base font-semibold">
          {comparables.length} {comparables.length === 1 ? "comparable" : "comparables"}
          {comparables.length === COMPARABLE_DEFAULTS.limit ? " (the nearest shown)" : ""}
        </h2>
        {summary.medians ? (
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Median close price</dt>
              <dd className="text-sm font-medium" data-testid="median-close-price">
                {formatMoney(summary.medians.closePrice)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Median price per sq ft</dt>
              <dd className="text-sm font-medium">
                {summary.medians.pricePerSquareFoot == null ? "—" : formatMoney(summary.medians.pricePerSquareFoot)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Median days on market</dt>
              <dd className="text-sm font-medium">{summary.medians.daysOnMarket}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted" data-testid="too-few">
            {summary.closedCount === 0 ? "No closed sales" : `Only ${summary.closedCount} closed ${summary.closedCount === 1 ? "sale" : "sales"}`}{" "}
            among these, which is too few to summarise. Medians are shown from {COMPARABLE_DEFAULTS.minimumForMedians}.
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          Medians of the {summary.closedCount} closed {summary.closedCount === 1 ? "sale" : "sales"} listed. They describe those sales. They are
          not an estimate of this property&apos;s value, and no adjustments have been made between properties.
        </p>
      </section>

      {comparables.length > 0 && (
        <div className="card overflow-x-auto !p-0">
          <table className="w-full border-collapse" data-testid="comparables">
            <thead>
              <tr className="border-b border-line">
                <th className="th">Listing</th>
                <th className="th">Address</th>
                <th className="th">Status</th>
                <th className="th">Price</th>
                <th className="th">Per sq ft</th>
                <th className="th">Beds / baths / sq ft</th>
                <th className="th">DOM / CDOM</th>
                <th className="th">Distance</th>
              </tr>
            </thead>
            <tbody>
              {comparables.map(({ listing, distanceMiles, pricePerSquareFoot, marketTime }) => {
                const closed = listing.StandardStatus === "Closed";
                return (
                  <tr key={listing.ListingKey} className="border-b border-line last:border-0 hover:bg-paper">
                    <td className="td">
                      <Link href={`/listings/${listing.ListingKey}`} className="font-medium text-brand underline">
                        {listing.ListingId}
                      </Link>
                    </td>
                    <td className="td">{listing.UnparsedAddress}</td>
                    <td className="td">
                      <StatusBadge status={listing.StandardStatus} />
                    </td>
                    <td className="td whitespace-nowrap">
                      {formatMoney(closed ? listing.ClosePrice : listing.ListPrice)}
                      <span className="block text-xs text-muted">
                        {closed ? `Closed ${formatDate(listing.CloseDate)}` : "List price"}
                      </span>
                    </td>
                    <td className="td whitespace-nowrap">{pricePerSquareFoot == null ? "—" : formatMoney(pricePerSquareFoot)}</td>
                    <td className="td whitespace-nowrap">
                      {listing.BedroomsTotal} / {listing.BathroomsTotalInteger} /{" "}
                      {listing.LivingArea ? listing.LivingArea.toLocaleString("en-US") : "—"}
                    </td>
                    <td className="td whitespace-nowrap">
                      {marketTime.daysOnMarket} / {marketTime.cumulativeDaysOnMarket}
                    </td>
                    <td className="td whitespace-nowrap">{distanceMiles == null ? "—" : `${distanceMiles.toFixed(2)} mi`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
