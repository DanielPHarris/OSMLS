"use client";

import { useActionState } from "react";
import type { DataConsumerFormState } from "@/app/admin-actions";

/** Makes a data consumer. Its bearer token is shown here once, and cannot be read again. */
export function DataConsumerForm({ action }: { action: (previous: DataConsumerFormState, formData: FormData) => Promise<DataConsumerFormState> }) {
  const [state, formAction, pending] = useActionState<DataConsumerFormState, FormData>(action, {});
  const error = (field: string) => state.errors?.[field] && <span className="error block">{state.errors[field]}</span>;
  return (
    <form action={formAction} className="space-y-3" key={state.ok ? state.token : "form"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="label">
          Name of the system or company
          <input name="name" required maxLength={120} className="field" />
          {error("name")}
        </label>
        <label className="label">
          Expires after (days, optional)
          <input name="expiresInDays" type="number" min={1} max={3650} step={1} className="field" />
          {error("expiresInDays")}
        </label>
      </div>
      <button className="btn" disabled={pending}>
        Add data consumer
      </button>
      {state.message && (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "text-sm text-green-800" : "error"}>
          {state.message}
        </p>
      )}
      {state.token && (
        <label className="label block">
          The bearer token. Copy it now: it is not stored and cannot be shown again.
          <input readOnly value={state.token} className="field w-full font-mono text-xs" data-testid="bearer-token" onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
    </form>
  );
}
