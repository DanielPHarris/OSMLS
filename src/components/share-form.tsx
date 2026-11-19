"use client";

import { useActionState } from "react";
import type { ShareFormState } from "@/app/share-actions";

/** Makes a link for a client and shows it the one time it can be shown. */
export function ShareForm({
  action,
  expiryDays,
  defaultDays,
  maxNoteLength,
  emailEnabled,
}: {
  action: (previous: ShareFormState, formData: FormData) => Promise<ShareFormState>;
  expiryDays: readonly number[];
  defaultDays: number;
  maxNoteLength: number;
  emailEnabled: boolean;
}) {
  const [state, formAction] = useActionState<ShareFormState, FormData>(action, {});
  const detail = Object.values(state.errors ?? {})[0];
  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {emailEnabled && (
          <label className="label">
            Client&rsquo;s email (optional)
            <input name="email" type="email" maxLength={254} className="field" />
          </label>
        )}
        <label className="label">
          Link works for
          <select name="days" defaultValue={defaultDays} className="field">
            {expiryDays.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </label>
      </div>
      {emailEnabled ? (
        <label className="label block">
          Note to include in the email (optional)
          <textarea name="note" maxLength={maxNoteLength} rows={2} className="field w-full" />
        </label>
      ) : (
        <p className="text-sm text-muted">Email is not set up on this system. Make a link and send it yourself.</p>
      )}
      <button className="btn-secondary">Make link</button>
      {state.message && (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "text-sm text-green-800" : "error"}>
          {state.ok ? state.message : (detail ?? state.message)}
        </p>
      )}
      {state.link && (
        <label className="label block">
          The link. Copy it now: it is not shown again.
          <input readOnly value={state.link} className="field w-full font-mono text-xs" data-testid="share-link" onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
    </form>
  );
}
