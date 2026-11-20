import Link from "next/link";
import { notFound } from "next/navigation";
import { listFlags } from "@/lib/compliance";
import { formatDateTime } from "@/lib/format";
import { FLAG_CATEGORIES, FLAG_STATES } from "@/lib/lookups";
import { listOffices } from "@/lib/members";
import { requireMember } from "@/lib/session";

type Search = { state?: string; category?: string; office?: string };

export default async function FlagsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const current = await requireMember();
  const asked = await searchParams;
  // Open flags unless another state, or all of them, is asked for.
  const filters = { ...asked, state: asked.state === undefined ? "Open" : asked.state };
  // Null for anyone who does not manage compliance: the page does not exist for them.
  const flags = await listFlags(current, filters);
  if (!flags) notFound();
  const offices = await listOffices();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Flags</h1>
        <p className="text-sm text-muted">
          Problems members have reported with listings. A flag changes nothing about its listing; open the listing to
          look into it, correct what needs correcting, and close the flag there.
        </p>
      </div>
      <form className="card flex flex-wrap items-end gap-3" data-testid="flag-filters">
        <label className="label">
          State
          <select name="state" defaultValue={filters.state} className="field">
            <option value="">All</option>
            {FLAG_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          About
          <select name="category" defaultValue={filters.category ?? ""} className="field">
            <option value="">Anything</option>
            {FLAG_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Listing office
          <select name="office" defaultValue={filters.office ?? ""} className="field">
            <option value="">Any</option>
            {offices.map((o) => (
              <option key={o.OfficeKey} value={o.OfficeKey}>
                {o.OfficeName}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-secondary">Filter</button>
      </form>
      <section className="card overflow-x-auto">
        {flags.length === 0 ? (
          <p className="text-sm text-muted">No flags match.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="flag-queue">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">Raised</th>
                <th className="py-2 pr-3">Listing</th>
                <th className="py-2 pr-3">About</th>
                <th className="py-2 pr-3">Raised by</th>
                <th className="py-2">State</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.flagKey} className="border-b border-line align-top last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(f.raisedAt)}</td>
                  <td className="py-2 pr-3">
                    <Link href={`/listings/${f.listingKey}`} className="font-medium text-brand underline">
                      {f.listingId}
                    </Link>
                    <span className="block text-xs text-muted">
                      {f.address} · {f.officeName}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {f.category}
                    <span className="block text-xs text-muted">{f.description}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {f.raisedBy.name}
                    <span className="block text-xs text-muted">{f.raisedBy.officeName ?? "MLS staff"}</span>
                  </td>
                  <td className="py-2">{f.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
