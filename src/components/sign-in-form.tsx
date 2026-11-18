"use client";

import { useActionState } from "react";
import { signIn, type FormState } from "@/app/actions";

export function SignInForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, {});
  return (
    <form action={action} className="mt-4 space-y-4">
      {state.message && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.message}
        </p>
      )}
      <label className="label">
        Email
        <input name="email" type="email" required autoComplete="username" defaultValue={state.values?.email} className="field" />
      </label>
      <label className="label">
        Password
        <input name="password" type="password" required autoComplete="current-password" className="field" />
      </label>
      <button className="btn w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
