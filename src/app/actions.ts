"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import type { FieldErrors } from "@/lib/listing-input";
import { ListingError, addPhoto, createListing, removePhoto, updateListing } from "@/lib/listings";
import { getCurrentMember } from "@/lib/session";

export type FormState = {
  message?: string;
  errors?: FieldErrors;
  values?: Record<string, string>;
};

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  try {
    await auth.api.signInEmail({ body: { email, password } });
  } catch {
    return { message: "That email and password do not match an account.", values: { email } };
  }
  redirect("/search");
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

function textValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData) if (typeof value === "string") values[key] = value;
  return values;
}

function failure(err: unknown, values?: Record<string, string>): FormState {
  if (err instanceof ListingError) return { message: err.message, errors: err.fieldErrors, values };
  throw err;
}

/** Creates a listing when listingKey is null; otherwise edits that listing. */
export async function saveListing(
  listingKey: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await getCurrentMember();
  if (!actor) redirect("/sign-in");
  const values = textValues(formData);
  let key: string;
  let outcome: string;
  try {
    if (listingKey) {
      const result = await updateListing(actor, listingKey, values, values.correctionReason);
      key = result.listing.ListingKey;
      outcome = result.changedFields.length ? "saved" : "unchanged";
    } else {
      key = (await createListing(actor, values)).ListingKey;
      outcome = "created";
    }
  } catch (err) {
    return failure(err, values);
  }
  revalidatePath("/", "layout");
  redirect(`/listings/${key}?notice=${outcome}`);
}

export async function uploadPhoto(listingKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await getCurrentMember();
  if (!actor) redirect("/sign-in");
  const file = formData.get("photo");
  const reason = String(formData.get("correctionReason") ?? "");
  try {
    if (!(file instanceof File)) throw new ListingError("Choose a photo to upload.");
    await addPhoto(actor, listingKey, new Uint8Array(await file.arrayBuffer()), reason);
  } catch (err) {
    return failure(err, { correctionReason: reason });
  }
  revalidatePath("/", "layout");
  return { message: "Photo added.", values: { correctionReason: reason } };
}

export async function deletePhoto(mediaKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await getCurrentMember();
  if (!actor) redirect("/sign-in");
  const reason = String(formData.get("correctionReason") ?? "");
  try {
    await removePhoto(actor, mediaKey, reason);
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { message: "Photo removed." };
}
