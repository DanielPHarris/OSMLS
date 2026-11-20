import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { flag, historyTransactional, member, office, property, relistingLink, type Flag, type Member } from "../db/schema";
import { can, isActive, isListingSide } from "./access";
import { ListingError, lockListing, mlsDate } from "./listings";
import { FLAG_CATEGORIES, FLAG_STATES, type FlagState, type RelistingLinkMode } from "./lookups";
import { relistingLinkRefusal } from "./market-time";
import { actingStaff, checkedReason, takeAuthorityTurn } from "./members";
import { MAX_FLAGS_PER_MEMBER_PER_DAY, MAX_FLAG_TEXT_LENGTH } from "./rules/local";

/*
 * The compliance workflow: a member flags a listing, compliance staff close
 * the flag, and compliance staff can say which earlier listing a listing
 * continues when matching got it wrong.
 *
 * A flag changes nothing about its listing. Whatever needs correcting is
 * corrected through the ordinary staff correction, with its own reason.
 *
 * Who raised a flag is for compliance staff alone. The listing agent and
 * their office are shown the flags on their listing, and what they are given
 * is built here from named fields that do not include the reporter: it is not
 * a full record with parts hidden. The description and the closing note are
 * free text and are shown to them, so anonymity cannot be promised for what
 * someone chooses to type.
 */

const notFound = () => new ListingError("Not found.");
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

const flagInput = z.object({
  category: z.enum(FLAG_CATEGORIES, "Choose what the flag is about."),
  description: z.string().trim().min(1, "Describe the problem.").max(MAX_FLAG_TEXT_LENGTH, `Use ${MAX_FLAG_TEXT_LENGTH} characters or fewer.`),
});

const isDuplicateOpenFlag = (err: unknown) => {
  const cause = (err as { cause?: { code?: string; constraint?: string } }).cause ?? (err as { code?: string; constraint?: string });
  return cause?.code === "23505" && cause.constraint === "OsmlsFlag_one_open";
};

/**
 * Raises a flag on a listing. Any active member may, on any listing. The two
 * limits (one open flag per member, listing and category; a number per day)
 * are counted with the member's row locked, so flags sent at the same moment
 * are counted in turn. The day is the calendar date in the MLS time zone.
 */
export async function raiseFlag(viewer: Member | null, listingKey: unknown, input: unknown): Promise<Flag> {
  if (!isActive(viewer) || !isKey(listingKey)) throw notFound();
  const parsed = flagInput.safeParse(input);
  if (!parsed.success) {
    const errors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    throw new ListingError(Object.values(errors)[0], errors);
  }
  const { category, description } = parsed.data;
  const today = await mlsDate(new Date());
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ key: member.MemberKey }).from(member).where(eq(member.MemberKey, viewer.MemberKey)).for("update");
      const [listing] = await tx.select({ key: property.ListingKey }).from(property).where(eq(property.ListingKey, listingKey));
      if (!listing) throw notFound();
      const [{ raisedToday }] = await tx
        .select({ raisedToday: sql<number>`count(*)::int` })
        .from(flag)
        .where(and(eq(flag.RaisedByMemberKey, viewer.MemberKey), eq(flag.RaisedDate, today)));
      if (raisedToday >= MAX_FLAGS_PER_MEMBER_PER_DAY) {
        throw new ListingError(`You have raised ${MAX_FLAGS_PER_MEMBER_PER_DAY} flags today, which is the most allowed in a day.`);
      }
      const [row] = await tx
        .insert(flag)
        .values({ ListingKey: listingKey, RaisedByMemberKey: viewer.MemberKey, Category: category, Description: description, RaisedDate: today })
        .returning();
      return row;
    });
  } catch (err) {
    if (isDuplicateOpenFlag(err)) throw new ListingError(`You already have an open flag on this listing about "${category}".`);
    throw err;
  }
}

/** A flag as the listing side and the member who raised it are given it: no one's identity. */
export type FlagSummary = {
  flagKey: string;
  category: string;
  description: string;
  state: FlagState;
  raisedAt: Date;
  closedAt: Date | null;
  closingNote: string | null;
  /** True only for the viewer's own flags. It says nothing to anyone about anyone else. */
  mine: boolean;
};
/** A flag as compliance staff are given it. */
export type FlagDetail = FlagSummary & {
  listingKey: string;
  listingId: string;
  address: string;
  officeName: string;
  raisedBy: { name: string; memberId: string; email: string; officeName: string | null };
  closedBy: string | null;
};

const summary = (row: Flag, viewer: Member): FlagSummary => ({
  flagKey: row.FlagKey,
  category: row.Category,
  description: row.Description,
  state: row.State as FlagState,
  raisedAt: row.RaisedTimestamp,
  closedAt: row.ClosedTimestamp,
  closingNote: row.ClosingNote,
  mine: row.RaisedByMemberKey === viewer.MemberKey,
});

/**
 * The flags on a listing that this viewer may see, newest first. The listing
 * agent and their office see every flag on it; anyone else sees only their
 * own. Compliance staff use listFlags, which also says who raised each.
 */
export async function flagsOnListing(viewer: Member | null, listingKey: unknown): Promise<FlagSummary[]> {
  if (!isActive(viewer) || !isKey(listingKey)) return [];
  const [listing] = await db.select().from(property).where(eq(property.ListingKey, listingKey));
  if (!listing) return [];
  const all = isListingSide(viewer, listing) || can(viewer, "compliance");
  const rows = await db
    .select()
    .from(flag)
    .where(and(eq(flag.ListingKey, listingKey), all ? undefined : eq(flag.RaisedByMemberKey, viewer.MemberKey)))
    .orderBy(desc(flag.RaisedTimestamp));
  return rows.map((row) => summary(row, viewer));
}

export type FlagFilters = { state?: string; category?: string; office?: string; listing?: string };

/** Every flag, for compliance staff, newest first. Null for anyone else. */
export async function listFlags(actor: Member | null, filters: FlagFilters = {}): Promise<FlagDetail[] | null> {
  if (!can(actor, "compliance")) return null;
  const raiser = member;
  const rows = await db
    .select({
      row: flag,
      listingId: property.ListingId,
      address: property.UnparsedAddress,
      officeName: office.OfficeName,
      raiserName: raiser.MemberFullName,
      raiserId: raiser.MemberMlsId,
      raiserEmail: raiser.MemberEmail,
      raiserOffice: sql<string | null>`(select o."OfficeName" from "Office" o where o."OfficeKey" = "Member"."OfficeKey")`,
      closedBy: sql<string | null>`(select m."MemberFullName" from "Member" m where m."MemberKey" = "OsmlsFlag"."ClosedByMemberKey")`,
    })
    .from(flag)
    .innerJoin(property, eq(property.ListingKey, flag.ListingKey))
    .innerJoin(office, eq(office.OfficeKey, property.ListOfficeKey))
    .innerJoin(raiser, eq(raiser.MemberKey, flag.RaisedByMemberKey))
    .where(
      and(
        (FLAG_STATES as readonly string[]).includes(filters.state ?? "") ? eq(flag.State, filters.state!) : undefined,
        (FLAG_CATEGORIES as readonly string[]).includes(filters.category ?? "") ? eq(flag.Category, filters.category!) : undefined,
        isKey(filters.office) ? eq(property.ListOfficeKey, filters.office) : undefined,
        isKey(filters.listing) ? eq(flag.ListingKey, filters.listing) : undefined,
      ),
    )
    .orderBy(desc(flag.RaisedTimestamp));
  return rows.map((r) => ({
    ...summary(r.row, actor!),
    listingKey: r.row.ListingKey,
    listingId: r.listingId,
    address: r.address,
    officeName: r.officeName,
    raisedBy: { name: r.raiserName, memberId: r.raiserId, email: r.raiserEmail, officeName: r.raiserOffice },
    closedBy: r.closedBy,
  }));
}

/**
 * Closes an open flag as resolved or dismissed, with a note. The note is shown
 * to the member who raised the flag and to the listing side. A closed flag is
 * final: of two closures at the same moment, one succeeds.
 */
export async function closeFlag(actor: Member | null, flagKey: unknown, state: unknown, note: unknown): Promise<void> {
  if (!can(actor, "compliance") || !isKey(flagKey)) throw notFound();
  if (state !== "Resolved" && state !== "Dismissed") throw new ListingError("Choose Resolved or Dismissed.");
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) throw new ListingError("Give a closing note.", { note: "A closing note is required." });
  if (text.length > MAX_FLAG_TEXT_LENGTH) throw new ListingError(`Keep the note to ${MAX_FLAG_TEXT_LENGTH} characters.`, { note: `Use ${MAX_FLAG_TEXT_LENGTH} characters or fewer.` });
  await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor, "compliance");
    const closed = await tx
      .update(flag)
      .set({ State: state, ClosedByMemberKey: by.MemberKey, ClosedTimestamp: new Date(), ClosingNote: text })
      .where(and(eq(flag.FlagKey, flagKey), eq(flag.State, "Open")))
      .returning({ key: flag.FlagKey });
    if (closed.length === 0) {
      const [exists] = await tx.select({ key: flag.FlagKey }).from(flag).where(eq(flag.FlagKey, flagKey));
      if (!exists) throw notFound();
      throw new ListingError("This flag has already been closed. A closed flag is final.");
    }
  });
}

export type RelistingLinkView = { mode: RelistingLinkMode; listingId: string | null };

const linkText = (view: RelistingLinkView) => (view.mode === "automatic" ? "Automatic" : view.mode === "none" ? "None" : `Listing ${view.listingId}`);

async function linkOf(listingKey: string, read: Pick<typeof db, "select"> = db): Promise<RelistingLinkView> {
  const [row] = await read
    .select({ predecessorKey: relistingLink.PredecessorKey, listingId: property.ListingId })
    .from(relistingLink)
    .leftJoin(property, eq(property.ListingKey, relistingLink.PredecessorKey))
    .where(eq(relistingLink.ListingKey, listingKey));
  if (!row) return { mode: "automatic", listingId: null };
  return row.predecessorKey ? { mode: "named", listingId: row.listingId } : { mode: "none", listingId: null };
}

/** How this listing's earlier listing is chosen, for compliance staff. Null for anyone else. */
export async function getRelistingLink(actor: Member | null, listingKey: unknown): Promise<RelistingLinkView | null> {
  if (!can(actor, "compliance") || !isKey(listingKey)) return null;
  return linkOf(listingKey);
}

/**
 * Says which earlier listing a listing continues: chosen automatically, none,
 * or a listing named by its listing number. With a reason, and recorded in the
 * listing's change history as a staff correction.
 *
 * Naming a listing settles only that it is the same property. Whether the
 * count continues is still decided by the market-time settings and by how the
 * earlier listing ended, and a named listing may not lie the other side of a
 * sale of the property (src/lib/market-time.ts).
 */
export async function setRelistingLink(actor: Member | null, listingKey: unknown, input: { mode?: unknown; listingId?: unknown }, reason: unknown): Promise<void> {
  if (!can(actor, "compliance") || !isKey(listingKey)) throw notFound();
  const mode = input.mode;
  if (mode !== "automatic" && mode !== "none" && mode !== "named") throw new ListingError("Choose automatic, none, or a listing.");
  const why = checkedReason(reason);
  const named = typeof input.listingId === "string" ? input.listingId.trim() : "";
  await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor, "compliance");
    const listing = await lockListing(tx, listingKey).catch(() => {
      throw notFound();
    });
    let predecessorKey: string | null = null;
    if (mode === "named") {
      const [earlier] = named ? await tx.select().from(property).where(eq(property.ListingId, named)) : [];
      if (!earlier) throw new ListingError("Enter the listing number of the earlier listing.", { listingId: "No listing has that number." });
      const refusal = await relistingLinkRefusal(listing.ListingKey, earlier.ListingKey);
      if (refusal) throw new ListingError(refusal, { listingId: refusal });
      predecessorKey = earlier.ListingKey;
    }
    const before = await linkOf(listingKey, tx);
    const after: RelistingLinkView = { mode, listingId: mode === "named" ? named : null };
    if (linkText(before) === linkText(after)) return;
    if (mode === "automatic") await tx.delete(relistingLink).where(eq(relistingLink.ListingKey, listingKey));
    else {
      await tx
        .insert(relistingLink)
        .values({ ListingKey: listingKey, PredecessorKey: predecessorKey })
        .onConflictDoUpdate({ target: relistingLink.ListingKey, set: { PredecessorKey: predecessorKey, ModificationTimestamp: new Date() } });
    }
    await tx.insert(historyTransactional).values({
      ResourceRecordKey: listing.ListingKey,
      ResourceRecordID: listing.ListingId,
      ClassName: listing.PropertyType,
      FieldName: "OsmlsRelistingLink",
      PreviousValue: linkText(before),
      NewValue: linkText(after),
      ChangeType: null,
      ChangedByMemberKey: by.MemberKey,
      ChangedByMemberID: by.MemberMlsId,
      OsmlsStaffCorrection: true,
      OsmlsCorrectionReason: why,
    });
  });
}
