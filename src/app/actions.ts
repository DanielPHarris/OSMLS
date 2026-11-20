"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { addDocument, removeDocument, replaceDocument, updateDocument } from "@/lib/documents";
import { MULTI_VALUE_SEPARATOR, type FieldErrors } from "@/lib/listing-input";
import { ListingError, addPhoto, createListing, removePhoto, updateListing } from "@/lib/listings";
import { withOneSettingsVersion } from "@/lib/market-time";
import { getCurrentMember } from "@/lib/session";

export type FormState = {
  /** True when the message reports success. */
  ok?: boolean;
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

// Fields where several boxes can be ticked; they travel as one joined string.
const MULTI_CHOICE_FIELDS = ["ShowingRequirements", "ShowingContactType", "LockBoxType"];

function textValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData) if (typeof value === "string") values[key] = value;
  for (const key of MULTI_CHOICE_FIELDS)
    values[key] = formData
      .getAll(key)
      .filter((v): v is string => typeof v === "string")
      .join(MULTI_VALUE_SEPARATOR);
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
      const result = await withOneSettingsVersion(() => updateListing(actor, listingKey, values, values.correctionReason));
      key = result.listing.ListingKey;
      outcome = result.changedFields.length ? "saved" : "unchanged";
    } else {
      key = (await withOneSettingsVersion(() => createListing(actor, values))).ListingKey;
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

// ---- Documents ----
// Each action checks who is asking on the server; what the page showed is irrelevant.

async function fileBytes(formData: FormData): Promise<Uint8Array> {
  const file = formData.get("file");
  if (!(file instanceof File)) throw new ListingError("Choose a file to upload.");
  return new Uint8Array(await file.arrayBuffer());
}

export async function uploadDocument(listingKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await getCurrentMember();
  if (!actor) redirect("/sign-in");
  const values = textValues(formData);
  try {
    await addDocument(
      actor,
      listingKey,
      { bytes: await fileBytes(formData), name: values.name, permission: values.permission },
      values.correctionReason,
    );
  } catch (err) {
    return failure(err, values);
  }
  revalidatePath("/", "layout");
  return { message: "Document added." };
}

export async function replaceDocumentFile(mediaKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await getCurrentMember();
  if (!actor) redirect("/sign-in");
  try {
    await replaceDocument(actor, mediaKey, await fileBytes(formData), String(formData.get("correctionReason") ?? ""));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { message: "File replaced." };
}

export async function saveDocumentDetails(mediaKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await getCurrentMember();
  if (!actor) redirect("/sign-in");
  const values = textValues(formData);
  let changed: boolean;
  try {
    ({ changed } = await updateDocument(
      actor,
      mediaKey,
      { name: values.name, permission: values.permission },
      values.correctionReason,
    ));
  } catch (err) {
    return failure(err, values);
  }
  revalidatePath("/", "layout");
  return { message: changed ? "Document updated." : "Nothing was changed." };
}

export async function deleteDocument(mediaKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await getCurrentMember();
  if (!actor) redirect("/sign-in");
  try {
    await removeDocument(actor, mediaKey, String(formData.get("correctionReason") ?? ""));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { message: "Document deleted." };
}
