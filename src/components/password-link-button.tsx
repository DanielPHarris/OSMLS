"use client";

import { useActionState } from "react";
import type { MemberFormState } from "@/app/admin-actions";

/** Sends a member a new password link. If it could not be emailed, it is shown here once. */
export function PasswordLinkButton({ action }: { action: () => Promise<MemberFormState> }) {
  const [state, formAction, pending] = useActionState<MemberFormState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-2">
      <button className="btn-secondary" disabled={pending}>
        Send a new password link
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
