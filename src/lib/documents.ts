import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, type Tx } from "../db";
import { historyTransactional, media, property, type Media, type Property } from "../db/schema";
import { canViewDocument, type Viewer } from "./access";
import { ListingError, authorizeChange, lockListing, mediaDir, type Actor } from "./listings";
import { DOCUMENT_PERMISSIONS, DEFAULT_DOCUMENT_PERMISSION, type DocumentPermission } from "./lookups";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS_PER_LISTING } from "./rules/local";

/*
 * Listing documents. Files live in a folder that nothing serves directly, under
 * generated names; the only way to one is the download route, which asks
 * canViewDocument on every request.
 */

export const documentsDir = () => path.join(mediaDir(), "documents");
export const documentPath = (storedName: string) => path.join(documentsDir(), path.basename(storedName));

const MAX_NAME_LENGTH = 120;

/**
 * Identify a file by its leading bytes rather than its name or what the browser
 * says. This establishes the type only. It does not show a file is safe to open.
 */
export function sniffDocumentType(bytes: Uint8Array): { mime: string; ext: string } | null {
  const b = bytes;
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d)
    return { mime: "application/pdf", ext: "pdf" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { mime: "image/png", ext: "png" };
  return null;
}

function checkedFile(bytes: Uint8Array) {
  if (bytes.length === 0) throw new ListingError("Choose a file to upload.");
  if (bytes.length > MAX_DOCUMENT_BYTES)
    throw new ListingError(`That file is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
  const type = sniffDocumentType(bytes);
  if (!type) throw new ListingError("Documents must be PDF, JPEG, or PNG files.");
  return { type, hash: createHash("sha256").update(bytes).digest("hex") };
}

function checkedName(name: unknown): string {
  const clean = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (!clean) throw new ListingError("Give the document a name.", { name: "A name is required." });
  if (clean.length > MAX_NAME_LENGTH)
    throw new ListingError("That name is too long.", { name: `Use ${MAX_NAME_LENGTH} characters or fewer.` });
  return clean;
}

function checkedPermission(permission: unknown): DocumentPermission {
  if (permission == null || permission === "") return DEFAULT_DOCUMENT_PERMISSION;
  if (!(DOCUMENT_PERMISSIONS as readonly unknown[]).includes(permission))
    throw new ListingError("Choose who can see this document.", { permission: "Choose one of the options." });
  return permission as DocumentPermission;
}

/** What history records about a file: enough to recognise it later, not its contents. */
const describeFile = (d: Pick<Media, "ShortDescription" | "MediaType" | "OsmlsFileSize" | "OsmlsFileHash">) =>
  `${d.ShortDescription} (${d.MediaType}, ${d.OsmlsFileSize} bytes, SHA-256 ${d.OsmlsFileHash})`;

/**
 * Finds a document for someone who wants to change it.
 *
 * Changes to a listing's documents are serialised by locking the listing. The
 * document is read only after that lock is held, so two overlapping requests
 * cannot both act on the same stale record: the second sees what the first left.
 *
 * To anyone who may not even see the document it does not exist: they get the
 * same answer as for a key that was never issued.
 */
async function findForChange(tx: Tx, actor: Actor, mediaKey: string): Promise<{ current: Media; listing: Property }> {
  const notFound = () => new ListingError("Document not found.");
  if (!/^[0-9a-f-]{36}$/i.test(mediaKey)) throw notFound();
  const isThisDocument = and(eq(media.MediaKey, mediaKey), eq(media.MediaCategory, "Document"));

  // An unlocked look, only to learn which listing to lock. Nothing else is taken from it.
  const [pointer] = await tx.select({ listingKey: media.ResourceRecordKey }).from(media).where(isThisDocument);
  if (!pointer) throw notFound();
  const listing = await lockListing(tx, pointer.listingKey);

  // The record as it stands now that no one else can change it.
  const [current] = await tx.select().from(media).where(isThisDocument).for("update");
  if (!current || current.ResourceRecordKey !== listing.ListingKey) throw notFound();
  if (!canViewDocument(actor, listing, current.Permission)) throw notFound();
  return { current, listing };
}

type HistoryEntry = { FieldName: string; PreviousValue: string | null; NewValue: string | null };

async function record(
  tx: Tx,
  actor: Actor,
  listing: Property,
  correction: ReturnType<typeof authorizeChange>,
  entries: HistoryEntry[],
) {
  if (entries.length === 0) return;
  await tx.insert(historyTransactional).values(
    entries.map((entry) => ({
      ResourceRecordKey: listing.ListingKey,
      ResourceRecordID: listing.ListingId,
      ClassName: listing.PropertyType,
      ...entry,
      ChangedByMemberKey: actor.MemberKey,
      ChangedByMemberID: actor.MemberMlsId,
      ...correction,
    })),
  );
  await tx.update(property).set({ ModificationTimestamp: new Date() }).where(eq(property.ListingKey, listing.ListingKey));
}

async function storeFile(bytes: Uint8Array, ext: string): Promise<string> {
  const storedName = `${randomUUID()}.${ext}`;
  await mkdir(documentsDir(), { recursive: true });
  await writeFile(documentPath(storedName), bytes, { mode: 0o600 });
  return storedName;
}

/**
 * Deletes a file that was written for a record that was then never made. Only
 * that: a file some record has ever referred to is not deleted here, because a
 * backup being taken may refer to it. Those are deleted, once nothing refers
 * to them, by the sweep in src/lib/backup.ts.
 */
const discardUnusedFile = (storedName: string) => unlink(documentPath(storedName)).catch(() => {});

export async function addDocument(
  actor: Actor,
  listingKey: string,
  input: { bytes: Uint8Array; name: unknown; permission: unknown },
  correctionReason?: string | null,
): Promise<Media> {
  const name = checkedName(input.name);
  const permission = checkedPermission(input.permission);
  const { type, hash } = checkedFile(input.bytes);
  const storedName = await storeFile(input.bytes, type.ext);
  try {
    return await db.transaction(async (tx) => {
      const listing = await lockListing(tx, listingKey);
      const correction = authorizeChange(actor, listing, correctionReason);
      const existing = await tx
        .select({ Order: media.Order })
        .from(media)
        .where(and(eq(media.ResourceRecordKey, listingKey), eq(media.MediaCategory, "Document")));
      if (existing.length >= MAX_DOCUMENTS_PER_LISTING)
        throw new ListingError(`A listing can have at most ${MAX_DOCUMENTS_PER_LISTING} documents.`);
      const [created] = await tx
        .insert(media)
        .values({
          ResourceRecordKey: listingKey,
          MediaCategory: "Document",
          MediaType: type.mime,
          Order: Math.max(0, ...existing.map((m) => m.Order)) + 1,
          ShortDescription: name,
          Permission: permission,
          OsmlsStoragePath: storedName,
          OsmlsFileSize: input.bytes.length,
          OsmlsFileHash: hash,
        })
        .returning();
      await record(tx, actor, listing, correction, [
        { FieldName: "Document", PreviousValue: null, NewValue: `Added: ${describeFile(created)}; visible to: ${permission}` },
      ]);
      return created;
    });
  } catch (err) {
    await discardUnusedFile(storedName);
    throw err;
  }
}

/** Swaps the file, keeping the document's name and permission. The old file is destroyed. */
export async function replaceDocument(
  actor: Actor,
  mediaKey: string,
  bytes: Uint8Array,
  correctionReason?: string | null,
): Promise<Media> {
  const { type, hash } = checkedFile(bytes);
  const storedName = await storeFile(bytes, type.ext);
  let superseded: string;
  let updated: Media;
  try {
    [superseded, updated] = await db.transaction(async (tx) => {
      const { current, listing } = await findForChange(tx, actor, mediaKey);
      const correction = authorizeChange(actor, listing, correctionReason);
      const [next] = await tx
        .update(media)
        .set({
          MediaType: type.mime,
          OsmlsStoragePath: storedName,
          OsmlsFileSize: bytes.length,
          OsmlsFileHash: hash,
          ModificationTimestamp: new Date(),
        })
        .where(eq(media.MediaKey, mediaKey))
        .returning();
      await record(tx, actor, listing, correction, [
        { FieldName: "Document", PreviousValue: `Replaced: ${describeFile(current)}`, NewValue: `With: ${describeFile(next)}` },
      ]);
      return [current.OsmlsStoragePath, next] as const;
    });
  } catch (err) {
    await discardUnusedFile(storedName);
    throw err;
  }
  // The superseded file is left for the sweep: a backup being taken may refer to it.
  void superseded;
  return updated;
}

/** Renames a document or changes who can see it. */
export async function updateDocument(
  actor: Actor,
  mediaKey: string,
  input: { name: unknown; permission: unknown },
  correctionReason?: string | null,
): Promise<{ document: Media; changed: boolean }> {
  const name = checkedName(input.name);
  if (input.permission == null || input.permission === "")
    throw new ListingError("Choose who can see this document.", { permission: "Choose one of the options." });
  const permission = checkedPermission(input.permission);
  return db.transaction(async (tx) => {
    const { current, listing } = await findForChange(tx, actor, mediaKey);
    const correction = authorizeChange(actor, listing, correctionReason);
    const entries: HistoryEntry[] = [];
    if (current.ShortDescription !== name)
      entries.push({ FieldName: "Document name", PreviousValue: current.ShortDescription, NewValue: name });
    if (current.Permission !== permission)
      entries.push({
        FieldName: "Document permission",
        PreviousValue: `${name}: ${current.Permission}`,
        NewValue: `${name}: ${permission}`,
      });
    if (entries.length === 0) return { document: current, changed: false };
    const [next] = await tx
      .update(media)
      .set({ ShortDescription: name, Permission: permission, ModificationTimestamp: new Date() })
      .where(eq(media.MediaKey, mediaKey))
      .returning();
    await record(tx, actor, listing, correction, entries);
    return { document: next, changed: true };
  });
}

export async function removeDocument(actor: Actor, mediaKey: string, correctionReason?: string | null) {
  const removed = await db.transaction(async (tx) => {
    const { current, listing } = await findForChange(tx, actor, mediaKey);
    const correction = authorizeChange(actor, listing, correctionReason);
    await tx.delete(media).where(eq(media.MediaKey, mediaKey));
    await record(tx, actor, listing, correction, [
      { FieldName: "Document", PreviousValue: `Deleted: ${describeFile(current)}`, NewValue: null },
    ]);
    return current;
  });
  // The removed document's file is left for the sweep: a backup being taken may refer to it.
  return removed;
}

/**
 * The document, if this viewer may have it. Returns null both when it does not
 * exist and when the viewer is not allowed, so the two cannot be told apart.
 */
export async function getDocumentForViewer(viewer: Viewer, mediaKey: string): Promise<Media | null> {
  if (!/^[0-9a-f-]{36}$/i.test(mediaKey)) return null;
  const [row] = await db
    .select({ document: media, listing: property })
    .from(media)
    .innerJoin(property, eq(property.ListingKey, media.ResourceRecordKey))
    .where(and(eq(media.MediaKey, mediaKey), eq(media.MediaCategory, "Document")));
  if (!row || !canViewDocument(viewer, row.listing, row.document.Permission)) return null;
  return row.document;
}
