"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions";

/**
 * A form that runs a server action and shows what it says back. The action does
 * its own checks; this only displays the outcome.
 */
export function ActionForm({
  action,
  children,
  className,
  id,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  children: React.ReactNode;
  className?: string;
  /** Lets inputs elsewhere on the page belong to this form through their "form" attribute. */
  id?: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const detail = Object.values(state.errors ?? {})[0];
  return (
    <form action={formAction} className={className} id={id}>
      {children}
      {state.message && (
        <p role={state.errors || !state.ok ? "alert" : "status"} className={state.ok ? "mt-1 w-full text-sm text-green-800" : "error w-full"}>
          {state.ok ? state.message : (detail ?? state.message)}
        </p>
      )}
    </form>
  );
}
