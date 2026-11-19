import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, between, count, desc, eq, gte, ilike, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import {
  historyTransactional,
  media,
  member,
  office,
  property,
  type Member,
  type Property,
} from "../db/schema";
import { canViewDocument, canViewShowing, type Viewer } from "./access";
import { parseListingInput, type FieldErrors, type ListingInput } from "./listing-input";
import type { StandardStatus } from "./lookups";
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_LISTING, MAX_SEARCH_RESULTS } from "./rules/local";
import { getMarketTime, marketFactsSql, type MarketTime } from "./market-time";
import { MARKET_TIME_SETTINGS } from "./rules/market-time";
import { isCalendarDate, isOwnKey } from "./validation";
import { INITIAL_STATUSES, canTransition, changeTypeForStatus, isTerminal } from "./rules/status";

export type Actor = Pick<Member, "MemberKey" | "MemberMlsId" | "OsmlsRole" | "OfficeKey" | "MemberStatus">;

/** A request that was understood but is not allowed or not valid. Safe to show to the user. */
export class ListingError extends Error {
  constructor(
    message: string,
    public fieldErrors: FieldErrors = {},
  ) {
    super(message);
  }
}

export const mediaDir = () => path.resolve(process.env.MEDIA_DIR ?? "./data/media");

// Fields whose changes are recorded in history, one row per field.
const TRACKED_FIELDS = [
  "StandardStatus",
  "ListPrice",
  "PropertyType",
  "ListingContractDate",
  "StreetNumber",
  "StreetName",
  "UnitNumber",
  "City",
  "StateOrProvince",
  "PostalCode",
  "CountyOrParish",
  "ParcelNumber",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "LivingArea",
  "LotSizeAcres",
  "YearBuilt",
  "PublicRemarks",
  "ShowingInstructions",
  "ShowingRequirements",
  "ShowingContactName",
  "ShowingContactPhone",
  "ShowingContactType",
  "LockBoxType",
  "LockBoxLocation",
  "Latitude",
  "Longitude",
  "ClosePrice",
  "CloseDate",
] as const satisfies readonly (keyof ListingInput)[];

const asText = (v: unknown): string | null =>
  Array.isArray(v) ? (v.length ? v.join(", ") : null) : v == null ? null : String(v);

/** A copy of the listing with its showing details blanked. See canViewShowing in access.ts. */
export function withoutShowing(listing: Property): Property {
  return {
    ...listing,
    ShowingInstructions: null,
    ShowingRequirements: [],
    ShowingContactName: null,
    ShowingContactPhone: null,
    ShowingContactType: [],
    LockBoxType: [],
    LockBoxLocation: null,
  };
}

function unparsedAddress(v: ListingInput): string {
  const unit = v.UnitNumber ? ` #${v.UnitNumber}` : "";
  return `${v.StreetNumber} ${v.StreetName}${unit}, ${v.City}, ${v.StateOrProvince} ${v.PostalCode}`;
}

/** The calendar date of a moment in the MLS's time zone, as YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string = MARKET_TIME_SETTINGS.timeZone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * When a change is taken to have happened. Normally now. The seed script and
 * tests may supply a past moment so that demo listings have a past; no screen,
 * form, or request can, because nothing that handles them passes this.
 */
export type ChangeTime = { at?: Date };

export function canEdit(actor: Actor, listing: Pick<Property, "ListAgentKey">): boolean {
  return actor.OsmlsRole === "staff" || listing.ListAgentKey === actor.MemberKey;
}

export const canViewHistory = (actor: Actor) => actor.OsmlsRole === "staff";

/**
 * Checks that the actor may change this listing, and returns the correction
 * details to record. Listing agents change their own open listings. MLS staff
 * may correct any listing but must say why.
 */
export function authorizeChange(actor: Actor, listing: Property, correctionReason?: string | null) {
  if (actor.OsmlsRole === "staff") {
    const reason = correctionReason?.trim();
    if (!reason)
      throw new ListingError("A staff correction needs a reason.", {
        correctionReason: "Explain why this correction is being made.",
      });
    return { OsmlsStaffCorrection: true, OsmlsCorrectionReason: reason };
  }
  if (listing.ListAgentKey !== actor.MemberKey)
    throw new ListingError("Only the listing agent or MLS staff can change this listing.");
  if (isTerminal(listing.StandardStatus as StandardStatus))
    throw new ListingError(
      `A listing that is ${listing.StandardStatus} can only be changed by MLS staff.`,
    );
  return { OsmlsStaffCorrection: false, OsmlsCorrectionReason: null };
}

export async function lockListing(tx: Tx, listingKey: string): Promise<Property> {
  const [row] = await tx.select().from(property).where(eq(property.ListingKey, listingKey)).for("update");
  if (!row) throw new ListingError("Listing not found.");
  return row;
}

function validated(raw: Record<string, unknown>): ListingInput {
  const parsed = parseListingInput(raw);
  if (!parsed.ok) throw new ListingError("Some fields need attention.", parsed.errors);
  return parsed.data;
}

export async function createListing(
  actor: Actor,
  raw: Record<string, unknown>,
  when: ChangeTime = {},
): Promise<Property> {
  const now = when.at ?? new Date();
  if (actor.OsmlsRole !== "agent" || !actor.OfficeKey)
    throw new ListingError("Only agents can enter listings.");
  const input = validated(raw);
  if (!INITIAL_STATUSES.includes(input.StandardStatus))
    throw new ListingError("Some fields need attention.", {
      StandardStatus: `A new listing must start as ${INITIAL_STATUSES.join(" or ")}.`,
    });

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(property)
      .values({
        ...input,
        OriginalListPrice: input.ListPrice,
        UnparsedAddress: unparsedAddress(input),
        OnMarketDate: input.StandardStatus === "Active" ? localDate(now) : null,
        ListAgentKey: actor.MemberKey,
        ListOfficeKey: actor.OfficeKey!,
        OriginalEntryTimestamp: now,
        ModificationTimestamp: now,
        StatusChangeTimestamp: now,
      })
      .returning();
    await tx.insert(historyTransactional).values({
      ResourceRecordKey: created.ListingKey,
      ResourceRecordID: created.ListingId,
      ClassName: created.PropertyType,
      FieldName: "StandardStatus",
      PreviousValue: null,
      NewValue: created.StandardStatus,
      ChangeType: "New Listing",
      ChangedByMemberKey: actor.MemberKey,
      ChangedByMemberID: actor.MemberMlsId,
      ModificationTimestamp: now,
    });
    return created;
  });
}

/**
 * Applies an edit and writes one history row per changed field, in the same
 * transaction. Returns the listing and how many fields changed.
 */
export async function updateListing(
  actor: Actor,
  listingKey: string,
  raw: Record<string, unknown>,
  correctionReason?: string | null,
  when: ChangeTime = {},
): Promise<{ listing: Property; changedFields: string[] }> {
  const input = validated(raw);

  return db.transaction(async (tx) => {
    const current = await lockListing(tx, listingKey);
    const correction = authorizeChange(actor, current, correctionReason);
    const from = current.StandardStatus as StandardStatus;
    const to = input.StandardStatus;

    if (!correction.OsmlsStaffCorrection && !canTransition(from, to))
      throw new ListingError("Some fields need attention.", {
        StandardStatus: `A listing cannot go from ${from} to ${to}.`,
      });

    const changed = TRACKED_FIELDS.filter((f) => asText(current[f]) !== asText(input[f]));
    if (changed.length === 0) return { listing: current, changedFields: [] };

    const now = when.at ?? new Date();
    const statusChanged = from !== to;
    const priceChanged = current.ListPrice !== input.ListPrice;

    const [updated] = await tx
      .update(property)
      .set({
        ...input,
        UnparsedAddress: unparsedAddress(input),
        OnMarketDate: current.OnMarketDate ?? (to === "Active" ? localDate(now) : null),
        ModificationTimestamp: now,
        ...(statusChanged ? { StatusChangeTimestamp: now } : {}),
        ...(priceChanged ? { PriceChangeTimestamp: now } : {}),
      })
      .where(eq(property.ListingKey, listingKey))
      .returning();

    await tx.insert(historyTransactional).values(
      changed.map((field) => ({
        ResourceRecordKey: updated.ListingKey,
        ResourceRecordID: updated.ListingId,
        ClassName: updated.PropertyType,
        FieldName: field,
        PreviousValue: asText(current[field]),
        NewValue: asText(input[field]),
        ChangeType:
          field === "StandardStatus"
            ? changeTypeForStatus(from, to)
            : field === "ListPrice"
              ? "Price Change"
              : null,
        ChangedByMemberKey: actor.MemberKey,
        ChangedByMemberID: actor.MemberMlsId,
        ModificationTimestamp: now,
        ...correction,
      })),
    );
    return { listing: updated, changedFields: [...changed] };
  });
}

// ---- Photos ----

/** Identify an image by its leading bytes rather than trusting the browser. */
export function sniffImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (
    b.length > 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return { mime: "image/webp", ext: "webp" };
  return null;
}

export async function addPhoto(
  actor: Actor,
  listingKey: string,
  bytes: Uint8Array,
  correctionReason?: string | null,
) {
  if (bytes.length === 0) throw new ListingError("Choose a photo to upload.");
  if (bytes.length > MAX_PHOTO_BYTES) throw new ListingError("That photo is larger than 8 MB.");
  const type = sniffImageType(bytes);
  if (!type) throw new ListingError("Photos must be JPEG, PNG, or WebP images.");

  const fileName = `${randomUUID()}.${type.ext}`;
  await mkdir(mediaDir(), { recursive: true });
  await writeFile(path.join(mediaDir(), fileName), bytes);
  try {
    return await db.transaction(async (tx) => {
      const listing = await lockListing(tx, listingKey);
      const correction = authorizeChange(actor, listing, correctionReason);
      const existing = await tx
        .select({ Order: media.Order })
        .from(media)
        .where(and(eq(media.ResourceRecordKey, listingKey), eq(media.MediaCategory, "Photo")));
      if (existing.length >= MAX_PHOTOS_PER_LISTING)
        throw new ListingError(`A listing can have at most ${MAX_PHOTOS_PER_LISTING} photos.`);
      const order = Math.max(0, ...existing.map((m) => m.Order)) + 1;
      const [created] = await tx
        .insert(media)
        .values({ ResourceRecordKey: listingKey, MediaType: type.mime, Order: order, OsmlsStoragePath: fileName })
        .returning();
      await tx.insert(historyTransactional).values({
        ResourceRecordKey: listing.ListingKey,
        ResourceRecordID: listing.ListingId,
        ClassName: listing.PropertyType,
        FieldName: "Media",
        PreviousValue: null,
        NewValue: `Photo ${order} added`,
        ChangedByMemberKey: actor.MemberKey,
        ChangedByMemberID: actor.MemberMlsId,
        ...correction,
      });
      await tx.update(property).set({ ModificationTimestamp: new Date() }).where(eq(property.ListingKey, listingKey));
      return created;
    });
  } catch (err) {
    await unlink(path.join(mediaDir(), fileName)).catch(() => {});
    throw err;
  }
}

export async function removePhoto(actor: Actor, mediaKey: string, correctionReason?: string | null) {
  const removed = await db.transaction(async (tx) => {
    const isThisPhoto = and(eq(media.MediaKey, mediaKey), eq(media.MediaCategory, "Photo"));
    // An unlocked look, only to learn which listing to lock.
    const [pointer] = await tx.select({ listingKey: media.ResourceRecordKey }).from(media).where(isThisPhoto);
    if (!pointer) throw new ListingError("Photo not found.");
    const listing = await lockListing(tx, pointer.listingKey);
    // Read the photo once the lock is held, so an overlapping removal is seen.
    const [photo] = await tx.select().from(media).where(isThisPhoto).for("update");
    if (!photo) throw new ListingError("Photo not found.");
    const correction = authorizeChange(actor, listing, correctionReason);
    await tx.delete(media).where(eq(media.MediaKey, mediaKey));
    await tx.insert(historyTransactional).values({
      ResourceRecordKey: listing.ListingKey,
      ResourceRecordID: listing.ListingId,
      ClassName: listing.PropertyType,
      FieldName: "Media",
      PreviousValue: `Photo ${photo.Order}`,
      NewValue: null,
      ChangedByMemberKey: actor.MemberKey,
      ChangedByMemberID: actor.MemberMlsId,
      ...correction,
    });
    await tx.update(property).set({ ModificationTimestamp: new Date() }).where(eq(property.ListingKey, listing.ListingKey));
    return photo;
  });
  await unlink(path.join(mediaDir(), removed.OsmlsStoragePath)).catch(() => {});
  return removed;
}

// ---- Reading ----

export type SearchFilters = {
  listingId?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  minBaths?: number;
  statuses?: StandardStatus[];
  listAgentKey?: string;
  /** Limit results to listings whose pin is inside this map area. */
  bounds?: MapBounds;
  /** Close dates are YYYY-MM-DD and inclusive. They only ever match closed listings. */
  closedFrom?: string;
  closedTo?: string;
  minClosePrice?: number;
  maxClosePrice?: number;
  sort?: SearchSort;
};

export const SEARCH_SORTS = {
  changed: "Recently changed",
  price_high: "List price, high to low",
  price_low: "List price, low to high",
  closed_recent: "Close date, most recent first",
  dom_low: "Days on market, fewest first",
  dom_high: "Days on market, most first",
} as const;
export type SearchSort = keyof typeof SEARCH_SORTS;

const isIsoDate = (s: string | undefined): s is string => isCalendarDate(s);

export type MapBounds = { west: number; south: number; east: number; north: number };

/**
 * Reads "west,south,east,north" from a URL. Returns undefined unless it is four
 * sensible numbers. Areas that cross the 180th meridian are not supported.
 */
export function parseBounds(value: string | undefined): MapBounds | undefined {
  const parts = value?.split(",").map(Number);
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return undefined;
  if (west < -180 || east > 180 || south < -90 || north > 90) return undefined;
  return { west, south, east, north };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export async function searchListings(filters: SearchFilters, options: { asOf?: Date } = {}) {
  const f = filters;
  // One moment for the whole search, so the order and the figures shown agree.
  const asOf = options.asOf ?? new Date();
  const fieldFilters = and(
    f.listingId ? ilike(property.ListingId, escapeLike(f.listingId.trim())) : undefined,
    f.address ? ilike(property.UnparsedAddress, `%${escapeLike(f.address.trim())}%`) : undefined,
    f.city ? ilike(property.City, escapeLike(f.city.trim())) : undefined,
    f.postalCode ? ilike(property.PostalCode, `${escapeLike(f.postalCode.trim())}%`) : undefined,
    f.minPrice != null ? gte(property.ListPrice, f.minPrice) : undefined,
    f.maxPrice != null ? lte(property.ListPrice, f.maxPrice) : undefined,
    f.minBeds != null ? gte(property.BedroomsTotal, f.minBeds) : undefined,
    f.minBaths != null ? gte(property.BathroomsTotalInteger, f.minBaths) : undefined,
    f.statuses?.length ? inArray(property.StandardStatus, f.statuses) : undefined,
    f.listAgentKey ? eq(property.ListAgentKey, f.listAgentKey) : undefined,
    isIsoDate(f.closedFrom) ? gte(property.CloseDate, f.closedFrom) : undefined,
    isIsoDate(f.closedTo) ? lte(property.CloseDate, f.closedTo) : undefined,
    f.minClosePrice != null ? gte(property.ClosePrice, f.minClosePrice) : undefined,
    f.maxClosePrice != null ? lte(property.ClosePrice, f.maxClosePrice) : undefined,
  );
  // A listing with no pin cannot be shown to be inside the area, so an area
  // search leaves it out. BETWEEN is never true for a missing value.
  const inArea = f.bounds
    ? and(
        between(property.Latitude, f.bounds.south, f.bounds.north),
        between(property.Longitude, f.bounds.west, f.bounds.east),
      )
    : undefined;

  // Days on market come from the same query that produces the figures shown.
  const dom = sql<number>`coalesce(mf.dom, 0)`;
  const tieBreak = [desc(property.ModificationTimestamp), asc(property.ListingId)];
  const order = {
    changed: tieBreak,
    price_high: [desc(property.ListPrice), ...tieBreak],
    price_low: [asc(property.ListPrice), ...tieBreak],
    closed_recent: [sql`${property.CloseDate} desc nulls last`, ...tieBreak],
    dom_low: [asc(dom), ...tieBreak],
    dom_high: [desc(dom), ...tieBreak],
    // An own-key check: a plain "in" would accept "constructor" and find no order.
  }[isOwnKey(SEARCH_SORTS, f.sort) ? f.sort : "changed"];

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
    .from(property)
    .innerJoin(member, eq(member.MemberKey, property.ListAgentKey))
    .innerJoin(office, eq(office.OfficeKey, property.ListOfficeKey))
    .leftJoin(sql`(${marketFactsSql(asOf)}) as mf`, sql`mf.key = ${property.ListingKey}`)
    .where(and(fieldFilters, inArea))
    .orderBy(...order)
    .limit(MAX_SEARCH_RESULTS + 1);

  // How many listings match the other filters but have no pin.
  const [{ withoutLocation }] = await db
    .select({ withoutLocation: count() })
    .from(property)
    .where(and(fieldFilters, isNull(property.Latitude)));

  const shown = rows.slice(0, MAX_SEARCH_RESULTS);
  const marketTime = await getMarketTime(
    shown.map((row) => row.listing.ListingKey),
    { asOf },
  );
  const noMarketTime: MarketTime = {
    daysOnMarket: 0,
    cumulativeDaysOnMarket: 0,
    firstOnMarketDate: null,
    offMarketDate: null,
    continues: [],
  };

  return {
    // Search results never carry showing details, whoever is asking.
    rows: shown.map((row) => ({
      ...row,
      listing: withoutShowing(row.listing),
      marketTime: marketTime.get(row.listing.ListingKey) ?? noMarketTime,
    })),
    truncated: rows.length > MAX_SEARCH_RESULTS,
    withoutLocation,
  };
}

/**
 * A listing as one particular viewer may see it. Showing details and documents
 * the viewer is not allowed to see are left out here, so no screen can pass them
 * on by mistake.
 */
export async function getListing(listingKey: string, viewer: Viewer) {
  if (!/^[0-9a-f-]{36}$/i.test(listingKey)) return null;
  const [row] = await db
    .select({ listing: property, agent: member, office })
    .from(property)
    .innerJoin(member, eq(member.MemberKey, property.ListAgentKey))
    .innerJoin(office, eq(office.OfficeKey, property.ListOfficeKey))
    .where(eq(property.ListingKey, listingKey));
  if (!row) return null;
  const allMedia = await db
    .select()
    .from(media)
    .where(eq(media.ResourceRecordKey, listingKey))
    .orderBy(asc(media.Order));
  const showingVisible = canViewShowing(viewer, row.listing);
  return {
    ...row,
    listing: showingVisible ? row.listing : withoutShowing(row.listing),
    showingVisible,
    photos: allMedia.filter((m) => m.MediaCategory === "Photo"),
    documents: allMedia.filter(
      (m) => m.MediaCategory === "Document" && canViewDocument(viewer, row.listing, m.Permission),
    ),
  };
}

export async function getHistory(listingKey: string) {
  return db
    .select({ entry: historyTransactional, changedByName: member.MemberFullName, changedByRole: member.OsmlsRole })
    .from(historyTransactional)
    .innerJoin(member, eq(member.MemberKey, historyTransactional.ChangedByMemberKey))
    .where(eq(historyTransactional.ResourceRecordKey, listingKey))
    .orderBy(desc(historyTransactional.ModificationTimestamp), desc(historyTransactional.OsmlsSequence));
}

/** Photos only. A document's key is never served by the photo route. */
export async function getPhoto(mediaKey: string) {
  if (!/^[0-9a-f-]{36}$/i.test(mediaKey)) return null;
  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.MediaKey, mediaKey), eq(media.MediaCategory, "Photo")));
  return row ?? null;
}
