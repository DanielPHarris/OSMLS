import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { listMainOffices, listOfficesForAdmin } from "@/lib/offices";
import { requireMember } from "@/lib/session";
import { createOfficeAction } from "../../admin-actions";

type Search = { q?: string; status?: string; brokerage?: string };

export default async function OfficesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const current = await requireMember();
  const filters = await searchParams;
  // Null for anyone who may not administer: the page then does not exist for them.
  const offices = await listOfficesForAdmin(current, filters);
  if (!offices) notFound();
  const mainOffices = await listMainOffices();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Offices</h1>
        <p className="text-sm text-muted">
          Add offices, group them into brokerages, and deactivate or reactivate them. A brokerage is a main office and its
          branches. Offices are never deleted.
        </p>
      </div>
      <section className="card" aria-labelledby="add-heading" data-testid="add-office">
        <h2 id="add-heading" className="mb-3 text-base font-semibold">
          Add an office
        </h2>
        <ActionForm action={createOfficeAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">
              Office name
              <input name="name" required maxLength={120} className="field" />
            </label>
            <label className="label">
              Office ID
              <input name="officeId" required maxLength={40} className="field" />
            </label>
            <label className="label">
              Phone (optional)
              <input name="phone" maxLength={40} className="field" />
            </label>
            <label className="label">
              City (optional)
              <input name="city" maxLength={80} className="field" />
            </label>
            <label className="label">
              State (optional)
              <input name="state" maxLength={40} className="field" />
            </label>
            <label className="label">
              Branch of
              <select name="mainOfficeKey" defaultValue="" className="field">
                <option value="">No one: a main office</option>
                {mainOffices
                  .filter((o) => o.OfficeStatus === "Active")
                  .map((o) => (
                    <option key={o.OfficeKey} value={o.OfficeKey}>
                      {o.OfficeName}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <button className="btn">Add office</button>
        </ActionForm>
      </section>
      <form className="card flex flex-wrap items-end gap-3" data-testid="office-filters">
        <label className="label">
          Name, office ID, or city
          <input name="q" defaultValue={filters.q ?? ""} className="field" />
        </label>
        <label className="label">
          Status
          <select name="status" defaultValue={filters.status ?? ""} className="field">
            <option value="">Any</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        </label>
        <label className="label">
          Brokerage
          <select name="brokerage" defaultValue={filters.brokerage ?? ""} className="field">
            <option value="">Any</option>
            {mainOffices.map((o) => (
              <option key={o.OfficeKey} value={o.OfficeKey}>
                {o.OfficeName}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-secondary">Find</button>
        <Link href="/admin/offices" className="text-sm text-brand underline">
          Show all
        </Link>
        <p className="w-full text-sm text-muted" data-testid="office-count">
          {offices.length} {offices.length === 1 ? "office" : "offices"}
        </p>
      </form>
      <div className="card overflow-x-auto !p-0">
        <table className="w-full border-collapse text-sm" data-testid="offices">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="p-3">Name</th>
              <th className="p-3">Office ID</th>
              <th className="p-3">City</th>
              <th className="p-3">Active agents</th>
              <th className="p-3">Status</th>
              <th className="p-3">Brokerage</th>
            </tr>
          </thead>
          <tbody>
            {offices.map(({ office: o, activeAgents, mainOfficeName }) => (
              <tr key={o.OfficeKey} className="border-b border-line last:border-0">
                <td className="p-3">
                  <Link href={`/admin/offices/${o.OfficeKey}`} className="font-medium text-brand underline">
                    {o.OfficeName}
                  </Link>
                </td>
                <td className="p-3">{o.OfficeMlsId}</td>
                <td className="p-3">{o.OfficeCity ?? "—"}</td>
                <td className="p-3">{activeAgents}</td>
                <td className="p-3">{o.OfficeStatus}</td>
                <td className="p-3">{mainOfficeName ? `Branch of ${mainOfficeName}` : "Main office"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
