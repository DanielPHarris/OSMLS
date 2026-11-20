import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { mailBlock, member, office, share, type Media, type Member, type Share } from "../db/schema";
import { isActive } from "./access";
import { formatDate } from "./format";
import { ListingError, getListing, getPhoto, mlsDate } from "./listings";
import { MailError, appUrl, mailEnabled, sendMail } from "./mail";
import { disclosureLines } from "./reports";
import { isClientCopyStatus, toClientListing, type ClientListing, type ClientListingSource } from "./rules/client-copy";
import {
  DEFAULT_SHARE_EXPIRY_DAYS,
  MAX_ACTIVE_SHARES_PER_MEMBER,
  MAX_LISTINGS_PER_REPORT,
  MAX_PHOTOS_PER_REPORT,
  MAX_SHARE_EMAILS_PER_DAY,
  MAX_SHARE_NOTE_LENGTH,
  SHARE_EXPIRY_DAYS,
  SHARE_RECORD_RETENTION_DAYS,
} from "./rules/local";
import { getCollection } from "./saved-work";

/*
 * Links a member gives a client, and the page behind them.
 *
 * The link's secret is the only credential. It is made here, handed back once,
 * and kept only as a hash. A link works while it is unexpired, unrevoked, and
 * its owner's account is active; anything else answers exactly like a link that
 * never existed. Deleting a shared collection ends its links.
 *
 * What a link shows is read fresh each time and built only by toClientListing
 * (src/lib/rules/client-copy.ts). A link to a collection shows what is in the
 * collection now. Nothing about who opens a link is recorded.
 *
 * A recipient's address is kept only while its link works. A keyed hash of it
 * stays with the link's record so that a request for no more email can be met
 * after the address itself is gone.
 */

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const KEY_SHAPE = /^[0-9a-f-]{36}$/i;

/** Keyed, so the stored value cannot be matched against a list of addresses without the server's secret. */
const hashAddress = (address: string) =>
  createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "")
    .update(address.trim().toLowerCase())
    .digest("hex");

export const shareUrl = (token: string) => `${appUrl()}/share/${token}`;

export type ShareTarget = { listing: string } | { collection: string };

const shareInput = z.object({
  days: z.coerce
    .number()
    .refine((n) => (SHARE_EXPIRY_DAYS as readonly number[]).includes(n))
    .default(DEFAULT_SHARE_EXPIRY_DAYS),
  // Blank means: make the link, send nothing.
  email: z.union([z.literal(""), z.email().max(254)]).default(""),
  note: z.string().trim().max(MAX_SHARE_NOTE_LENGTH).default(""),
});

async function officeNameOf(owner: Pick<Member, "OfficeKey">): Promise<string | null> {
  if (!owner.OfficeKey) return null;
  const [row] = await db.select({ name: office.OfficeName }).from(office).where(eq(office.OfficeKey, owner.OfficeKey));
  return row?.name ?? null;
}

const working = and(isNull(share.OsmlsRevokedTimestamp), gt(share.ExpirationTimestamp, sql`now()`));

/**
 * Makes a link to one listing or one of the member's collections and, if an
 * address is given, emails it. The link comes back once; it cannot be read
 * again afterwards.
 */
export async function createShare(
  viewer: Member | null,
  target: ShareTarget,
  input: unknown,
): Promise<{ link: string; emailedTo: string | null; expires: Date }> {
  const notFound = new ListingError("listing" in target ? "Listing not found." : "Collection not found.");
  if (!isActive(viewer)) throw notFound;
  let targetKeys: { ListingKey: string } | { CollectionKey: string };
  if ("listing" in target) {
    const found = await getListing(target.listing, viewer);
    if (!found) throw notFound;
    if (!isClientCopyStatus(found.listing.StandardStatus)) {
      throw new ListingError(`A ${found.listing.StandardStatus} listing cannot be shared with a client.`);
    }
    targetKeys = { ListingKey: found.listing.ListingKey };
  } else {
    // getCollection answers null for someone else's collection.
    const found = await getCollection(viewer, target.collection);
    if (!found) throw notFound;
    targetKeys = { CollectionKey: found.collection.CollectionKey };
  }
  const parsed = shareInput.safeParse(input);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    const message =
      field === "email"
        ? "Enter one email address, or leave it blank."
        : field === "note"
          ? `Keep the note to ${MAX_SHARE_NOTE_LENGTH} characters.`
          : "Choose how long the link lasts.";
    throw new ListingError(message, { [field]: message });
  }
  const { days, email, note } = parsed.data;
  if (email && !mailEnabled()) throw new ListingError("Email is not set up on this system. Leave the address blank and copy the link.");

  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const created = await db.transaction(async (tx) => {
    // The member's row is locked first, so overlapping requests are counted in turn.
    await tx.select({ key: member.MemberKey }).from(member).where(eq(member.MemberKey, viewer.MemberKey)).for("update");
    const count = async (...conditions: Parameters<typeof and>) =>
      (await tx.select({ n: sql<number>`count(*)::int` }).from(share).where(and(eq(share.MemberKey, viewer.MemberKey), ...conditions)))[0].n;
    if ((await count(working)) >= MAX_ACTIVE_SHARES_PER_MEMBER) {
      throw new ListingError(`You have ${MAX_ACTIVE_SHARES_PER_MEMBER} working links, which is the most allowed. Revoke one first.`);
    }
    if (email) {
      if ((await count(gt(share.OsmlsSentTimestamp, sql`now() - interval '1 day'`))) >= MAX_SHARE_EMAILS_PER_DAY) {
        throw new ListingError(`You have emailed ${MAX_SHARE_EMAILS_PER_DAY} links in the last day, which is the most allowed. Make a link and send it yourself.`);
      }
      const [blocked] = await tx.select().from(mailBlock).where(eq(mailBlock.OsmlsAddressHash, hashAddress(email)));
      if (blocked) {
        const message = "That address has asked not to receive email from this system. Make a link and send it yourself.";
        throw new ListingError(message, { email: message });
      }
    }
    const [row] = await tx
      .insert(share)
      .values({
        MemberKey: viewer.MemberKey,
        OsmlsTokenHash: hashToken(token),
        ...targetKeys,
        ExpirationTimestamp: expires,
        OsmlsRecipientEmail: email || null,
        OsmlsRecipientHash: email ? hashAddress(email) : null,
        OsmlsSentTimestamp: email ? new Date() : null,
      })
      .returning();
    return row;
  });
  const link = shareUrl(token);
  if (!email) return { link, emailedTo: null, expires };

  const officeName = await officeNameOf(viewer);
  const what = "listing" in target ? "a listing" : "some listings";
  try {
    // No listing data goes in the email: everything a client sees is on the page.
    await sendMail({
      to: email,
      replyTo: viewer.MemberEmail,
      subject: `${viewer.MemberFullName} shared ${what} with you`,
      text: [
        `${viewer.MemberFullName}${officeName ? ` of ${officeName}` : ""} shared ${what} with you.`,
        ...(note ? ["", note] : []),
        "",
        link,
        "",
        `This link works until ${formatDate(await mlsDate(expires))}. Reply to this email to reach ${viewer.MemberFullName}.`,
        "",
        `To stop all email from this system to your address: ${link}/stop`,
      ].join("\n"),
    });
  } catch (err) {
    if (!(err instanceof MailError)) throw err;
    // Nobody was given this link by us, so it should not go on working.
    await db.delete(share).where(eq(share.ShareKey, created.ShareKey));
    throw new ListingError(
      err.delivered === "no"
        ? "The email could not be sent, so no link was made. Try again."
        : "The mail server did not confirm the email. It may or may not arrive; if it does, its link will not work. Try again.",
    );
  }
  return { link, emailedTo: email, expires };
}

/** This member's own working links to one listing or collection. Never anyone else's. */
export async function listShares(viewer: Member | null, target: ShareTarget): Promise<Share[]> {
  if (!isActive(viewer)) return [];
  const key = "listing" in target ? target.listing : target.collection;
  if (!KEY_SHAPE.test(key)) return [];
  return db
    .select()
    .from(share)
    .where(
      and(
        eq(share.MemberKey, viewer.MemberKey),
        "listing" in target ? eq(share.ListingKey, key) : eq(share.CollectionKey, key),
        working,
      ),
    )
    .orderBy(desc(share.OriginalEntryTimestamp));
}

/** Ends a link at once. Someone else's link answers like one that does not exist. */
export async function revokeShare(viewer: Member | null, shareKey: unknown): Promise<void> {
  const notFound = new ListingError("Link not found.");
  if (!isActive(viewer) || typeof shareKey !== "string" || !KEY_SHAPE.test(shareKey)) throw notFound;
  const revoked = await db
    .update(share)
    // The address is no longer needed once the link is dead.
    .set({ OsmlsRevokedTimestamp: sql`coalesce(${share.OsmlsRevokedTimestamp}, now())`, OsmlsRecipientEmail: null })
    .where(and(eq(share.ShareKey, shareKey), eq(share.MemberKey, viewer.MemberKey)))
    .returning({ key: share.ShareKey });
  if (revoked.length === 0) throw notFound;
}

/** The link's record and its owner, only while the link works. */
async function resolve(token: string) {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .select({ share, owner: member })
    .from(share)
    .innerJoin(member, eq(member.MemberKey, share.MemberKey))
    .where(
      and(
        eq(share.OsmlsTokenHash, hashToken(token)),
        working,
        // A link whose collection was deleted points at nothing, however it came to.
        sql`num_nonnulls(${share.ListingKey}, ${share.CollectionKey}) = 1`,
        // A suspended member's links stop with their account.
        eq(member.MemberStatus, "Active"),
      ),
    );
  return row ?? null;
}

type Shown = {
  kind: "listing" | "collection";
  /** What the page shows now, each with the photos it shows. Eligibility first, then the limit. */
  sources: ClientListingSource[];
  /** In the collection but not in a status given to clients. */
  omittedForStatus: number;
  eligible: number;
};

/** What a working link shows right now. The page and the photo route both ask here. */
async function shownBy(found: NonNullable<Awaited<ReturnType<typeof resolve>>>): Promise<Shown> {
  if (found.share.ListingKey) {
    const listing = await getListing(found.share.ListingKey, null);
    const eligible = listing && isClientCopyStatus(listing.listing.StandardStatus) ? 1 : 0;
    return {
      kind: "listing",
      omittedForStatus: 0,
      eligible,
      sources:
        listing && eligible
          ? [
              {
                listing: listing.listing,
                agentName: listing.agent.MemberFullName,
                officeName: listing.office.OfficeName,
                photoKeys: listing.photos.slice(0, MAX_PHOTOS_PER_REPORT).map((p) => p.MediaKey),
              },
            ]
          : [],
    };
  }
  // The collection as its owner has it now. The owner is active: resolve checked.
  const collection = await getCollection(found.owner, found.share.CollectionKey);
  const rows = collection?.rows ?? [];
  const eligible = rows.filter((r) => isClientCopyStatus(r.listing.StandardStatus));
  return {
    kind: "collection",
    omittedForStatus: rows.length - eligible.length,
    eligible: eligible.length,
    sources: eligible.slice(0, MAX_LISTINGS_PER_REPORT).map((r) => ({
      listing: r.listing,
      agentName: r.agentName,
      officeName: r.officeName,
      photoKeys: r.firstPhotoKey ? [r.firstPhotoKey] : [],
    })),
  };
}

export type SharedPage = {
  kind: "listing" | "collection";
  sharedBy: { name: string; officeName: string | null; phone: string | null; email: string };
  expires: Date;
  /** Empty when nothing the link points at is in a status given to clients right now. */
  listings: ClientListing[];
  /** What the reader must be told about anything left out. */
  notes: string[];
};

/** What a link shows to whoever holds it. Null for any link that does not work. */
export async function getSharedPage(token: string): Promise<SharedPage | null> {
  const found = await resolve(token);
  if (!found) return null;
  const { owner } = found;
  const shown = await shownBy(found);
  return {
    kind: shown.kind,
    sharedBy: {
      name: owner.MemberFullName,
      officeName: await officeNameOf(owner),
      phone: owner.MemberDirectPhone,
      email: owner.MemberEmail,
    },
    expires: found.share.ExpirationTimestamp,
    listings: shown.sources.map((source) => toClientListing({ ...source, photoUrl: (key) => `/share/${token}/media/${key}` })),
    notes:
      shown.kind === "collection"
        ? disclosureLines({
            kind: "collection",
            disclosure: { eligible: shown.eligible, shown: shown.sources.length, totalIsExact: true, omittedForStatus: shown.omittedForStatus },
          })
        : [],
  };
}

/** A photo, only through a working link and only if that link's page shows it now. */
export async function getSharedPhoto(token: string, mediaKey: string): Promise<Media | null> {
  const found = await resolve(token);
  if (!found || !KEY_SHAPE.test(mediaKey)) return null;
  const shown = await shownBy(found);
  if (!shown.sources.some((s) => s.photoKeys.includes(mediaKey))) return null;
  return getPhoto(mediaKey);
}

/**
 * Whether a stop request can be made with this link: true for any link that was
 * emailed and whose record still exists, working or not.
 */
export async function canStopEmail(token: string): Promise<boolean> {
  if (!TOKEN_SHAPE.test(token)) return false;
  const [row] = await db
    .select({ hash: share.OsmlsRecipientHash })
    .from(share)
    .where(and(eq(share.OsmlsTokenHash, hashToken(token)), isNotNull(share.OsmlsRecipientHash)));
  return Boolean(row);
}

/**
 * The recipient of an emailed link asks for no more email. Their address is
 * deleted from every link, and its keyed hash is kept so later sends are
 * refused. Links already sent go on working. False when the link is not known.
 */
export async function stopEmail(token: string): Promise<boolean> {
  if (!TOKEN_SHAPE.test(token)) return false;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ hash: share.OsmlsRecipientHash })
      .from(share)
      .where(and(eq(share.OsmlsTokenHash, hashToken(token)), isNotNull(share.OsmlsRecipientHash)));
    if (!row?.hash) return false;
    await tx.insert(mailBlock).values({ OsmlsAddressHash: row.hash }).onConflictDoNothing();
    await tx.update(share).set({ OsmlsRecipientEmail: null }).where(eq(share.OsmlsRecipientHash, row.hash));
    return true;
  });
}

/**
 * Housekeeping, run by the scheduled command: deletes addresses on links that
 * have expired, and deletes the records of links that ended some time ago.
 */
export async function cleanUpShares(): Promise<{ addressesDeleted: number; recordsDeleted: number }> {
  const addresses = await db
    .update(share)
    .set({ OsmlsRecipientEmail: null })
    .where(and(isNotNull(share.OsmlsRecipientEmail), lte(share.ExpirationTimestamp, sql`now()`)))
    .returning({ key: share.ShareKey });
  const cutoff = sql`now() - make_interval(days => ${SHARE_RECORD_RETENTION_DAYS})`;
  const records = await db
    .delete(share)
    .where(or(lte(share.ExpirationTimestamp, cutoff), lte(share.OsmlsRevokedTimestamp, cutoff)))
    .returning({ key: share.ShareKey });
  return { addressesDeleted: addresses.length, recordsDeleted: records.length };
}
