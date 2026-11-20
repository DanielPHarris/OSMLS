/*
 * Loads synthetic demo data: two brokerages, six agents, two MLS staff, two
 * suspended accounts, and fifty-five listings with up to a year of history. Every person, office, and address here is invented.
 * Does nothing if the database already has offices.
 */
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { member, office, user } from "../src/db/schema";
import { createAuth } from "../src/lib/auth";
import { createListing, localDate, updateListing, type Actor } from "../src/lib/listings";
import { latestSettings } from "../src/lib/market-time";
import type { ListingInput } from "../src/lib/listing-input";
import { CAPABILITIES } from "../src/lib/lookups";

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
  // Suspended accounts: they can sign in but are refused everything.
  { first: "Riley", last: "Chen", id: "AG1099", role: "agent", office: harbor, status: "Inactive" },
  { first: "Casey", last: "Morgan", id: "ST0099", role: "staff", office: null, status: "Inactive" },
] as const;

const actors: (Actor & { MemberStatus: string })[] = [];
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
      // As after an upgrade: every staff account starts with all of them.
      OsmlsCapabilities: p.role === "staff" ? [...CAPABILITIES] : [],
      MemberStatus: "status" in p ? p.status : "Active",
      OsmlsUserId: u.id,
    })
    .returning();
  actors.push(m);
}
const agents = actors.filter((a) => a.OsmlsRole === "agent" && a.MemberStatus === "Active");

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
// Demo listings need a past: sales to research, days on market to count. The
// seed gives each change a time, which only the seed and tests are able to do.
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const { timeZone } = await latestSettings();
const dateAgo = (days: number) => localDate(ago(days), timeZone);

type Change = { daysAgo: number; set: Partial<ListingInput> };
let listingCount = 0;

/** Enters a listing some days ago and applies later changes, each on its own day. */
async function story(agent: Actor, fields: ListingInput, enteredDaysAgo: number, changes: Change[] = []) {
  const current: ListingInput = { ...fields, ListingContractDate: dateAgo(enteredDaysAgo) };
  const created = await createListing(agent, current, { at: ago(enteredDaysAgo) });
  for (const change of changes) {
    Object.assign(current, change.set);
    await updateListing(agent, created.ListingKey, current, null, { at: ago(change.daysAgo) });
  }
  listingCount++;
  return created;
}

const closed = (daysAgo: number, price: number): Change => ({
  daysAgo,
  set: { StandardStatus: "Closed", ClosePrice: price, CloseDate: dateAgo(daysAgo) },
});
const status = (daysAgo: number, to: ListingInput["StandardStatus"]): Change => ({ daysAgo, set: { StandardStatus: to } });

const showing = {
  ShowingInstructions: "Synthetic demo instructions. Call the listing agent to arrange a time. Remove shoes.",
  ShowingRequirements: ["Appointment Only", "Call Listing Agent"],
  ShowingContactName: "Listing agent",
  ShowingContactPhone: "555-0199",
  ShowingContactType: ["Agent"],
  LockBoxType: ["Supra"],
  LockBoxLocation: "Front door",
};
const noShowing = {
  ShowingInstructions: null,
  ShowingRequirements: [],
  ShowingContactName: null,
  ShowingContactPhone: null,
  ShowingContactType: [],
  LockBoxType: [],
  LockBoxLocation: null,
};

// ---- Forty assorted listings across the four towns ----
for (let i = 0; i < 40; i++) {
  const agent = agents[i % agents.length];
  const town = pick(towns);
  const beds = between(1, 5);
  const price = between(250, 1400) * 1000;
  const land = i % 9 === 0;
  const fields: ListingInput = {
    StandardStatus: "Active",
    PropertyType: land ? "Land" : i % 7 === 0 ? "Residential Income" : "Residential",
    ListPrice: price,
    ListingContractDate: dateAgo(1),
    StreetNumber: String(between(100, 9900)),
    StreetName: pick(streets),
    UnitNumber: i % 10 === 3 ? String(between(1, 40)) : null,
    City: town.City,
    CountyOrParish: "Alder County",
    ParcelNumber: `${1000 + i}-${String(100 + ((i * 37) % 900))}-${String(10 + (i % 90))}`,
    PostalCode: town.PostalCode,
    StateOrProvince: "WA",
    // A few listings have no pin, as some will in a real MLS.
    Latitude: i % 8 === 6 ? null : near(town.at[0]),
    Longitude: i % 8 === 6 ? null : near(town.at[1]),
    BedroomsTotal: land ? 0 : beds,
    BathroomsTotalInteger: land ? 0 : Math.max(1, beds - between(0, 2)),
    LivingArea: land ? null : between(700, 4200),
    LotSizeAcres: Number((between(5, 300) / 100).toFixed(2)),
    YearBuilt: land ? null : between(1925, 2025),
    PublicRemarks: pick(remarks),
    ...(land ? noShowing : showing),
    ClosePrice: null,
    CloseDate: null,
  };

  // Each has been on the market a different length of time, and some have moved on.
  const entered = between(6, 75);
  const changes: Change[] = [];
  if (i % 4 === 1) changes.push({ daysAgo: Math.max(1, entered - 5), set: { ListPrice: price - 15000 } });
  if (i % 10 === 7) {
    // Sold some months ago.
    const enteredLongAgo = between(120, 330);
    const pendingAfter = between(8, 45);
    const closedAfter = pendingAfter + between(25, 40);
    await story(agent, fields, enteredLongAgo, [
      status(enteredLongAgo - pendingAfter, "Pending"),
      closed(enteredLongAgo - closedAfter, price - between(0, 20) * 1000),
    ]);
    continue;
  }
  if (i % 5 === 2) changes.push(status(Math.max(1, entered - between(3, 5)), "Pending"));
  if (i % 13 === 5) changes.push(status(1, "Withdrawn"));
  await story(agent, fields, entered, changes);
}

// ---- A street of similar homes, so comparables have something to compare ----
const comparableStreet = (number: number, changes: Partial<ListingInput>): ListingInput => ({
  StandardStatus: "Active",
  PropertyType: "Residential",
  ListPrice: 600000,
  ListingContractDate: dateAgo(1),
  StreetNumber: String(number),
  StreetName: "Comparable Ct",
  UnitNumber: null,
  City: "Port Alder",
  CountyOrParish: "Alder County",
  ParcelNumber: `2000-${number}-01`,
  PostalCode: "98001",
  StateOrProvince: "WA",
  // All within a few hundred yards of one another.
  Latitude: Number((47.31 + ((number % 7) - 3) * 0.0006).toFixed(6)),
  Longitude: Number((-122.26 + ((number % 5) - 2) * 0.0008).toFixed(6)),
  BedroomsTotal: 3,
  BathroomsTotalInteger: 2,
  LivingArea: 1900,
  LotSizeAcres: 0.18,
  YearBuilt: 1998,
  PublicRemarks: "Synthetic demo listing. One of a street of similar homes, for trying comparables.",
  ...showing,
  ClosePrice: null,
  CloseDate: null,
  ...changes,
});

// The subject: on the market now.
await story(agents[0], comparableStreet(1, { ListPrice: 615000 }), 12);

// Recent sales nearby. [number, list price, beds, living area, entered, pending after, closed after, close price]
const sales: [number, number, number, number, number, number, number, number][] = [
  [3, 599000, 3, 1850, 150, 14, 44, 592000],
  [5, 625000, 4, 2050, 130, 9, 40, 631000],
  [7, 580000, 3, 1720, 110, 30, 62, 566000],
  [9, 640000, 4, 2100, 95, 6, 36, 640000],
  [11, 605000, 3, 1930, 70, 18, 49, 598000],
];
for (const [number, price, beds, area, entered, pendingAfter, closedAfter, closePrice] of sales)
  await story(agents[number % agents.length], comparableStreet(number, { ListPrice: price, BedroomsTotal: beds, LivingArea: area }), entered, [
    status(entered - pendingAfter, "Pending"),
    closed(entered - closedAfter, closePrice),
  ]);

// One that fell out of contract and came back before selling (the count pauses while pending).
await story(agents[2], comparableStreet(13, { ListPrice: 610000, LivingArea: 1880 }), 140, [
  status(130, "Pending"),
  status(116, "Active"),
  status(106, "Pending"),
  closed(70, 603000),
]);
// One sold too long ago to count as a recent comparable.
await story(agents[3], comparableStreet(15, { ListPrice: 570000 }), 340, [status(320, "Pending"), closed(290, 565000)]);
// One much larger home, outside the size range.
await story(agents[4], comparableStreet(17, { ListPrice: 890000, BedroomsTotal: 5, LivingArea: 3400 }), 100, [
  status(80, "Pending"),
  closed(50, 880000),
]);

// ---- Relistings, to show how the cumulative count works ----
const relist = (number: number, changes: Partial<ListingInput> = {}): ListingInput => ({
  ...comparableStreet(number, { ListPrice: 540000, LivingArea: 1600 }),
  StreetName: "Relist Rd",
  City: "Cedar Hollow",
  PostalCode: "98002",
  ParcelNumber: `3000-${number}-01`,
  Latitude: Number((47.3 + number * 0.0002).toFixed(6)),
  Longitude: Number((-122.2 + number * 0.0002).toFixed(6)),
  PublicRemarks: "Synthetic demo listing. Part of a relisting example.",
  ...changes,
});

// Canceled after 60 days and relisted 10 days later by another brokerage: the count carries on.
await story(agents[0], relist(10), 100, [status(40, "Canceled")]);
await story(agents[3], relist(10, { ListPrice: 525000 }), 30);

// Expired after 60 days and relisted 60 days later: the count starts again.
await story(agents[1], relist(20), 180, [status(120, "Expired")]);
await story(agents[1], relist(20, { ListPrice: 530000 }), 60);

// Sold, then listed again by the new owner: a sale always resets the count.
await story(agents[4], relist(30), 150, [status(130, "Pending"), closed(90, 538000)]);
await story(agents[5], relist(30, { ListPrice: 579000 }), 20);

console.log(`Seeded 3 offices, ${actors.length} members, ${listingCount} listings.`);
console.log("Sign in with any <first>.<last>@osmls.example address and DEMO_PASSWORD from .env.");
await pool.end();
