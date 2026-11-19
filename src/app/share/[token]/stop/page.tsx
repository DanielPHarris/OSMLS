import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { canStopEmail } from "@/lib/shares";
import { stopEmailAction } from "../../../share-actions";

/*
 * Where the "stop email" link in a shared-listing email leads. Opening the page
 * changes nothing, so a mail scanner that follows links stops nobody's email;
 * the button does it.
 */

export const metadata: Metadata = { title: "Stop email", robots: { index: false, follow: false } };

export default async function StopEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await canStopEmail(token))) notFound();
  return (
    <div className="card max-w-xl space-y-3" data-testid="stop-email">
      <h1 className="text-2xl font-semibold">Stop email</h1>
      <p className="text-sm">
        This stops all email from this system to the address this link was sent to, and deletes that address from our
        records. Links you were already sent keep working until they expire or are withdrawn.
      </p>
      <ActionForm action={stopEmailAction.bind(null, token)}>
        <button className="btn">Stop email to my address</button>
      </ActionForm>
    </div>
  );
}
