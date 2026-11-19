"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions";
import { ListingError } from "@/lib/listings";
import {
  addToCollection,
  createCollection,
  createSavedSearch,
  deleteCollection,
  deleteSavedSearch,
  removeFromCollection,
  renameCollection,
  renameSavedSearch,
  updateSavedSearchCriteria,
} from "@/lib/saved-work";
import { criteriaFromParams, criteriaToParams } from "@/lib/search-criteria";
import { getCurrentMember } from "@/lib/session";

/*
 * Every action here asks who is signed in and hands that to the saved-work
 * functions, which check ownership themselves. A key in a request proves nothing.
 */

async function viewer() {
  const current = await getCurrentMember();
  if (!current) redirect("/sign-in");
  return current;
}

function failure(err: unknown): FormState {
  if (err instanceof ListingError) return { message: err.message, errors: err.fieldErrors };
  throw err;
}

/** The search criteria a form carried, read the same way the search page reads its address. */
function criteriaIn(formData: FormData) {
  const params: Record<string, string[]> = {};
  for (const [key, value] of formData) if (typeof value === "string") (params[key] ??= []).push(value);
  return criteriaFromParams(params);
}

const searchAddress = (formData: FormData, savedKey: string, notice: string) => {
  const params = criteriaToParams(criteriaIn(formData));
  params.set("saved", savedKey);
  params.set("notice", notice);
  return `/search?${params}`;
};

export async function saveSearch(_previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  let address: string;
  try {
    const created = await createSavedSearch(current, formData.get("name"), criteriaIn(formData));
    address = searchAddress(formData, created.SavedSearchKey, "search-saved");
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  redirect(address);
}

export async function updateSavedSearch(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  let address: string;
  try {
    const updated = await updateSavedSearchCriteria(current, key, criteriaIn(formData));
    address = searchAddress(formData, updated.SavedSearchKey, "search-updated");
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  redirect(address);
}

export async function renameSavedSearchAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  try {
    await renameSavedSearch(current, key, formData.get("name"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Renamed." };
}

export async function deleteSavedSearchAction(key: string): Promise<FormState> {
  const current = await viewer();
  try {
    await deleteSavedSearch(current, key);
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Deleted." };
}

export async function createCollectionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  try {
    await createCollection(current, formData.get("name"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Collection created." };
}

export async function renameCollectionAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  try {
    await renameCollection(current, key, formData.get("name"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Renamed." };
}

export async function deleteCollectionAction(key: string): Promise<FormState> {
  const current = await viewer();
  try {
    await deleteCollection(current, key);
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  redirect("/collections?notice=collection-deleted");
}

/** Adds the ticked listings (or the one named) to the chosen collection. */
export async function addToCollectionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const current = await viewer();
  const key = formData.get("collection");
  if (typeof key !== "string" || key === "") return { message: "Choose a collection.", errors: { collection: "Choose a collection." } };
  const listings = formData.getAll("listing");
  if (listings.length === 0) return { message: "Tick at least one listing.", errors: { listing: "Tick at least one listing." } };
  let added: number;
  try {
    ({ added } = await addToCollection(current, key, listings));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  const already = listings.length - added;
  return {
    ok: true,
    message:
      added === 0
        ? "Already in that collection."
        : `Added ${added} ${added === 1 ? "listing" : "listings"}${already > 0 ? `; ${already} already there` : ""}.`,
  };
}

export async function removeFromCollectionAction(key: string, listingKey: string): Promise<FormState> {
  const current = await viewer();
  try {
    await removeFromCollection(current, key, listingKey);
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Removed." };
}
