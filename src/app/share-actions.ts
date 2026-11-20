"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions";
import { formatDate } from "@/lib/format";
import { ListingError, mlsDate } from "@/lib/listings";
import { withOneSettingsVersion } from "@/lib/market-time";
import { getCurrentMember } from "@/lib/session";
import { createShare, revokeShare, stopEmail, type ShareTarget } from "@/lib/shares";

/*
 * Every action asks who is signed in and hands that to src/lib/shares.ts, which
 * checks ownership itself. A key in a request proves nothing.
 */

export type ShareFormState = FormState & {
  /** The new link. It is shown this once and cannot be read back later. */
  link?: string;
};

async function viewer() {
  const current = await getCurrentMember();
  if (!current) redirect("/sign-in");
  return current;
}

function failure(err: unknown): FormState {
  if (err instanceof ListingError) return { message: err.message, errors: err.fieldErrors };
  throw err;
}

/*
 * The email and the message shown afterwards both give the date the link ends,
 * each worked out in the MLS time zone. One version of the settings serves
 * both, so they cannot disagree if the time zone is changed meanwhile.
 */
export async function shareAction(target: ShareTarget, previous: ShareFormState, formData: FormData): Promise<ShareFormState> {
  return withOneSettingsVersion(() => share(target, previous, formData));
}

async function share(target: ShareTarget, _previous: ShareFormState, formData: FormData): Promise<ShareFormState> {
  const current = await viewer();
  let made: Awaited<ReturnType<typeof createShare>>;
  try {
    made = await createShare(current, target, {
      days: formData.get("days") ?? undefined,
      email: String(formData.get("email") ?? "").trim(),
      note: String(formData.get("note") ?? ""),
    });
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  const until = formatDate(await mlsDate(made.expires));
  return {
    ok: true,
    link: made.link,
    message: made.emailedTo ? `Link emailed to ${made.emailedTo}. It works until ${until}.` : `Link made. It works until ${until}.`,
  };
}

export async function revokeShareAction(shareKey: string): Promise<FormState> {
  const current = await viewer();
  try {
    await withOneSettingsVersion(() => revokeShare(current, shareKey));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Link revoked." };
}

/**
 * The recipient of an emailed link asks for no more email. No account is
 * involved: holding the link that was emailed is what allows it.
 */
export async function stopEmailAction(token: string): Promise<FormState> {
  if (!(await stopEmail(token))) return { message: "This link is no longer on record, so there is nothing to stop." };
  return { ok: true, message: "Done. This system will not email your address again." };
}
