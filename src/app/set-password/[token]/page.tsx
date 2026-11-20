import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/rules/local";
import { setPasswordAction } from "../../admin-actions";

/*
 * Where a "set your password" link from MLS staff leads. Opening the page
 * neither checks nor spends the link; submitting the form does both.
 */

export const metadata: Metadata = { title: "Set your password", robots: { index: false, follow: false } };

export default async function SetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="card mx-auto max-w-md space-y-3" data-testid="set-password">
      <h1 className="text-2xl font-semibold">Set your password</h1>
      <p className="text-sm text-muted">At least {MIN_PASSWORD_LENGTH} characters. This link works once.</p>
      <ActionForm action={setPasswordAction.bind(null, token)} className="space-y-3">
        <label className="label block">
          New password
          <input name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className="field w-full" />
        </label>
        <label className="label block">
          New password again
          <input name="confirm" type="password" required autoComplete="new-password" className="field w-full" />
        </label>
        <button className="btn">Set password</button>
      </ActionForm>
      <p className="text-sm">
        <Link href="/sign-in" className="text-brand underline">
          Go to sign in
        </Link>
      </p>
    </div>
  );
}
