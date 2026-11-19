import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { MAX_COLLECTIONS_PER_MEMBER, MAX_SAVED_NAME_LENGTH } from "@/lib/rules/local";
import { listCollections } from "@/lib/saved-work";
import { requireMember } from "@/lib/session";
import { createCollectionAction } from "../saved-work-actions";

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const current = await requireMember();
  const collections = await listCollections(current);
  const deleted = (await searchParams).notice === "collection-deleted";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Collections</h1>
        <p className="text-sm text-muted">
          Lists of listings you want to keep together. Yours alone: no one else can see or change them. You have{" "}
          {collections.length} of {MAX_COLLECTIONS_PER_MEMBER}.
        </p>
      </div>
      {deleted && (
        <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-900">
          Collection deleted. The listings themselves are unchanged.
        </p>
      )}
      <ActionForm action={createCollectionAction} className="card flex flex-wrap items-end gap-3">
        <label className="label">
          New collection name
          <input name="name" required maxLength={MAX_SAVED_NAME_LENGTH} className="field" />
        </label>
        <button className="btn">Create collection</button>
      </ActionForm>
      {collections.length === 0 ? (
        <p className="card text-sm text-muted">No collections yet.</p>
      ) : (
        <ul className="space-y-3" data-testid="collections">
          {collections.map(({ collection, listingCount }) => (
            <li key={collection.CollectionKey} className="card flex flex-wrap items-baseline justify-between gap-3">
              <Link href={`/collections/${collection.CollectionKey}`} className="font-semibold text-brand underline">
                {collection.CollectionName}
              </Link>
              <span className="text-sm text-muted">
                {listingCount} {listingCount === 1 ? "listing" : "listings"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
