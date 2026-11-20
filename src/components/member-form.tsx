"use client";

import { useActionState } from "react";
import type { MemberFormState } from "@/app/admin-actions";

type Option = { value: string; label: string };

/** Adds a member. If the password link could not be emailed, it is shown here once. */
export function MemberForm({
  action,
  offices,
  roles,
}: {
  action: (previous: MemberFormState, formData: FormData) => Promise<MemberFormState>;
  offices: Option[];
  /** The roles this person may add: agents take "Manage members", staff take "Manage staff". */
  roles: readonly ("agent" | "staff")[];
}) {
  const [state, formAction, pending] = useActionState<MemberFormState, FormData>(action, {});
  const error = (field: string) => state.errors?.[field] && <span className="error block">{state.errors[field]}</span>;
  // After a success the form starts empty again; after a refusal it keeps what was typed.
  const kept = (field: string) => (state.ok ? "" : (state.values?.[field] ?? ""));
  return (
    <form action={formAction} className="space-y-3" key={state.ok ? state.message : "form"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="label">
          First name
          <input name="firstName" required maxLength={80} defaultValue={kept("firstName")} className="field" />
          {error("firstName")}
        </label>
        <label className="label">
          Last name
          <input name="lastName" required maxLength={80} defaultValue={kept("lastName")} className="field" />
          {error("lastName")}
        </label>
        <label className="label">
          Email
          <input name="email" type="email" required maxLength={254} defaultValue={kept("email")} className="field" />
          {error("email")}
        </label>
        <label className="label">
          Member ID
          <input name="memberId" required maxLength={40} defaultValue={kept("memberId")} className="field" />
          {error("memberId")}
        </label>
        <label className="label">
          Role
          <select name="role" defaultValue={kept("role") || roles[0]} className="field">
            {roles.includes("agent") && <option value="agent">Agent</option>}
            {roles.includes("staff") && <option value="staff">MLS staff</option>}
          </select>
          {error("role")}
        </label>
        <label className="label">
          Office (agents only)
          <select name="officeKey" defaultValue={kept("officeKey")} className="field">
            <option value="">None</option>
            {offices.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {error("officeKey")}
        </label>
        <label className="label">
          Phone (optional)
          <input name="phone" maxLength={40} defaultValue={kept("phone")} className="field" />
        </label>
      </div>
      <button className="btn" disabled={pending}>
        Add member
      </button>
      {state.message && (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "text-sm text-green-800" : "error"}>
          {state.message}
        </p>
      )}
      {state.link && (
        <label className="label block">
          The link. Copy it now: it is not shown again.
          <input readOnly value={state.link} className="field w-full font-mono text-xs" data-testid="password-link" onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
    </form>
  );
}
