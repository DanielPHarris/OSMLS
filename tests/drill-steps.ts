/*
 * The parts of the restore drill that use the application itself. Each runs as
 * its own process, against whatever database and media folder its environment
 * names, so the drill never touches the test database or the development one.
 * The last line printed is the step's result, as JSON.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { historyTransactional, member, property } from "../src/db/schema";
import { auth } from "../src/lib/auth";
import { addDocument, removeDocument, replaceDocument } from "../src/lib/documents";
import { addPhoto, createListing, removePhoto, updateListing } from "../src/lib/listings";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const [step, argument] = process.argv.slice(2);
const [agent] = await db.select().from(member).where(eq(member.MemberMlsId, "AG1001"));
const fields = (street: string, price: string) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: price, ListingContractDate: "2026-01-01",
  StreetNumber: "1", StreetName: street, City: "Drillville", StateOrProvince: "WA", PostalCode: "98981", BedroomsTotal: "3", BathroomsTotalInteger: "2",
});
const highest = async () => ({
  listingNumber: Number((await db.execute(sql`select max(substring("ListingId" from 3)::bigint) as n from "Property"`)).rows[0].n),
  historySequence: Number((await db.select({ n: historyTransactional.OsmlsSequence }).from(historyTransactional).orderBy(desc(historyTransactional.OsmlsSequence)).limit(1))[0].n),
});
let result: unknown;

if (step === "load") {
  // A listing with two photos and three documents, uploaded as a member would upload them.
  const listing = await createListing(agent, fields("Drill Rd", "500000"));
  const photos = [await addPhoto(agent, listing.ListingKey, png), await addPhoto(agent, listing.ListingKey, png)];
  const documents = {
    kept: await addDocument(agent, listing.ListingKey, { bytes: pdf("kept"), name: "Kept", permission: "Private" }),
    replaced: await addDocument(agent, listing.ListingKey, { bytes: pdf("the original"), name: "Replaced", permission: "Private" }),
    deleted: await addDocument(agent, listing.ListingKey, { bytes: pdf("deleted later"), name: "Deleted", permission: "Private" }),
  };
  result = { listingKey: listing.ListingKey, photos: photos.map((p) => p.MediaKey), documents: Object.fromEntries(Object.entries(documents).map(([k, d]) => [k, d.MediaKey])), ...(await highest()) };
} else if (step === "change-during-backup") {
  // What a member might do while a backup is running: replace one document, delete another, remove a photo.
  const loaded = JSON.parse(argument);
  await replaceDocument(agent, loaded.documents.replaced, pdf("the replacement, which is longer"));
  await removeDocument(agent, loaded.documents.deleted);
  await removePhoto(agent, loaded.photos[1]);
  result = { changed: 3 };
} else if (step === "change-after-backup") {
  const loaded = JSON.parse(argument);
  const later = await createListing(agent, fields("After The Backup Rd", "700000"));
  await updateListing(agent, loaded.listingKey, fields("Drill Rd", "450000"));
  result = { laterListingKey: later.ListingKey };
} else if (step === "use-after-restore") {
  // The restored system is used: a member signs in, and a new listing is entered.
  const signedIn = await auth.api.signInEmail({ body: { email: agent.MemberEmail, password: process.env.DEMO_PASSWORD! } }).then(() => true, () => false);
  const before = await highest();
  const created = await createListing(agent, fields("After The Restore Rd", "600000"));
  const [restored] = await db.select().from(property).where(eq(property.StreetName, "Drill Rd"));
  result = { signedIn, before, after: await highest(), newListingNumber: Number(created.ListingId.slice(2)), restoredListPrice: restored.ListPrice };
} else if (step === "upload-photo") {
  // One more photo on the loaded listing, uploaded as a member would.
  const loaded = JSON.parse(argument);
  const photo = await addPhoto(agent, loaded.listingKey, png);
  result = { mediaKey: photo.MediaKey, file: photo.OsmlsStoragePath };
} else throw new Error(`Unknown step: ${step}`);

console.log(JSON.stringify(result));
await pool.end();
