import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { fieldLabel, formatDateTime } from "@/lib/format";
import { getOfficeForAdmin, listMainOffices } from "@/lib/offices";
import { requireMember } from "@/lib/session";
import { setMainOfficeAction, setOfficeStatusAction, updateOfficeAction } from "../../../admin-actions";

export default async function OfficePage({ params }: { params: Promise<{ key: string }> }) {
  const current = await requireMember();
  // Null for anyone who may not administer, and for an office that does not exist, alike.
  const found = await getOfficeForAdmin(current, (await params).key);
  if (!found) notFound();
  const { office: o, main, branches, members, history } = found;
  const mainOffices = await listMainOffices();
  const officeNames = new Map(mainOffices.map((m) => [m.OfficeKey, m.OfficeName]));
  const active = o.OfficeStatus === "Active";
  const shown = (field: string, value: string | null) => (value == null ? "—" : field === "MainOfficeKey" ? (officeNames.get(value) ?? value) : value);
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/offices" className="text-sm text-brand">
          ← All offices
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{o.OfficeName}</h1>
        <p className="text-sm text-muted" data-testid="office-summary">
          {o.OfficeMlsId} · {main ? `Branch of ${main.OfficeName}` : "Main office"}
          {branches.length > 0 && ` with ${branches.length} ${branches.length === 1 ? "branch" : "branches"}`}
        </p>
      </div>

      <section className="card space-y-3" aria-labelledby="details-heading" data-testid="office-details">
        <h2 id="details-heading" className="text-base font-semibold">
          Details
        </h2>
        <ActionForm action={updateOfficeAction.bind(null, o.OfficeKey)} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">
              Office name
              <input name="name" required maxLength={120} defaultValue={o.OfficeName} className="field" />
            </label>
            <label className="label">
              Office ID
              <input name="officeId" required maxLength={40} defaultValue={o.OfficeMlsId} className="field" />
            </label>
            <label className="label">
              Phone (optional)
              <input name="phone" maxLength={40} defaultValue={o.OfficePhone ?? ""} className="field" />
            </label>
            <label className="label">
              City (optional)
              <input name="city" maxLength={80} defaultValue={o.OfficeCity ?? ""} className="field" />
            </label>
            <label className="label">
              State (optional)
              <input name="state" maxLength={40} defaultValue={o.OfficeStateOrProvince ?? ""} className="field" />
            </label>
          </div>
          <button className="btn">Save details</button>
        </ActionForm>
      </section>

      <section className="card space-y-3" aria-labelledby="brokerage-heading" data-testid="office-brokerage">
        <h2 id="brokerage-heading" className="text-base font-semibold">
          Brokerage
        </h2>
        <p className="text-sm text-muted">
          A brokerage is a main office and its branches, one level deep. Grouping offices changes nothing about who may
          see what: office-only documents and showing details stay with the one office named on a listing.
        </p>
        {branches.length > 0 && (
          <p className="text-sm" data-testid="office-branches">
            Branches:{" "}
            {branches.map((b, i) => (
              <span key={b.OfficeKey}>
                {i > 0 && ", "}
                <Link href={`/admin/offices/${b.OfficeKey}`} className="text-brand underline">
                  {b.OfficeName}
                </Link>
                {b.OfficeStatus !== "Active" && " (inactive)"}
              </span>
            ))}
          </p>
        )}
        <ActionForm action={setMainOfficeAction.bind(null, o.OfficeKey)} className="flex flex-wrap items-end gap-3">
          <label className="label">
            Branch of
            <select name="mainOfficeKey" defaultValue={o.MainOfficeKey ?? ""} className="field">
              <option value="">No one: a main office</option>
              {mainOffices
                .filter((m) => m.OfficeKey !== o.OfficeKey)
                .map((m) => (
                  <option key={m.OfficeKey} value={m.OfficeKey}>
                    {m.OfficeName}
                    {m.OfficeStatus !== "Active" ? " (inactive)" : ""}
                  </option>
                ))}
            </select>
          </label>
          <button className="btn-secondary">Save brokerage</button>
        </ActionForm>
      </section>

      <section className="card space-y-3" aria-labelledby="status-heading" data-testid="office-status-section">
        <h2 id="status-heading" className="text-base font-semibold">
          Status: <span data-testid="office-status">{o.OfficeStatus}</span>
        </h2>
        <p className="text-sm text-muted">
          An office with active agents, or a main office with active branches, cannot be deactivated. An inactive office
          cannot be given agents. Listings keep the office recorded on them either way.
        </p>
        <ActionForm action={setOfficeStatusAction.bind(null, o.OfficeKey, active ? "Inactive" : "Active")} className="space-y-3">
          <label className="label block">
            Reason
            <textarea name="reason" required maxLength={500} rows={2} className="field w-full" />
          </label>
          <button className="btn">{active ? "Deactivate office" : "Reactivate office"}</button>
        </ActionForm>
      </section>

      <section className="card" aria-labelledby="members-heading" data-testid="office-members">
        <h2 id="members-heading" className="mb-3 text-base font-semibold">
          Members ({members.length})
        </h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted">No one is in this office.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {members.map((m) => (
              <li key={m.MemberKey} className="flex flex-wrap justify-between gap-3 py-2">
                <Link href={`/admin/members/${m.MemberKey}`} className="text-brand underline">
                  {m.MemberFullName}
                </Link>
                <span className="text-muted">
                  {m.MemberMlsId} · {m.MemberStatus === "Active" ? "Active" : "Suspended"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-x-auto" aria-labelledby="record-heading">
        <h2 id="record-heading" className="mb-3 text-base font-semibold">
          Change record
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted">No administrative changes are recorded for this office.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="office-history">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">What</th>
                <th className="py-2 pr-3">From</th>
                <th className="py-2 pr-3">To</th>
                <th className="py-2 pr-3">By</th>
                <th className="py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {history.map(({ entry, changedByName }) => (
                <tr key={entry.HistoryTransactionalKey} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(entry.ModificationTimestamp)}</td>
                  <td className="py-2 pr-3">
                    {entry.ChangeType}
                    {entry.FieldName !== "OfficeStatus" && `: ${fieldLabel(entry.FieldName)}`}
                  </td>
                  <td className="py-2 pr-3">{shown(entry.FieldName, entry.PreviousValue)}</td>
                  <td className="py-2 pr-3">{shown(entry.FieldName, entry.NewValue)}</td>
                  <td className="py-2 pr-3">{changedByName}</td>
                  <td className="py-2">{entry.OsmlsCorrectionReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
