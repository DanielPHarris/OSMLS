import Link from "next/link";
import { notFound } from "next/navigation";
import { MemberForm } from "@/components/member-form";
import { can } from "@/lib/access";
import { listMembers, listOffices } from "@/lib/members";
import { requireMember } from "@/lib/session";
import { createMemberAction } from "../../admin-actions";

type Search = { q?: string; role?: string; status?: string; office?: string };

export default async function MembersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const current = await requireMember();
  const filters = await searchParams;
  // Null for anyone who may not administer: the page then does not exist for them.
  const members = await listMembers(current, filters);
  if (!members) notFound();
  const offices = await listOffices();
  const roles = [...(can(current, "members") ? (["agent"] as const) : []), ...(can(current, "staff") ? (["staff"] as const) : [])];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Members</h1>
        <p className="text-sm text-muted">Add members, and suspend or reinstate their access. Members are never deleted.</p>
      </div>
      <section className="card" aria-labelledby="add-heading" data-testid="add-member">
        <h2 id="add-heading" className="mb-3 text-base font-semibold">
          Add a member
        </h2>
        <p className="mb-3 text-sm text-muted">
          You do not choose their password. They are emailed a link, good once and for 24 hours, to set their own. A new
          MLS staff account can administer nothing until it is given capabilities.
        </p>
        <MemberForm
          action={createMemberAction}
          roles={roles}
          // Only an active office can be given a member.
          offices={offices.filter((o) => o.OfficeStatus === "Active").map((o) => ({ value: o.OfficeKey, label: o.OfficeName }))}
        />
      </section>
      <form className="card flex flex-wrap items-end gap-3" data-testid="member-filters">
        <label className="label">
          Name, email, or member ID
          <input name="q" defaultValue={filters.q ?? ""} className="field" />
        </label>
        <label className="label">
          Role
          <select name="role" defaultValue={filters.role ?? ""} className="field">
            <option value="">Any</option>
            <option value="agent">Agent</option>
            <option value="staff">MLS staff</option>
          </select>
        </label>
        <label className="label">
          Access
          <select name="status" defaultValue={filters.status ?? ""} className="field">
            <option value="">Any</option>
            <option value="Active">Active</option>
            <option value="Inactive">Suspended</option>
          </select>
        </label>
        <label className="label">
          Office
          <select name="office" defaultValue={filters.office ?? ""} className="field">
            <option value="">Any</option>
            {offices.map((o) => (
              <option key={o.OfficeKey} value={o.OfficeKey}>
                {o.OfficeName}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-secondary">Find</button>
        <Link href="/admin/members" className="text-sm text-brand underline">
          Show all
        </Link>
        <p className="w-full text-sm text-muted" data-testid="member-count">
          {members.length} {members.length === 1 ? "member" : "members"}
        </p>
      </form>
      <div className="card overflow-x-auto !p-0">
        <table className="w-full border-collapse text-sm" data-testid="members">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="p-3">Name</th>
              <th className="p-3">Member ID</th>
              <th className="p-3">Email</th>
              <th className="p-3">Role</th>
              <th className="p-3">Office</th>
              <th className="p-3">Access</th>
            </tr>
          </thead>
          <tbody>
            {members.map(({ member: m, officeName }) => (
              <tr key={m.MemberKey} className="border-b border-line last:border-0">
                <td className="p-3">
                  <Link href={`/admin/members/${m.MemberKey}`} className="font-medium text-brand underline">
                    {m.MemberFullName}
                  </Link>
                </td>
                <td className="p-3">{m.MemberMlsId}</td>
                <td className="p-3">{m.MemberEmail}</td>
                <td className="p-3">{m.OsmlsRole === "staff" ? "MLS staff" : "Agent"}</td>
                <td className="p-3">{officeName ?? "—"}</td>
                <td className="p-3">{m.MemberStatus === "Active" ? "Active" : "Suspended"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
