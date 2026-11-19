import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import { historyTransactional, member, office, property, savedSearch, type HistoryRow, type Member, type SavedSearch } from "../db/schema";
import { canUseSavedSearch } from "./access";
import { ListingError, areaCondition, fieldConditions } from "./listings";
import { MAX_ACTIVITY_EVENTS_PER_LISTING, MAX_ACTIVITY_LISTINGS } from "./rules/local";
import { criteriaFromStored, criteriaToFilters } from "./search-criteria";

/*
 * Activity: what is new or changed for a saved search since its checkpoint.
 *
 * The checkpoint is a history sequence number. History numbers are handed out
 * in commit order (migration 0008), so once number N is visible nothing at or
 * below N can still arrive, and "seen through N" cannot skip a change.
 *
 * One reading uses one database snapshot for everything: the saved search and
 * its checkpoint, the upper boundary, which listings match, and their events.
 * A listing that starts matching while the page is being built is therefore
 * either in the reading with its events, or above the boundary and still unseen.
 *
 * Activity is built from the change history, which only MLS staff may read in
 * full. toActivityEvent is the one place a history row becomes something a
 * member sees, and it copies four things and nothing else.
 */

/** The history fields whose changes are events. Nothing else is. */
const EVENT_FIELDS = ["StandardStatus", "ListPrice"];

export type ActivityEvent = {
  kind: "new" | "status" | "price";
  previous: string | null;
  next: string | null;
  at: Date;
};

type EventSource = Pick<HistoryRow, "FieldName" | "ChangeType" | "PreviousValue" | "NewValue" | "ModificationTimestamp">;

/** Not copied: who made the change, whether staff made it, and the reason given. */
export function toActivityEvent(row: EventSource): ActivityEvent {
  return {
    kind: row.FieldName === "ListPrice" ? "price" : row.ChangeType === "New Listing" ? "new" : "status",
    previous: row.PreviousValue,
    next: row.NewValue,
    at: row.ModificationTimestamp,
  };
}

export type ActivityListing = {
  ListingKey: string;
  ListingId: string;
  PropertyType: string;
  UnparsedAddress: string;
  StandardStatus: string;
  ListPrice: number;
  ClosePrice: number | null;
  CloseDate: string | null;
  agentName: string;
  officeName: string;
  /** The most recent events, oldest first. */
  events: ActivityEvent[];
  /** Earlier events since the checkpoint that are not in the list above. */
  omittedEvents: number;
};

export type Activity = {
  savedSearch: SavedSearch;
  /** Stored criteria the application no longer accepts, by label. */
  ignored: string[];
  /** Mark-as-seen carries this: the reading goes up to here and no further. */
  through: number;
  /** Match the search as the member would run it now. */
  matching: ActivityListing[];
  /**
   * Do not match now, but would with their status and list price put back to
   * what they were at the checkpoint. Every other criterion is tested against
   * the listing as it is now, so this is not proof that they matched then.
   */
  mayNoLongerMatch: ActivityListing[];
  /** More listings have activity than are shown. How many was not counted. */
  moreListings: boolean;
};

const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const notFound = () => new ListingError("Not found.");
const isActiveMember = (viewer: Member | null): viewer is Member => viewer != null && viewer.MemberStatus === "Active";
const snapshot = { isolationLevel: "repeatable read" } as const;

const latestSequence = async (tx: Tx): Promise<number> => {
  const [{ latest }] = await tx
    .select({ latest: sql<number>`coalesce(max(${historyTransactional.OsmlsSequence}), 0)`.mapWith(Number) })
    .from(historyTransactional);
  return latest;
};

/**
 * Listings with an event after the checkpoint and up to the boundary that match
 * now, or may have matched at the checkpoint. Most recently changed first.
 */
async function listingsWithActivity(tx: Tx, viewer: Member, row: SavedSearch, through: number, limit: number) {
  const { criteria, ignored } = criteriaFromStored(row.OsmlsCriteria);
  const filters = criteriaToFilters(criteria, viewer);
  const h = historyTransactional;
  const firstPrevious = (field: string) =>
    sql<string | null>`(array_agg(${h.PreviousValue} order by ${h.OsmlsSequence}) filter (where ${h.FieldName} = ${field}))[1]`;
  const changed = tx.$with("changed").as(
    tx
      .select({
        key: h.ResourceRecordKey,
        lastSequence: sql<number>`max(${h.OsmlsSequence})`.mapWith(Number).as("last_sequence"),
        eventCount: sql<number>`count(*)::int`.as("event_count"),
        // A listing entered after the checkpoint did not exist at it.
        isNew: sql<boolean>`coalesce(bool_or(${h.ChangeType} = 'New Listing'), false)`.as("is_new"),
        // What status and list price were at the checkpoint, where they have changed since.
        statusThen: firstPrevious("StandardStatus").as("status_then"),
        priceThen: firstPrevious("ListPrice").as("price_then"),
      })
      .from(h)
      .where(
        and(
          eq(h.ResourceName, "Property"),
          inArray(h.FieldName, EVENT_FIELDS),
          gt(h.OsmlsSequence, row.OsmlsActivitySeenThrough),
          lte(h.OsmlsSequence, through),
        ),
      )
      .groupBy(h.ResourceRecordKey),
  );
  // A condition that is unknown (a listing with no pin, in an area search) is not a match.
  const whole = (conditions: ReturnType<typeof and>) => sql<boolean>`coalesce((${conditions ?? sql`true`}), false)`;
  const matchesNow = whole(and(fieldConditions(filters), areaCondition(filters)));
  const matchedThen = whole(
    and(
      fieldConditions(filters, {
        status: sql`coalesce(${changed.statusThen}, ${property.StandardStatus})`,
        listPrice: sql`coalesce(${changed.priceThen}::numeric, ${property.ListPrice})`,
      }),
      areaCondition(filters),
    ),
  );
  const rows = await tx
    .with(changed)
    .select({
      ListingKey: property.ListingKey,
      ListingId: property.ListingId,
      PropertyType: property.PropertyType,
      UnparsedAddress: property.UnparsedAddress,
      StandardStatus: property.StandardStatus,
      ListPrice: property.ListPrice,
      ClosePrice: property.ClosePrice,
      CloseDate: property.CloseDate,
      agentName: member.MemberFullName,
      officeName: office.OfficeName,
      eventCount: changed.eventCount,
      matchesNow: matchesNow.as("matches_now"),
    })
    .from(changed)
    .innerJoin(property, eq(property.ListingKey, changed.key))
    .innerJoin(member, eq(member.MemberKey, property.ListAgentKey))
    .innerJoin(office, eq(office.OfficeKey, property.ListOfficeKey))
    .where(sql`${matchesNow} or (not ${changed.isNew} and ${matchedThen})`)
    .orderBy(desc(changed.lastSequence), asc(property.ListingId))
    .limit(limit + 1);
  return { rows: rows.slice(0, limit), more: rows.length > limit, ignored };
}

/** Null for someone else's saved search and for one that does not exist alike. */
export async function getActivity(viewer: Member | null, key: unknown): Promise<Activity | null> {
  if (!isActiveMember(viewer) || !isKey(key)) return null;
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key));
    if (!row || !canUseSavedSearch(viewer, row)) return null;
    const through = await latestSequence(tx);
    const { rows, more, ignored } = await listingsWithActivity(tx, viewer, row, through, MAX_ACTIVITY_LISTINGS);

    const h = historyTransactional;
    const history = rows.length
      ? await tx
          .select()
          .from(h)
          .where(
            and(
              inArray(h.ResourceRecordKey, rows.map((r) => r.ListingKey)),
              eq(h.ResourceName, "Property"),
              inArray(h.FieldName, EVENT_FIELDS),
              gt(h.OsmlsSequence, row.OsmlsActivitySeenThrough),
              lte(h.OsmlsSequence, through),
            ),
          )
          .orderBy(asc(h.OsmlsSequence))
      : [];
    const eventsOf = new Map<string, ActivityEvent[]>();
    for (const entry of history) {
      const list = eventsOf.get(entry.ResourceRecordKey) ?? [];
      list.push(toActivityEvent(entry));
      eventsOf.set(entry.ResourceRecordKey, list);
    }
    const listings = rows.map(({ eventCount, matchesNow, ...listing }) => {
      const events = (eventsOf.get(listing.ListingKey) ?? []).slice(-MAX_ACTIVITY_EVENTS_PER_LISTING);
      return { matchesNow, listing: { ...listing, events, omittedEvents: eventCount - events.length } };
    });
    return {
      savedSearch: row,
      ignored,
      through,
      matching: listings.filter((l) => l.matchesNow).map((l) => l.listing),
      mayNoLongerMatch: listings.filter((l) => !l.matchesNow).map((l) => l.listing),
      moreListings: more,
    };
  }, snapshot);
}

export type ActivityCount = { listings: number; more: boolean };

/** For each of the viewer's saved searches, how many listings have activity, up to the page limit. */
export async function countActivity(viewer: Member | null): Promise<Map<string, ActivityCount>> {
  const counts = new Map<string, ActivityCount>();
  if (!isActiveMember(viewer)) return counts;
  await db.transaction(async (tx) => {
    const mine = await tx.select().from(savedSearch).where(eq(savedSearch.MemberKey, viewer.MemberKey));
    const through = await latestSequence(tx);
    for (const row of mine) {
      const { rows, more } = await listingsWithActivity(tx, viewer, row, through, MAX_ACTIVITY_LISTINGS);
      counts.set(row.SavedSearchKey, { listings: rows.length, more });
    }
  }, snapshot);
  return counts;
}

/**
 * Marks activity as seen up to the point a reading went to: everything in that
 * reading, shown or not, and nothing that arrived after it. The checkpoint only
 * ever moves forward, and never past the newest history there is.
 */
export async function markActivitySeen(viewer: Member | null, key: unknown, through: unknown): Promise<void> {
  if (!isActiveMember(viewer) || !isKey(key)) throw notFound();
  if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 0) throw new ListingError("Reload the page and try again.");
  await db.transaction(async (tx) => {
    // The row is read only once its lock is held, so overlapping requests are taken in turn.
    const [row] = await tx.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key)).for("update");
    if (!row || !canUseSavedSearch(viewer, row)) throw notFound();
    const upTo = Math.min(through, await latestSequence(tx));
    if (upTo <= row.OsmlsActivitySeenThrough) return;
    await tx
      .update(savedSearch)
      .set({ OsmlsActivitySeenThrough: upTo, OsmlsActivitySeenAt: new Date() })
      .where(eq(savedSearch.SavedSearchKey, key));
  });
}
