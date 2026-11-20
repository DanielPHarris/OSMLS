import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PasswordLinkButton } from "@/components/password-link-button";
import { fieldLabel, formatDateTime } from "@/lib/format";
import { getMemberForAdmin, getMemberHistory, listOffices } from "@/lib/members";
import { PASSWORD_LINK_HOURS } from "@/lib/rules/local";
import { requireMember } from "@/lib/session";
import { changeMemberEmailAction, moveMemberAction, sendPasswordLinkAction, setMemberStatusAction, updateMemberAction } from "../../../admin-actions";

export default async function MemberPage({ params }: { params: Promise<{ key: string }> }) {
  const current = await requireMember();
  const { key } = await params;
  // Null for anyone who may not administer, and for a member that does not exist, alike.
  const found = await getMemberForAdmin(current, key);
  if (!found) notFound();
  const { member: m, officeName } = found;
  const history = (await getMemberHistory(current, key)) ?? [];
  const offices = await listOffices();
  const officeNames = new Map(offices.map((o) => [o.OfficeKey, o.OfficeName]));
  const active = m.MemberStatus === "Active";
  const self = m.MemberKey === current.MemberKey;
  const shown = (field: string, value: string | null) =>
    value == null ? "—" : field === "OfficeKey" ? (officeNames.get(value) ?? value) : field === "MemberStatus" && value === "Inactive" ? "Suspended" : value;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/members" className="text-sm text-brand">
          ← All members
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{m.MemberFullName}</h1>
        <p className="text-sm text-muted" data-testid="member-summary">
          {m.MemberMlsId} · {m.MemberEmail} · {m.OsmlsRole === "staff" ? "MLS staff" : `Agent, ${officeName ?? "no office"}`}
        </p>
      </div>

      <section className="card space-y-3" aria-labelledby="details-heading" data-testid="member-details">
        <h2 id="details-heading" className="text-base font-semibold">
          Details and role
        </h2>
        <ActionForm action={updateMemberAction.bind(null, m.MemberKey)} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">
              First name
              <input name="firstName" required maxLength={80} defaultValue={m.MemberFirstName} className="field" />
            </label>
            <label className="label">
              Last name
              <input name="lastName" required maxLength={80} defaultValue={m.MemberLastName} className="field" />
            </label>
            <label className="label">
              Member ID
              <input name="memberId" required maxLength={40} defaultValue={m.MemberMlsId} className="field" />
            </label>
            <label className="label">
              Phone (optional)
              <input name="phone" maxLength={40} defaultValue={m.MemberDirectPhone ?? ""} className="field" />
            </label>
            <label className="label">
              Role
              <select name="role" defaultValue={m.OsmlsRole} className="field">
                <option value="agent">Agent</option>
                <option value="staff">MLS staff</option>
              </select>
            </label>
            <label className="label">
              Office, when making this member an agent
              <select name="officeKey" defaultValue="" className="field">
                <option value="">None</option>
                {offices.filter((o) => o.OfficeStatus === "Active").map((o) => (
                  <option key={o.OfficeKey} value={o.OfficeKey}>
                    {o.OfficeName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted">
            Making a member an agent needs an office; making one MLS staff removes it. Moving an agent to another office is
            not available yet. Listings keep the office recorded on them.
          </p>
          <button className="btn">Save details</button>
        </ActionForm>
      </section>

      {m.OsmlsRole === "agent" && (
        <section className="card space-y-3" aria-labelledby="office-heading" data-testid="member-office">
          <h2 id="office-heading" className="text-base font-semibold">
            Office:{" "}
            {m.OfficeKey ? (
              <Link href={`/admin/offices/${m.OfficeKey}`} className="text-brand underline" data-testid="member-office-name">
                {officeName}
              </Link>
            ) : (
              <span data-testid="member-office-name">none</span>
            )}
          </h2>
          <p className="text-sm text-muted">
            Moving an agent changes at once what they may see of colleagues&rsquo; listings: the old office&rsquo;s
            office-only documents and showing details go, and the new office&rsquo;s come. Their own listings keep the
            office recorded on them, and they remain the listing agent.
          </p>
          <ActionForm action={moveMemberAction.bind(null, m.MemberKey)} className="space-y-3">
            <label className="label">
              Move to
              <select name="officeKey" required defaultValue="" className="field">
                <option value="" disabled>
                  Choose an office
                </option>
                {offices
                  .filter((o) => o.OfficeStatus === "Active" && o.OfficeKey !== m.OfficeKey)
                  .map((o) => (
                    <option key={o.OfficeKey} value={o.OfficeKey}>
                      {o.OfficeName}
                    </option>
                  ))}
              </select>
            </label>
            <label className="label block">
              Reason for the move
              <textarea name="reason" required maxLength={500} rows={2} className="field w-full" />
            </label>
            <button className="btn">Move agent</button>
          </ActionForm>
        </section>
      )}

      <section className="card space-y-3" aria-labelledby="signin-heading" data-testid="member-sign-in">
        <h2 id="signin-heading" className="text-base font-semibold">
          Sign-in
        </h2>
        <ActionForm action={changeMemberEmailAction.bind(null, m.MemberKey)} className="flex flex-wrap items-end gap-3">
          <label className="label">
            Email they sign in with
            <input name="email" type="email" required maxLength={254} defaultValue={m.MemberEmail} className="field" />
          </label>
          <button className="btn-secondary">Change email</button>
        </ActionForm>
        <p className="text-sm text-muted">
          You never set a member&rsquo;s password. A link lets them choose their own; it works once, for{" "}
          {PASSWORD_LINK_HOURS} hours, and using it signs them out everywhere else.
        </p>
        <PasswordLinkButton action={sendPasswordLinkAction.bind(null, m.MemberKey)} />
      </section>

      <section className="card space-y-3" aria-labelledby="access-heading" data-testid="member-access">
        <h2 id="access-heading" className="text-base font-semibold">
          Access: <span data-testid="member-status">{active ? "Active" : "Suspended"}</span>
        </h2>
        <p className="text-sm text-muted">
          A suspended member is refused everything at once, including through sessions already open. Their client links
          stop working and their email alerts stop. Nothing of theirs is deleted, and reinstating restores it all.
        </p>
        {self ? (
          <p className="text-sm">You cannot suspend your own account.</p>
        ) : (
          <ActionForm action={setMemberStatusAction.bind(null, m.MemberKey, active ? "Inactive" : "Active")} className="space-y-3">
            <label className="label block">
              Reason
              <textarea name="reason" required maxLength={500} rows={2} className="field w-full" />
            </label>
            <button className="btn">{active ? "Suspend access" : "Reinstate access"}</button>
          </ActionForm>
        )}
      </section>

      <section className="card overflow-x-auto" aria-labelledby="record-heading">
        <h2 id="record-heading" className="mb-3 text-base font-semibold">
          Change record
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted">No administrative changes are recorded for this member.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="member-history">
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
                    {entry.FieldName !== "Password" && entry.FieldName !== "MemberStatus" && `: ${fieldLabel(entry.FieldName)}`}
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
