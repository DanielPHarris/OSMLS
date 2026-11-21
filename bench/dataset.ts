/*
 * Fills the database in DATABASE_URL with the synthetic benchmark dataset:
 * offices, agents, and listings entered through the application's own
 * function. It is a benchmark dataset, not a model of any MLS.
 */
import { db, pool } from "../src/db";
import { member, office, user } from "../src/db/schema";
import { createListing } from "../src/lib/listings";

/** What the entry form would send for the listing with this number. Its price is what a price change alters. */
export const formFor = (streetNumber: string, city: string, price: number) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: String(price), ListingContractDate: "2026-01-01",
  StreetNumber: streetNumber, StreetName: "Bench St", City: city, StateOrProvince: "WA", PostalCode: "96562",
  BedroomsTotal: "3", BathroomsTotalInteger: "2",
});

if (process.argv[1]?.endsWith("dataset.ts")) {
  if (!/\/osmls_bench_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("bench/dataset.ts fills only a benchmark database.");
  const { offices, agents, listings } = JSON.parse(process.argv[2]) as { offices: number; agents: number; listings: number };
  const made = await db
    .insert(office)
    .values(Array.from({ length: offices }, (_, i) => ({ OfficeMlsId: `BOFF${i}`, OfficeName: `Bench Office ${i}`, OfficeCity: `Benchtown ${i}`, OfficeStateOrProvince: "WA" })))
    .returning();
  // Accounts no one can sign in to: they have no password.
  await db.insert(user).values(Array.from({ length: agents }, (_, i) => ({ id: `bench-${i}`, name: `Bench Agent ${i}`, email: `bench.agent.${i}@osmls.example` })));
  const people = await db
    .insert(member)
    .values(
      Array.from({ length: agents }, (_, i) => ({
        MemberMlsId: `BAG${i}`, MemberFirstName: "Bench", MemberLastName: `Agent ${i}`, MemberFullName: `Bench Agent ${i}`,
        MemberEmail: `bench.agent.${i}@osmls.example`, OfficeKey: made[i % offices].OfficeKey, OsmlsRole: "agent", OsmlsCapabilities: [], OsmlsUserId: `bench-${i}`,
      })),
    )
    .returning();
  // Entered a few at a time: quicker than one by one, and the order does not matter here.
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let i = next++; i < listings; i = next++) {
        const agent = people[i % agents];
        await createListing(agent, formFor(String(i + 1), `Benchtown ${i % offices}`, 400000));
      }
    }),
  );
  console.log(`Dataset: ${offices} offices, ${agents} agents, ${listings} listings.`);
  await pool.end();
}
