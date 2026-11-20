"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions";
import { closeFlag, raiseFlag, setRelistingLink } from "@/lib/compliance";
import { ListingError } from "@/lib/listings";
import { withOneSettingsVersion } from "@/lib/market-time";
import { getCurrentMember } from "@/lib/session";

/*
 * Every action asks who is signed in and hands that to src/lib/compliance.ts,
 * which decides whether they may. Someone who may not is answered "not found".
 */

async function viewer() {
  const current = await getCurrentMember();
  if (!current) redirect("/sign-in");
  return current;
}

function failure(err: unknown): FormState {
  if (err instanceof ListingError) {
    if (err.message === "Not found.") notFound();
    return { message: err.message, errors: err.fieldErrors };
  }
  throw err;
}

export async function raiseFlagAction(listingKey: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  try {
    await withOneSettingsVersion(() => raiseFlag(current, listingKey, { category: formData.get("category"), description: formData.get("description") }));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Flag raised. MLS staff will review it." };
}

export async function closeFlagAction(flagKey: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  try {
    await closeFlag(current, flagKey, formData.get("state"), formData.get("note"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Flag closed." };
}

export async function setRelistingLinkAction(listingKey: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  try {
    await withOneSettingsVersion(() =>
      setRelistingLink(current, listingKey, { mode: formData.get("mode"), listingId: formData.get("listingId") }, formData.get("reason")),
    );
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved. Every figure for this listing is now worked out with it." };
}
