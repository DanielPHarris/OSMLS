import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import {
  collection,
  collectionListing,
  member,
  office,
  property,
  savedSearch,
  type Collection,
  type SavedSearch,
} from "../db/schema";
import { canUseCollection, canUseSavedSearch, type Viewer } from "./access";
import { ListingError, withoutShowing } from "./listings";
import { getMarketTime } from "./market-time";
import {
  MAX_COLLECTIONS_PER_MEMBER,
  MAX_LISTINGS_PER_COLLECTION,
  MAX_SAVED_NAME_LENGTH,
  MAX_SAVED_SEARCHES_PER_MEMBER,
} from "./rules/local";
import { criteriaFromStored, describeCriteria, type SearchCriteria } from "./search-criteria";

/*
 * A member's saved searches and collections.
 *
 * Saved work never grants access. It belongs to its creator; every read and
 * every change here checks that, and answers "not found" for anything that is
 * someone else's exactly as it does for a key that was never issued. A saved
 * search holds criteria and a collection holds which listings are in it; neither
 * holds a copy of a listing, so opening one always goes through the ordinary,
 * current rules for the member who is asking.
 */

const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const notFound = () => new ListingError("Not found.");

type ActiveViewer = NonNullable<Viewer>;

/** A suspended or signed-out account has no saved work to use. */
function active(viewer: Viewer): ActiveViewer {
  if (!viewer || viewer.MemberStatus !== "Active") throw notFound();
  return viewer;
}

function checkedName(name: unknown): string {
  const clean = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (!clean) throw new ListingError("Give it a name.", { name: "A name is required." });
  if (clean.length > MAX_SAVED_NAME_LENGTH)
    throw new ListingError("That name is too long.", { name: `Use ${MAX_SAVED_NAME_LENGTH} characters or fewer.` });
  return clean;
}

/** The database refuses a second item of the same name; say so in plain words. */
async function namedOnce<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    if (code === "23505")
      throw new ListingError("You already have one with that name.", { name: "Choose a different name." });
    throw err;
  }
}

/**
 * Takes a lock on the member's own row, so that two requests creating things at
 * once are counted one after the other and cannot together pass a limit.
 */
async function lockOwner(tx: Tx, viewer: ActiveViewer) {
  await tx.select({ k: member.MemberKey }).from(member).where(eq(member.MemberKey, viewer.MemberKey)).for("update");
}

/** Only what the criteria definition knows about is ever stored. */
function storable(criteria: SearchCriteria): SearchCriteria {
  return criteriaFromStored(JSON.parse(JSON.stringify(criteria))).criteria;
}

// ---- Saved searches ----

/** Finds a saved search for someone who wants to change it, holding a lock on it. */
async function lockSavedSearch(tx: Tx, viewer: ActiveViewer, key: unknown): Promise<SavedSearch> {
  if (!isKey(key)) throw notFound();
  const [row] = await tx.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key)).for("update");
  if (!row || !canUseSavedSearch(viewer, row)) throw notFound();
  return row;
}

export async function listSavedSearches(viewer: Viewer): Promise<SavedSearch[]> {
  if (!viewer || viewer.MemberStatus !== "Active") return [];
  return db
    .select()
    .from(savedSearch)
    .where(eq(savedSearch.MemberKey, viewer.MemberKey))
    .orderBy(sql`lower(${savedSearch.SavedSearchName})`);
}

/** The saved search if it is this viewer's; null otherwise, whether or not it exists. */
export async function getSavedSearch(viewer: Viewer, key: unknown): Promise<SavedSearch | null> {
  if (!isKey(key)) return null;
  const [row] = await db.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key));
  return row && canUseSavedSearch(viewer, row) ? row : null;
}

/**
 * A saved search ready to run: its criteria checked again as if just typed, with
 * a list of anything that had to be dropped.
 */
export async function openSavedSearch(viewer: Viewer, key: unknown) {
  const row = await getSavedSearch(viewer, key);
  return row ? { savedSearch: row, ...criteriaFromStored(row.OsmlsCriteria) } : null;
}

export async function createSavedSearch(viewer: Viewer, name: unknown, criteria: SearchCriteria): Promise<SavedSearch> {
  const owner = active(viewer);
  const SavedSearchName = checkedName(name);
  const stored = storable(criteria);
  return namedOnce(() =>
    db.transaction(async (tx) => {
      await lockOwner(tx, owner);
      const [{ existing }] = await tx
        .select({ existing: count() })
        .from(savedSearch)
        .where(eq(savedSearch.MemberKey, owner.MemberKey));
      if (existing >= MAX_SAVED_SEARCHES_PER_MEMBER)
        throw new ListingError(`You can keep at most ${MAX_SAVED_SEARCHES_PER_MEMBER} saved searches. Delete one first.`);
      const [created] = await tx
        .insert(savedSearch)
        .values({
          MemberKey: owner.MemberKey,
          SavedSearchName,
          OsmlsCriteria: stored,
          SearchQueryHumanReadable: describeCriteria(stored),
        })
        .returning();
      return created;
    }),
  );
}

export async function renameSavedSearch(viewer: Viewer, key: unknown, name: unknown): Promise<SavedSearch> {
  const owner = active(viewer);
  const SavedSearchName = checkedName(name);
  return namedOnce(() =>
    db.transaction(async (tx) => {
      await lockSavedSearch(tx, owner, key);
      const [updated] = await tx
        .update(savedSearch)
        .set({ SavedSearchName, ModificationTimestamp: new Date() })
        .where(eq(savedSearch.SavedSearchKey, key as string))
        .returning();
      return updated;
    }),
  );
}

export async function updateSavedSearchCriteria(viewer: Viewer, key: unknown, criteria: SearchCriteria): Promise<SavedSearch> {
  const owner = active(viewer);
  const stored = storable(criteria);
  return db.transaction(async (tx) => {
    await lockSavedSearch(tx, owner, key);
    const [updated] = await tx
      .update(savedSearch)
      .set({ OsmlsCriteria: stored, SearchQueryHumanReadable: describeCriteria(stored), ModificationTimestamp: new Date() })
      .where(eq(savedSearch.SavedSearchKey, key as string))
      .returning();
    return updated;
  });
}

export async function deleteSavedSearch(viewer: Viewer, key: unknown): Promise<void> {
  const owner = active(viewer);
  await db.transaction(async (tx) => {
    await lockSavedSearch(tx, owner, key);
    await tx.delete(savedSearch).where(eq(savedSearch.SavedSearchKey, key as string));
  });
}

// ---- Collections ----

/** Finds a collection for someone who wants to change it, holding a lock on it. */
async function lockCollection(tx: Tx, viewer: ActiveViewer, key: unknown): Promise<Collection> {
  if (!isKey(key)) throw notFound();
  const [row] = await tx.select().from(collection).where(eq(collection.CollectionKey, key)).for("update");
  if (!row || !canUseCollection(viewer, row)) throw notFound();
  return row;
}

export async function listCollections(viewer: Viewer) {
  if (!viewer || viewer.MemberStatus !== "Active") return [];
  return db
    .select({
      collection,
      // The outer table is named in full. Left to the query builder, the column is
      // written without its table when only one table is selected from, and inside
      // the subquery that would mean the subquery's own column: every entry would match.
      listingCount: sql<number>`(select count(*)::int from "OsmlsCollectionListing" cl
        where cl."CollectionKey" = "OsmlsCollection"."CollectionKey")`,
    })
    .from(collection)
    .where(eq(collection.MemberKey, viewer.MemberKey))
    .orderBy(sql`lower(${collection.CollectionName})`);
}

/**
 * A collection with its listings, as this viewer may see them now. Each listing
 * is read the way search results are: no showing details and no documents.
 */
export async function getCollection(viewer: Viewer, key: unknown, options: { asOf?: Date } = {}) {
  if (!isKey(key)) return null;
  const [found] = await db.select().from(collection).where(eq(collection.CollectionKey, key));
  if (!found || !canUseCollection(viewer, found)) return null;

  const rows = await db
    .select({
      listing: property,
      agentName: member.MemberFullName,
      officeName: office.OfficeName,
      firstPhotoKey: sql<string | null>`(
        select m."MediaKey" from "Media" m
        where m."ResourceRecordKey" = "Property"."ListingKey" and m."MediaCategory" = 'Photo'
        order by m."Order" limit 1)`,
    })
    .from(collectionListing)
    .innerJoin(property, eq(property.ListingKey, collectionListing.ListingKey))
    .innerJoin(member, eq(member.MemberKey, property.ListAgentKey))
    .innerJoin(office, eq(office.OfficeKey, property.ListOfficeKey))
    .where(eq(collectionListing.CollectionKey, key))
    .orderBy(asc(collectionListing.AddedTimestamp), asc(collectionListing.AddedSequence));

  const marketTime = await getMarketTime(
    rows.map((r) => r.listing.ListingKey),
    { asOf: options.asOf },
  );
  return {
    collection: found,
    rows: rows.map((row) => ({
      ...row,
      listing: withoutShowing(row.listing),
      marketTime: marketTime.get(row.listing.ListingKey) ?? {
        daysOnMarket: 0,
        cumulativeDaysOnMarket: 0,
        firstOnMarketDate: null,
        offMarketDate: null,
        continues: [],
      },
    })),
  };
}

/** The viewer's collections, each marked with whether it holds this listing. */
export async function collectionsForListing(viewer: Viewer, listingKey: string) {
  if (!viewer || viewer.MemberStatus !== "Active" || !isKey(listingKey)) return [];
  return db
    .select({
      CollectionKey: collection.CollectionKey,
      CollectionName: collection.CollectionName,
      // The outer table is named in full, for the reason given in listCollections.
      contains: sql<boolean>`exists (select 1 from "OsmlsCollectionListing" cl
        where cl."CollectionKey" = "OsmlsCollection"."CollectionKey" and cl."ListingKey" = ${listingKey})`,
    })
    .from(collection)
    .where(eq(collection.MemberKey, viewer.MemberKey))
    .orderBy(sql`lower(${collection.CollectionName})`);
}

export async function createCollection(viewer: Viewer, name: unknown): Promise<Collection> {
  const owner = active(viewer);
  const CollectionName = checkedName(name);
  return namedOnce(() =>
    db.transaction(async (tx) => {
      await lockOwner(tx, owner);
      const [{ existing }] = await tx
        .select({ existing: count() })
        .from(collection)
        .where(eq(collection.MemberKey, owner.MemberKey));
      if (existing >= MAX_COLLECTIONS_PER_MEMBER)
        throw new ListingError(`You can keep at most ${MAX_COLLECTIONS_PER_MEMBER} collections. Delete one first.`);
      const [created] = await tx.insert(collection).values({ MemberKey: owner.MemberKey, CollectionName }).returning();
      return created;
    }),
  );
}

export async function renameCollection(viewer: Viewer, key: unknown, name: unknown): Promise<Collection> {
  const owner = active(viewer);
  const CollectionName = checkedName(name);
  return namedOnce(() =>
    db.transaction(async (tx) => {
      await lockCollection(tx, owner, key);
      const [updated] = await tx
        .update(collection)
        .set({ CollectionName, ModificationTimestamp: new Date() })
        .where(eq(collection.CollectionKey, key as string))
        .returning();
      return updated;
    }),
  );
}

/** Removes the collection and its entries. The listings themselves are untouched. */
export async function deleteCollection(viewer: Viewer, key: unknown): Promise<void> {
  const owner = active(viewer);
  await db.transaction(async (tx) => {
    await lockCollection(tx, owner, key);
    await tx.delete(collection).where(eq(collection.CollectionKey, key as string));
  });
}

/**
 * Adds listings to a collection. One already there is left as it is, which is
 * not an error. Returns how many were added.
 */
export async function addToCollection(viewer: Viewer, key: unknown, listingKeys: readonly unknown[]): Promise<{ added: number }> {
  const owner = active(viewer);
  const wanted = [...new Set(listingKeys.filter(isKey))];
  return db.transaction(async (tx) => {
    // Holding the collection's lock makes the count below safe against other adds.
    await lockCollection(tx, owner, key);
    if (wanted.length === 0) return { added: 0 };
    const real = await tx.select({ k: property.ListingKey }).from(property).where(inArray(property.ListingKey, wanted));
    const already = await tx
      .select({ k: collectionListing.ListingKey })
      .from(collectionListing)
      .where(eq(collectionListing.CollectionKey, key as string));
    const present = new Set(already.map((r) => r.k));
    const exists = new Set(real.map((r) => r.k));
    // In the order asked for, so the collection lists them that way.
    const fresh = wanted.filter((k) => exists.has(k) && !present.has(k));
    if (present.size + fresh.length > MAX_LISTINGS_PER_COLLECTION)
      throw new ListingError(`A collection can hold at most ${MAX_LISTINGS_PER_COLLECTION} listings.`);
    if (fresh.length > 0)
      await tx
        .insert(collectionListing)
        .values(fresh.map((ListingKey) => ({ CollectionKey: key as string, ListingKey })))
        .onConflictDoNothing();
    return { added: fresh.length };
  });
}

export async function removeFromCollection(viewer: Viewer, key: unknown, listingKey: unknown): Promise<void> {
  const owner = active(viewer);
  await db.transaction(async (tx) => {
    await lockCollection(tx, owner, key);
    if (!isKey(listingKey)) return;
    await tx
      .delete(collectionListing)
      .where(and(eq(collectionListing.CollectionKey, key as string), eq(collectionListing.ListingKey, listingKey)));
  });
}
