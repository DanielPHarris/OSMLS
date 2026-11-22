import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, between, count, desc, eq, gte, ilike, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "../db";
import { FILES_LOCK, INSTALLATION_ID_SQL, mediaFolderOwner } from "./backup";
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
import { STANDARD_STATUSES, type StandardStatus } from "./lookups";
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_LISTING, MAX_SEARCH_RESULTS } from "./rules/local";
import { currentSettings, getMarketTime, marketFactsSql, type MarketTime } from "./market-time";
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

/** The calendar date of a moment in a time zone, as YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The calendar date of a moment in the MLS's time zone, which is one of the market-time settings. */
export const mlsDate = async (at: Date): Promise<string> => localDate(at, (await currentSettings()).timeZone);

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

/**
 * Taken by every upload inside its transaction, before it writes its file. See
 * FILES_LOCK in src/lib/backup.ts: it is what keeps the sweep away from a file
 * whose record is still on its way.
 */
export async function holdFilesShared(tx: Tx): Promise<void> {
  await tx.execute(sql.raw(`select pg_advisory_xact_lock_shared(${FILES_LOCK})`));
  // A media folder that has been given to another database is swept by that database, which would
  // delete what this one puts in it. Nothing is written there.
  const owner = await mediaFolderOwner(mediaDir());
  if (owner === null) return;
  const [{ id }] = (await tx.execute(sql.raw(`select ${INSTALLATION_ID_SQL} as id`))).rows as { id: string }[];
  if (owner !== id) throw new ListingError("Files cannot be stored: the media folder belongs to another installation. Tell MLS staff.");
}

/**
 * The member a write is being made by, as they are now, read inside the
 * write's own transaction. A request is allowed when it begins on what the
 * member was then; this is what it is allowed on when it saves. A member
 * suspended in between saves nothing.
 *
 * The row is held shared until the write ends, so a suspension either
 * finished first, and is seen here, or waits until this write has finished.
 * It is taken before anything else the write locks.
 *
 * `refusal` is what a suspended member is told, where that is not the plain
 * statement: a document's existence is not confirmed to someone who may not
 * see it, suspended members included.
 */
export async function actingNow(tx: Tx, actor: Actor, refusal: () => Error = () => new ListingError("Your account is suspended. Nothing was saved.")): Promise<Actor> {
  const [now] = await tx
    .select({ MemberKey: member.MemberKey, MemberMlsId: member.MemberMlsId, OsmlsRole: member.OsmlsRole, OfficeKey: member.OfficeKey, MemberStatus: member.MemberStatus })
    .from(member)
    .where(eq(member.MemberKey, actor.MemberKey))
    .for("share");
  if (!now || now.MemberStatus !== "Active") throw refusal();
  return now;
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

/** A new listing's fields, checked as the entry form checks them: the one validation, and the rule on how a listing may start. */
export function validatedNewListing(raw: Record<string, unknown>): ListingInput {
  const parsed = parseListingInput(raw);
  const errors: FieldErrors = parsed.ok ? {} : { ...parsed.errors };
  // Said alongside whatever else is wrong with the fields, so that everything is reported at once.
  const status = parsed.ok ? parsed.data.StandardStatus : raw.StandardStatus;
  if ((STANDARD_STATUSES as readonly unknown[]).includes(status) && !INITIAL_STATUSES.includes(status as StandardStatus)) {
    errors.StandardStatus = `A new listing must start as ${INITIAL_STATUSES.join(" or ")}.`;
  }
  if (!parsed.ok || Object.keys(errors).length > 0) throw new ListingError("Some fields need attention.", errors);
  return parsed.data;
}

const squashed = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * What identifies a property for the purpose of taking turns: its parcel with
 * the county and state that issued it, and its street address. Coarser than
 * the matching in src/lib/market-time.ts on purpose (a unit is ignored), so
 * that anything that could be the same property shares a turn.
 */
export function propertyTurnKeys(input: Pick<ListingInput, "ParcelNumber" | "CountyOrParish" | "StateOrProvince" | "StreetNumber" | "StreetName" | "City" | "PostalCode">): string[] {
  const keys = [`address:${[input.StreetNumber, input.StreetName, input.City, input.StateOrProvince, input.PostalCode].map(squashed).join("|")}`];
  const parcel = (input.ParcelNumber ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (parcel && squashed(input.CountyOrParish) && squashed(input.StateOrProvince)) {
    keys.push(`parcel:${parcel}|${squashed(input.CountyOrParish)}|${squashed(input.StateOrProvince)}`);
  }
  return keys;
}

/**
 * Takes the turn for every property named, held to the end of the transaction.
 * Every creation of a listing takes it first, whether from the entry form or
 * from an import, so an import that checks for an existing listing of a
 * property cannot have one arrive between its check and its write. The locks
 * are taken in one order however they are asked for, so two transactions
 * cannot each hold what the other wants.
 */
export const takePropertyTurns = (tx: Tx, keys: readonly string[]) =>
  tx.execute(sql`
    select pg_advisory_xact_lock(1330860364, turn.key)
    from (select distinct hashtext(k) as key from unnest(${sql.param([...keys])}::text[]) as k order by 1) as turn`);

/** Where a listing that was not typed into the entry form came from. Recorded with its first history entry. */
export type ListingOrigin = { note: string };

/**
 * Creates a listing and its first history entry, inside the transaction it is
 * given. This is the one place a listing is created. The listing agent and the
 * member who acted are separate: for the entry form they are the same agent;
 * for an import the agent is the one a row names and the actor is the staff
 * member importing. The caller has validated the fields with
 * validatedNewListing and taken the property's turn.
 */
export async function createListingIn(
  tx: Tx,
  made: {
    input: ListingInput;
    listingAgent: Pick<Member, "MemberKey" | "OfficeKey">;
    actor: Pick<Member, "MemberKey" | "MemberMlsId">;
    now: Date;
    /** The calendar date of `now` in the MLS time zone. */
    today: string;
    origin?: ListingOrigin;
  },
): Promise<Property> {
  const { input, listingAgent, actor, now, today, origin } = made;
  if (!listingAgent.OfficeKey) throw new ListingError("Only agents can enter listings.");
  const [created] = await tx
    .insert(property)
    .values({
      ...input,
      OriginalListPrice: input.ListPrice,
      UnparsedAddress: unparsedAddress(input),
      OnMarketDate: input.StandardStatus === "Active" ? today : null,
      ListAgentKey: listingAgent.MemberKey,
      ListOfficeKey: listingAgent.OfficeKey,
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
    OsmlsCorrectionReason: origin?.note ?? null,
  });
  return created;
}

/** A listing entered by its agent. */
export async function createListing(
  actor: Actor,
  raw: Record<string, unknown>,
  when: ChangeTime = {},
): Promise<Property> {
  const now = when.at ?? new Date();
  if (actor.OsmlsRole !== "agent" || !actor.OfficeKey)
    throw new ListingError("Only agents can enter listings.");
  const input = validatedNewListing(raw);
  // Read before the transaction, so the transaction never waits for a second connection.
  const today = await mlsDate(now);

  return db.transaction(async (tx) => {

    actor = await actingNow(tx, actor);
    // Their role or office may have changed since the request began, too.
    if (actor.OsmlsRole !== "agent" || !actor.OfficeKey) throw new ListingError("Only agents can enter listings.");
    await takePropertyTurns(tx, propertyTurnKeys(input));
    return createListingIn(tx, { input, listingAgent: actor, actor, now, today });
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
  const settings = await currentSettings();

  return db.transaction(async (tx) => {

    actor = await actingNow(tx, actor);
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
        OnMarketDate: current.OnMarketDate ?? (to === "Active" ? localDate(now, settings.timeZone) : null),
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
  try {
    return await db.transaction(async (tx) => {
      actor = await actingNow(tx, actor);
      // Held until the record is committed, so the sweep never mistakes this file for one nothing refers to.
      await holdFilesShared(tx);
      await mkdir(mediaDir(), { recursive: true });
      await writeFile(path.join(mediaDir(), fileName), bytes);
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
    actor = await actingNow(tx, actor);
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
  // The photo's file is not deleted here. A backup being taken may refer to it;
  // files no record refers to are deleted by the sweep in src/lib/backup.ts.
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

/**
 * The search's conditions on a listing, apart from the map area. Status and list
 * price can be given as expressions, so the same conditions can be asked of what
 * a listing's status and price used to be (see src/lib/activity.ts).
 */
export function fieldConditions(f: SearchFilters, as: { status?: SQL; listPrice?: SQL } = {}): SQL | undefined {
  const status = as.status ?? sql`${property.StandardStatus}`;
  const listPrice = as.listPrice ?? sql`${property.ListPrice}`;
  return and(
    f.listingId ? ilike(property.ListingId, escapeLike(f.listingId.trim())) : undefined,
    f.address ? ilike(property.UnparsedAddress, `%${escapeLike(f.address.trim())}%`) : undefined,
    f.city ? ilike(property.City, escapeLike(f.city.trim())) : undefined,
    f.postalCode ? ilike(property.PostalCode, `${escapeLike(f.postalCode.trim())}%`) : undefined,
    f.minPrice != null ? sql`${listPrice} >= ${f.minPrice}` : undefined,
    f.maxPrice != null ? sql`${listPrice} <= ${f.maxPrice}` : undefined,
    f.minBeds != null ? gte(property.BedroomsTotal, f.minBeds) : undefined,
    f.minBaths != null ? gte(property.BathroomsTotalInteger, f.minBaths) : undefined,
    f.statuses?.length ? inArray(status, f.statuses) : undefined,
    f.listAgentKey ? eq(property.ListAgentKey, f.listAgentKey) : undefined,
    isIsoDate(f.closedFrom) ? gte(property.CloseDate, f.closedFrom) : undefined,
    isIsoDate(f.closedTo) ? lte(property.CloseDate, f.closedTo) : undefined,
    f.minClosePrice != null ? gte(property.ClosePrice, f.minClosePrice) : undefined,
    f.maxClosePrice != null ? lte(property.ClosePrice, f.maxClosePrice) : undefined,
  );
}

/**
 * A listing with no pin cannot be shown to be inside the area, so an area search
 * leaves it out. BETWEEN is never true for a missing value.
 */
export function areaCondition(f: SearchFilters): SQL | undefined {
  return f.bounds
    ? and(
        between(property.Latitude, f.bounds.south, f.bounds.north),
        between(property.Longitude, f.bounds.west, f.bounds.east),
      )
    : undefined;
}

export async function searchListings(filters: SearchFilters, options: { asOf?: Date } = {}) {
  const f = filters;
  // One moment for the whole search, so the order and the figures shown agree.
  const asOf = options.asOf ?? new Date();
  const settings = await currentSettings();
  const fieldFilters = fieldConditions(f);
  const inArea = areaCondition(f);

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
    .leftJoin(sql`(${marketFactsSql(asOf, settings)}) as mf`, sql`mf.key = ${property.ListingKey}`)
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
    { asOf, settings },
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
