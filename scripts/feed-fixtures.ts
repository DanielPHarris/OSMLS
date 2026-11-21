/*
 * Gives a few listings photos, for checking the data exchange feed against a
 * test or development database: the seeded demo data has no photos, and a feed
 * with no photo records leaves the photo parts of the RESO certification tool
 * untested. The photos are one-pixel placeholders. Listings that already have
 * photos are left alone, so running this twice adds nothing.
 */
import { asc, eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { member, property } from "../src/db/schema";
import { addPhoto } from "../src/lib/listings";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const listings = await db
  .select({ listing: property, agent: member })
  .from(property)
  .innerJoin(member, eq(member.MemberKey, property.ListAgentKey))
  .where(sql`${property.StandardStatus} in ('Active', 'Coming Soon') and not exists (select 1 from "Media" m where m."ResourceRecordKey" = ${property.ListingKey} and m."MediaCategory" = 'Photo')`)
  .orderBy(asc(property.ListingId))
  .limit(5);
let added = 0;
for (const { listing, agent } of listings) {
  for (let n = 0; n < 2; n++) {
    await addPhoto(agent, listing.ListingKey, png);
    added++;
  }
}
console.log(`Added ${added} placeholder photos to ${listings.length} listings.`);
await pool.end();
