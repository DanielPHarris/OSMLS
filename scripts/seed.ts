/*
 * Loads synthetic demo data: two brokerages, six agents, two MLS staff, and
 * forty listings. Every person, office, and address here is invented.
 * Does nothing if the database already has offices.
 */
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { member, office, user } from "../src/db/schema";
import { createAuth } from "../src/lib/auth";
import { createListing, updateListing, type Actor } from "../src/lib/listings";
import type { ListingInput } from "../src/lib/listing-input";

const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error("DEMO_PASSWORD is not set. Copy .env.example to .env.");

if ((await db.select({ k: office.OfficeKey }).from(office).limit(1)).length > 0) {
  console.log("Database already has data; seed skipped.");
  await pool.end();
  process.exit(0);
}

const auth = createAuth({ allowSignUp: true });

const [harbor] = await db
  .insert(office)
  .values({ OfficeMlsId: "OFF1001", OfficeName: "Harborview Realty (Demo)", OfficeCity: "Port Alder", OfficeStateOrProvince: "WA", OfficePhone: "555-0100" })
  .returning();
const [harborEast] = await db
  .insert(office)
  .values({ OfficeMlsId: "OFF1002", OfficeName: "Harborview Realty East (Demo)", MainOfficeKey: harbor.OfficeKey, OfficeCity: "Cedar Hollow", OfficeStateOrProvince: "WA", OfficePhone: "555-0110" })
  .returning();
const [summit] = await db
  .insert(office)
  .values({ OfficeMlsId: "OFF2001", OfficeName: "Summit Line Properties (Demo)", OfficeCity: "Maple Ridge", OfficeStateOrProvince: "WA", OfficePhone: "555-0200" })
  .returning();

const people = [
  { first: "Alex", last: "Rivera", id: "AG1001", role: "agent", office: harbor },
  { first: "Jordan", last: "Okafor", id: "AG1002", role: "agent", office: harbor },
  { first: "Priya", last: "Nair", id: "AG1003", role: "agent", office: harborEast },
  { first: "Sam", last: "Whitfield", id: "AG2001", role: "agent", office: summit },
  { first: "Mei", last: "Tanaka", id: "AG2002", role: "agent", office: summit },
  { first: "Chris", last: "Dubois", id: "AG2003", role: "agent", office: summit },
  { first: "Morgan", last: "Ellis", id: "ST0001", role: "staff", office: null },
  { first: "Taylor", last: "Brooks", id: "ST0002", role: "staff", office: null },
] as const;

const actors: Actor[] = [];
for (const p of people) {
  const email = `${p.first}.${p.last}@osmls.example`.toLowerCase();
  const name = `${p.first} ${p.last}`;
  await auth.api.signUpEmail({ body: { email, password, name } });
  const [u] = await db.select().from(user).where(eq(user.email, email));
  const [m] = await db
    .insert(member)
    .values({
      MemberMlsId: p.id,
      MemberFirstName: p.first,
      MemberLastName: p.last,
      MemberFullName: name,
      MemberEmail: email,
      MemberDirectPhone: "555-0199",
      OfficeKey: p.office?.OfficeKey ?? null,
      OsmlsRole: p.role,
      OsmlsUserId: u.id,
    })
    .returning();
  actors.push(m);
}
const agents = actors.filter((a) => a.OsmlsRole === "agent");

// A small deterministic generator so every seed run produces the same listings.
let state = 20261118;
const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const streets = ["Alder St", "Birchwood Ave", "Cannery Row", "Dogwood Ln", "Eagle Crest Dr", "Fernhill Rd", "Granite Way", "Heron Ct", "Ironwood Pl", "Juniper Terrace"];
// The towns are invented. Their map positions are arbitrary points chosen so the
// demo has somewhere to show; pins do not mark real properties.
const towns = [
  { City: "Port Alder", PostalCode: "98001", at: [47.31, -122.26] },
  { City: "Cedar Hollow", PostalCode: "98002", at: [47.3, -122.2] },
  { City: "Maple Ridge", PostalCode: "98003", at: [47.32, -122.32] },
  { City: "Stonebridge", PostalCode: "98004", at: [47.36, -122.24] },
] as const;
const near = (centre: number) => Number((centre + (rand() - 0.5) * 0.04).toFixed(6));
const remarks = [
  "Synthetic demo listing. Light-filled home with an updated kitchen and a fenced yard.",
  "Synthetic demo listing. Quiet street, new roof, and a detached two-car garage.",
  "Synthetic demo listing. Open floor plan with hardwood floors and a covered deck.",
  "Synthetic demo listing. Corner lot close to parks, schools, and transit.",
];
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

for (let i = 0; i < 40; i++) {
  const agent = agents[i % agents.length];
  const town = pick(towns);
  const beds = between(1, 5);
  const price = between(250, 1400) * 1000;
  const base: ListingInput = {
    StandardStatus: "Active",
    PropertyType: i % 9 === 0 ? "Land" : i % 7 === 0 ? "Residential Income" : "Residential",
    ListPrice: price,
    ListingContractDate: daysAgo(between(5, 120)),
    StreetNumber: String(between(100, 9900)),
    StreetName: pick(streets),
    UnitNumber: i % 10 === 3 ? String(between(1, 40)) : null,
    City: town.City,
    PostalCode: town.PostalCode,
    StateOrProvince: "WA",
    // A few listings have no pin, as some will in a real MLS.
    Latitude: i % 8 === 6 ? null : near(town.at[0]),
    Longitude: i % 8 === 6 ? null : near(town.at[1]),
    BedroomsTotal: i % 9 === 0 ? 0 : beds,
    BathroomsTotalInteger: i % 9 === 0 ? 0 : Math.max(1, beds - between(0, 2)),
    LivingArea: i % 9 === 0 ? null : between(700, 4200),
    LotSizeAcres: Number((between(5, 300) / 100).toFixed(2)),
    YearBuilt: i % 9 === 0 ? null : between(1925, 2025),
    PublicRemarks: pick(remarks),
    ClosePrice: null,
    CloseDate: null,
  };
  const created = await createListing(agent, base);
  const edit = (changes: Partial<ListingInput>) =>
    updateListing(agent, created.ListingKey, Object.assign(base, changes));

  // Give some listings a realistic past so history and status filters have content.
  if (i % 4 === 1) await edit({ ListPrice: price - 15000 });
  if (i % 5 === 2) await edit({ StandardStatus: "Pending" });
  if (i % 10 === 7) {
    await edit({ StandardStatus: "Pending" });
    await edit({ StandardStatus: "Closed", ClosePrice: price - 8000, CloseDate: daysAgo(1) });
  }
  if (i % 13 === 5) await edit({ StandardStatus: "Withdrawn" });
}

console.log(`Seeded 3 offices, ${actors.length} members, 40 listings.`);
console.log("Sign in with any <first>.<last>@osmls.example address and DEMO_PASSWORD from .env.");
await pool.end();
