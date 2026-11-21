/*
 * Feeds and file export against the test database (issue #33): what the public
 * display feed carries and what it does not, that a consumer reads its own
 * feed and no other, and what a member's exported file holds.
 *
 */
import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as feed } from "../src/app/api/reso/[[...path]]/route";
import { GET as photoRoute } from "../src/app/api/reso-photo/[key]/route";
import { db, pool } from "../src/db";
import { dataConsumer, dataRequest, exportLog, member, type Member } from "../src/db/schema";
import { createDataConsumer, feedOf, listDataConsumers, metadataDocument, revokeDataConsumer } from "../src/lib/data-exchange";
import { AGENT_EXPORT_COLUMNS, CLIENT_EXPORT_COLUMNS, exportDisclosure, exportsBy, recordExport, searchExport, toCsv } from "../src/lib/exports";
import { addPhoto, createListing, updateListing } from "../src/lib/listings";
import { createMember } from "../src/lib/members";
import { createOffice } from "../src/lib/offices";
import { FEEDS, SERVED_RESOURCES, feedView } from "../src/lib/rules/data-exchange";
import { MAX_SEARCH_RESULTS } from "../src/lib/rules/local";
import { DEFAULT_CRITERIA } from "../src/lib/search-criteria";

const run = Date.now();
const ROOT = "http://localhost:3000/api/reso";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let admin: Member;
let agent: Member;
let serial = 0;
const smtp = process.env.SMTP_URL;

const get = (path: string, token: string, headers: Record<string, string> = {}) =>
  feed(new Request(`${ROOT}${path}`, { headers: { ...headers, Authorization: `Bearer ${token}` } }), { params: Promise.resolve({ path: path.split("?")[0].split("/").filter(Boolean) }) });
const getPhoto = (key: string, token: string) =>
  photoRoute(new Request(`http://localhost:3000/api/reso-photo/${key}`, { headers: { Authorization: `Bearer ${token}` } }), { params: Promise.resolve({ key }) });
const fields = (city: string, changes: Record<string, string> = {}) => ({
  StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
  StreetNumber: String(++serial), StreetName: "Feed St", City: city, StateOrProvince: "WA", PostalCode: "98985", BedroomsTotal: "3", BathroomsTotalInteger: "2",
  CountyOrParish: `County ${run}`, ParcelNumber: `P${run}-${serial}`, ...changes,
});
const keysOf = async (path: string, token: string) => ((await (await get(path, token)).json()).value as { ListingKey: string }[]).map((r) => r.ListingKey);

beforeAll(async () => {
  delete process.env.SMTP_URL;
  const members = await db.select().from(member);
  admin = members.find((m) => m.MemberMlsId === "ST0001")!;
  agent = members.find((m) => m.MemberMlsId === "AG1001")!;
});
afterAll(async () => {
  process.env.SMTP_URL = smtp;
  const mine = (await db.select().from(dataConsumer).where(like(dataConsumer.ConsumerName, `Feeds ${run}%`))).map((c) => c.ConsumerKey);
  for (const key of mine) await db.delete(dataRequest).where(eq(dataRequest.ConsumerKey, key));
  await db.delete(dataConsumer).where(like(dataConsumer.ConsumerName, `Feeds ${run}%`));
  await db.update(member).set({ MemberStatus: "Inactive" }).where(like(member.MemberMlsId, `FD${run}-%`));
  await pool.end();
});

describe("what a feed is", () => {
  it("is a narrowing of the allowlist, field by field, and the full feed is all of it", () => {
    for (const name of Object.keys(FEEDS) as (keyof typeof FEEDS)[]) {
      for (const resource of feedView(name).resources) {
        const allowed = SERVED_RESOURCES.find((r) => r.name === resource.name)!.fields.map((f) => f.name);
        for (const f of resource.fields) expect(allowed, `${name} ${resource.name}.${f.name}`).toContain(f.name);
      }
    }
    expect(feedView("full").resources.map((r) => [r.name, r.fields.map((f) => f.name)])).toEqual(SERVED_RESOURCES.map((r) => [r.name, r.fields.map((f) => f.name)]));
  });

  it("must be chosen when a data consumer is added", async () => {
    await expect(createDataConsumer(admin, { name: `Feeds ${run} none` })).rejects.toThrow("Choose which feed this data consumer reads.");
    await expect(createDataConsumer(admin, { name: `Feeds ${run} none`, feed: "everything" })).rejects.toThrow("Choose which feed this data consumer reads.");
    await expect(createDataConsumer(admin, { name: `Feeds ${run} none`, feed: "constructor" })).rejects.toThrow("Choose which feed this data consumer reads.");
    expect(await db.select().from(dataConsumer).where(eq(dataConsumer.ConsumerName, `Feeds ${run} none`))).toEqual([]);
    const made = await createDataConsumer(admin, { name: `Feeds ${run} chosen`, feed: "public" });
    expect(made.consumer.Feed).toBe("public");
  });
});

describe("the public display feed", () => {
  it("carries only its fields and its four statuses, to every way of asking, while the full feed is unchanged", async () => {
    const pub = (await createDataConsumer(admin, { name: `Feeds ${run} public`, feed: "public" })).token;
    const full = (await createDataConsumer(admin, { name: `Feeds ${run} full`, feed: "full" })).token;
    const city = `Shown${run}`;
    const hiddenCity = `Hidden${run}`;
    const shown = await createListing(agent, fields(city));
    const comingSoon = await createListing(agent, fields(hiddenCity, { StandardStatus: "Coming Soon" }));
    const photo = await addPhoto(agent, shown.ListingKey, png);
    const hiddenPhoto = await addPhoto(agent, comingSoon.ListingKey, png);
    // An agent whose only listing is one the feed does not carry.
    const unseen = (await createMember(admin, { firstName: "Unseen", lastName: `Agent${run}`, email: `unseen-${run}@osmls.example`, memberId: `FD${run}-1`, role: "agent", officeKey: agent.OfficeKey!, phone: "" })).member;
    await createListing(unseen, fields(hiddenCity, { StandardStatus: "Coming Soon" }));

    // ---- Its metadata describes its fields and no others ----
    const expected = {
      Property: ["ListingKey", "ListingId", "StandardStatus", "PropertyType", "ListPrice", "ClosePrice", "CloseDate", "UnparsedAddress", "City", "StateOrProvince", "PostalCode", "BedroomsTotal", "BathroomsTotalInteger", "LivingArea", "LotSizeAcres", "YearBuilt", "PublicRemarks", "ListAgentKey", "ListOfficeKey", "ModificationTimestamp"],
      Member: ["MemberKey", "MemberFullName", "OfficeKey", "ModificationTimestamp"],
      Office: ["OfficeKey", "OfficeName", "ModificationTimestamp"],
    };
    const metadata = await (await get("/$metadata", pub)).text();
    expect(metadata).toBe(metadataDocument(feedView("public")));
    for (const [resource, names] of Object.entries(expected)) {
      const type = new RegExp(`<EntityType Name="${resource}">([\\s\\S]*?)</EntityType>`).exec(metadata)![1];
      expect([...type.matchAll(/<Property Name="([^"]+)"/g)].map((m) => m[1]).sort(), resource).toEqual([...names].sort());
    }
    for (const absent of ["ParcelNumber", "CountyOrParish", "Latitude", "OriginalListPrice", "DaysOnMarket", "StreetName", "MemberMlsId", "MemberStatus", "OfficePhone", "OfficeMlsId", "ShowingInstructions"]) {
      expect(metadata.includes(`"${absent}"`), absent).toBe(false);
    }
    expect((await (await get("/$metadata", full)).text()).includes('"ParcelNumber"')).toBe(true);

    // ---- A record has exactly its fields; a listing in another status is not there, by filter or by key ----
    const record = await (await get(`/Property('${shown.ListingKey}')`, pub)).json();
    expect(Object.keys(record).filter((k) => !k.startsWith("@")).sort()).toEqual([...expected.Property].sort());
    expect(await keysOf(`/Property?$filter=City eq '${city}' or City eq '${hiddenCity}'`, pub)).toEqual([shown.ListingKey]);
    expect((await get(`/Property('${comingSoon.ListingKey}')`, pub)).status).toBe(404);
    expect((await keysOf(`/Property?$filter=City eq '${hiddenCity}'`, full)).length).toBe(2);
    const statuses = new Set(((await (await get("/Property?$select=StandardStatus&$top=200", pub, { Prefer: "odata.maxpagesize=200" })).json()).value as { StandardStatus: string }[]).map((r) => r.StandardStatus));
    for (const status of statuses) expect(["Active", "Active Under Contract", "Pending", "Closed"]).toContain(status);

    // ---- A field outside the feed does not exist for this consumer ----
    for (const path of [
      "/Property?$select=ParcelNumber", "/Property?$filter=Latitude gt 0", "/Property?$orderby=DaysOnMarket", "/Property?$filter=StreetName eq 'Feed St'",
      "/Member?$select=MemberMlsId", "/Member?$filter=MemberStatus eq 'Active'", "/Office?$orderby=OfficePhone",
    ]) {
      expect((await get(path, pub)).status, path).toBe(400);
      expect((await get(path, full)).status, path).toBe(200);
    }

    // ---- Photos, members, offices, Field and Lookup all follow the feed ----
    expect((await getPhoto(photo.MediaKey, pub)).status).toBe(200);
    expect((await getPhoto(hiddenPhoto.MediaKey, pub)).status).toBe(404);
    expect((await getPhoto(hiddenPhoto.MediaKey, full)).status).toBe(200);
    expect((await get(`/Media('${hiddenPhoto.MediaKey}')`, pub)).status).toBe(404);
    const expanded = await (await get(`/Property('${shown.ListingKey}')?$expand=Media`, pub)).json();
    expect(expanded.Media.map((m: { MediaKey: string }) => m.MediaKey)).toEqual([photo.MediaKey]);
    expect((await get(`/Member('${unseen.MemberKey}')`, pub)).status).toBe(404);
    expect((await get(`/Member('${unseen.MemberKey}')`, full)).status).toBe(200);
    expect(Object.keys(await (await get(`/Member('${agent.MemberKey}')`, pub)).json()).filter((k) => !k.startsWith("@")).sort()).toEqual([...expected.Member].sort());
    const fieldKeys = ((await (await get("/Field?$top=200", pub)).json()).value as { FieldKey: string }[]).map((f) => f.FieldKey);
    expect(fieldKeys).toContain("Property.ListPrice");
    for (const absent of ["Property.ParcelNumber", "Property.DaysOnMarket", "Member.MemberMlsId", "Office.OfficePhone"]) expect(fieldKeys).not.toContain(absent);
    const lookups = (await (await get("/Lookup?$top=200", pub, { Prefer: "odata.maxpagesize=200" })).json()).value as { LookupName: string; LookupValue: string }[];
    const of = (name: string) => lookups.filter((l) => l.LookupName === name).map((l) => l.LookupValue);
    expect(of("StandardStatus").sort()).toEqual(["Active", "Active Under Contract", "Closed", "Pending"]);
    expect(of("CountyOrParish")).toEqual([]);
    expect(of("MemberStatus")).toEqual([]);
    expect(of("City")).toContain(city);
    // A city only a listing outside the feed is in is not listed.
    expect(of("City")).not.toContain(hiddenCity);

    // ---- Leaving the feed: the listing is cancelled ----
    await updateListing(agent, shown.ListingKey, { ...fields(city), StreetNumber: shown.StreetNumber, ParcelNumber: shown.ParcelNumber!, StandardStatus: "Canceled" });
    expect(await keysOf(`/Property?$filter=City eq '${city}'`, pub)).toEqual([]);
    expect((await get(`/Property('${shown.ListingKey}')`, pub)).status).toBe(404);
    expect((await getPhoto(photo.MediaKey, pub)).status).toBe(404);
    expect(await keysOf(`/Property?$filter=City eq '${city}'`, full)).toEqual([shown.ListingKey]);
    expect((await getPhoto(photo.MediaKey, full)).status).toBe(200);
  });

  it("gives a sale price and date only for a sale, and answers queries as if the others had none", async () => {
    const pub = (await createDataConsumer(admin, { name: `Feeds ${run} sale`, feed: "public" })).token;
    const full = (await createDataConsumer(admin, { name: `Feeds ${run} sale full`, feed: "full" })).token;
    const city = `Sale${run}`;
    const pending = await createListing(agent, fields(city));
    const sold = await createListing(agent, fields(city));
    const base = (l: typeof sold) => ({ ...fields(city), StreetNumber: l.StreetNumber, ParcelNumber: l.ParcelNumber! });
    await updateListing(agent, pending.ListingKey, { ...base(pending), StandardStatus: "Pending" });
    await updateListing(agent, sold.ListingKey, { ...base(sold), StandardStatus: "Pending" });
    await updateListing(agent, sold.ListingKey, { ...base(sold), StandardStatus: "Closed", ClosePrice: "480000", CloseDate: "2026-03-01" });
    // A pending listing that already holds the agreed figures, as a record can.
    await db.execute(sql`update "Property" set "ClosePrice" = 470000, "CloseDate" = '2026-04-01' where "ListingKey" = ${pending.ListingKey}`);
    const inCity = (rest: string) => `/Property?$select=ListingKey,ClosePrice,CloseDate&$filter=City eq '${city}'${rest}`;

    const both = (await (await get(inCity("&$orderby=ListingKey"), pub)).json()).value as { ListingKey: string; ClosePrice: number | null; CloseDate: string | null }[];
    expect(both.find((r) => r.ListingKey === sold.ListingKey)).toMatchObject({ ClosePrice: 480000, CloseDate: "2026-03-01" });
    expect(both.find((r) => r.ListingKey === pending.ListingKey)).toMatchObject({ ClosePrice: null, CloseDate: null });
    // The withheld figures cannot be found by asking about them.
    expect(await keysOf(inCity(" and ClosePrice gt 1"), pub)).toEqual([sold.ListingKey]);
    expect(await keysOf(inCity(" and ClosePrice eq 470000"), pub)).toEqual([]);
    expect(await keysOf(inCity(" and CloseDate ge 2026-03-15"), pub)).toEqual([]);
    expect(await keysOf(inCity(" and ClosePrice eq null"), pub)).toEqual([pending.ListingKey]);
    // Sorted, the pending listing sits with the empty values whichever way, never where 470000 would put it.
    expect(await keysOf(inCity("&$orderby=ClosePrice desc"), pub)).toEqual([sold.ListingKey, pending.ListingKey]);
    expect(await keysOf(inCity("&$orderby=ClosePrice asc"), pub)).toEqual([pending.ListingKey, sold.ListingKey]);
    // The full feed carries what is stored.
    expect(await keysOf(inCity(" and ClosePrice eq 470000"), full)).toEqual([pending.ListingKey]);
  });
});

describe("entering and leaving the public display feed", () => {
  it("brings in a listing, its photos, its agent and its office when it reaches a displayed status, and lists its city", async () => {
    const pub = (await createDataConsumer(admin, { name: `Feeds ${run} entering`, feed: "public" })).token;
    const city = `Entering${run}`;
    // A new office with one agent, whose only listing is not yet on the market.
    const office = await createOffice(admin, { name: `Feeds Office ${run}`, officeId: `FO${run}`, phone: "", mainOfficeKey: "" });
    const newcomer = (await createMember(admin, { firstName: "Entering", lastName: `Agent${run}`, email: `entering-${run}@osmls.example`, memberId: `FD${run}-2`, role: "agent", officeKey: office.OfficeKey, phone: "" })).member;
    const listing = await createListing(newcomer, fields(city, { StandardStatus: "Coming Soon" }));
    const photo = await addPhoto(newcomer, listing.ListingKey, png);
    const cities = async () => ((await (await get("/Lookup?$filter=LookupName eq 'City'&$top=200", pub, { Prefer: "odata.maxpagesize=200" })).json()).value as { LookupValue: string }[]).map((l) => l.LookupValue);
    const present = async () => ({
      listing: (await get(`/Property('${listing.ListingKey}')`, pub)).status,
      photo: (await getPhoto(photo.MediaKey, pub)).status,
      media: (await get(`/Media('${photo.MediaKey}')`, pub)).status,
      member: (await get(`/Member('${newcomer.MemberKey}')`, pub)).status,
      office: (await get(`/Office('${office.OfficeKey}')`, pub)).status,
      city: (await cities()).includes(city),
    });
    const absent = { listing: 404, photo: 404, media: 404, member: 404, office: 404, city: false };
    const there = { listing: 200, photo: 200, media: 200, member: 200, office: 200, city: true };
    const same = { StreetNumber: listing.StreetNumber, ParcelNumber: listing.ParcelNumber! };
    expect(await present()).toEqual(absent);

    const before = new Date().toISOString();
    await updateListing(newcomer, listing.ListingKey, { ...fields(city), ...same, StandardStatus: "Active" });
    expect(await present()).toEqual(there);
    // Entering the feed is a change to the listing, so a poll reports it.
    expect(await keysOf(`/Property?$filter=ModificationTimestamp ge ${before} and City eq '${city}'`, pub)).toEqual([listing.ListingKey]);

    // Leaving it is not something a poll can report: the record is simply no longer served.
    const left = new Date().toISOString();
    await updateListing(newcomer, listing.ListingKey, { ...fields(city), ...same, StandardStatus: "Withdrawn" });
    expect(await present()).toEqual(absent);
    expect(await keysOf(`/Property?$filter=ModificationTimestamp ge ${left}&$top=200`, pub)).not.toContain(listing.ListingKey);

    // A staff correction back to Active brings it all back.
    await updateListing(admin, listing.ListingKey, { ...fields(city), ...same, StandardStatus: "Active" }, "Withdrawn by mistake");
    expect(await present()).toEqual(there);
  });

  it("accepts the page link it gives for every field it carries, the masked ones included", async () => {
    const pub = (await createDataConsumer(admin, { name: `Feeds ${run} links`, feed: "public" })).token;
    for (const resource of feedView("public").resources) {
      for (const f of resource.fields.filter((field) => !field.derived || field.queryable)) {
        for (const direction of ["asc", "desc"]) {
          const first = await (await get(`/${resource.name}?$select=${resource.key}&$orderby=${f.name} ${direction}`, pub, { Prefer: "odata.maxpagesize=1" })).json();
          if (!first["@odata.nextLink"]) continue;
          const next = await get(first["@odata.nextLink"].replace(ROOT, ""), pub, { Prefer: "odata.maxpagesize=1" });
          expect(next.status, `${resource.name} by ${f.name} ${direction}`).toBe(200);
          expect((await next.json()).value[0][resource.key], `${resource.name} by ${f.name} ${direction}`).not.toBe(first.value[0][resource.key]);
        }
      }
    }
    // Paging to the end sorted on the masked sale price gives every record once.
    const seen: string[] = [];
    for (let path: string | undefined = "/Property?$select=ListingKey,ClosePrice&$orderby=ClosePrice desc&$count=true"; path; ) {
      const body = await (await get(path.replace(ROOT, ""), pub, { Prefer: "odata.maxpagesize=25" })).json();
      seen.push(...body.value.map((r: { ListingKey: string }) => r.ListingKey));
      path = body["@odata.nextLink"];
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe((await (await get("/Property?$top=0&$count=true", pub)).json())["@odata.count"]);
  });
});

describe("which feed a consumer reads", () => {
  it("is fixed when the consumer is added, shown to staff, written to each request's record, and ended only by revoking", async () => {
    const made = await createDataConsumer(admin, { name: `Feeds ${run} fixed`, feed: "public" });
    const listed = (await listDataConsumers(admin))!.find((c) => c.consumerKey === made.consumer.ConsumerKey)!;
    expect(listed).toMatchObject({ feed: "public", state: "Active" });
    await get("/Office?$top=1", made.token);
    const other = await createDataConsumer(admin, { name: `Feeds ${run} fixed full`, feed: "full" });
    await get("/Office?$top=1", other.token);
    const logged = async (key: string) => (await db.select().from(dataRequest).where(eq(dataRequest.ConsumerKey, key))).map((r) => r.Feed);
    expect(await logged(made.consumer.ConsumerKey)).toEqual(["public"]);
    expect(await logged(other.consumer.ConsumerKey)).toEqual(["full"]);
    // Nothing in the application changes a consumer's feed: the only things staff can do to one are add it and revoke it.
    const operations = Object.keys(await import("../src/lib/data-exchange")).filter((name) => /consumer/i.test(name)).sort();
    expect(operations).toEqual(["consumerFor", "createDataConsumer", "listDataConsumers", "revokeDataConsumer"]);
    await revokeDataConsumer(admin, made.consumer.ConsumerKey);
    expect((await get("/Office?$top=1", made.token)).status).toBe(401);
    expect((await db.select().from(dataConsumer).where(eq(dataConsumer.ConsumerKey, made.consumer.ConsumerKey)))[0].Feed).toBe("public");
  });

  it("answers a consumer whose record names no known feed with nothing, never with a wider feed", async () => {
    const made = await createDataConsumer(admin, { name: `Feeds ${run} unknown`, feed: "public" });
    // The database refuses a feed that is not one of the two.
    await expect(db.execute(sql`update "OsmlsDataConsumer" set "Feed" = 'everything' where "ConsumerKey" = ${made.consumer.ConsumerKey}::uuid`)).rejects.toThrow();
    expect(() => feedOf({ Feed: "everything" })).toThrow(/unknown feed/);
    expect(() => feedOf({ Feed: "constructor" })).toThrow(/unknown feed/);
  });
});

describe("exporting search results to a file", () => {
  const criteria = (city: string) => ({ ...DEFAULT_CRITERIA, city, statuses: [] });

  it("holds exactly the columns of its kind, and leaves other statuses out of a client export, saying so", async () => {
    const city = `Export${run}`;
    const active = await createListing(agent, fields(city, { PublicRemarks: "=HYPERLINK(\"http://example.invalid\")", ShowingInstructions: `secret-showing-${run}`, LockBoxLocation: `secret-lockbox-${run}` }));
    await createListing(agent, fields(city, { StandardStatus: "Coming Soon", PublicRemarks: "Remarks, with a comma\nand a line break and a \"quote\"" }));

    const agentFile = (await searchExport(agent, criteria(city), "agent"))!;
    const clientFile = (await searchExport(agent, criteria(city), "client"))!;
    expect(agentFile.columns).toEqual([...AGENT_EXPORT_COLUMNS]);
    expect(clientFile.columns).toEqual([...CLIENT_EXPORT_COLUMNS]);
    expect([...AGENT_EXPORT_COLUMNS]).toEqual([...CLIENT_EXPORT_COLUMNS, "OriginalListPrice", "CountyOrParish", "ParcelNumber", "DaysOnMarket", "CumulativeDaysOnMarket"]);
    expect(agentFile).toMatchObject({ listings: 2, omittedForStatus: 0, searchCutOff: false });
    expect(clientFile).toMatchObject({ listings: 1, omittedForStatus: 1, searchCutOff: false });
    expect(clientFile.fileName).toMatch(/^osmls-client-export-1-listing-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(agentFile.fileName).toMatch(/^osmls-agent-export-2-listings-/);
    for (const file of [agentFile, clientFile]) for (const row of file.rows) expect(row).toHaveLength(file.columns.length);
    expect(clientFile.rows[0][0]).toBe(active.ListingId);
    expect(exportDisclosure(clientFile, MAX_SEARCH_RESULTS)).toEqual([
      "The file holds 1 listing.",
      "1 of the listings the search read was left out because a client export holds only Active, Active Under Contract, Pending and Closed listings.",
    ]);

    const agentCsv = toCsv(agentFile);
    const clientCsv = toCsv(clientFile);
    expect(agentCsv.split("\r\n")[0]).toBe(`﻿${AGENT_EXPORT_COLUMNS.join(",")}`);
    expect(clientCsv.split("\r\n")[0]).toBe(`﻿${CLIENT_EXPORT_COLUMNS.join(",")}`);
    // A cell a spreadsheet would run is made inert; commas, quotes and line breaks are quoted.
    expect(clientCsv).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect(agentCsv).toContain(`"Remarks, with a comma\nand a line break and a ""quote"""`);
    // Never in a file of either kind.
    for (const csv of [agentCsv, clientCsv]) {
      for (const secret of [`secret-showing-${run}`, `secret-lockbox-${run}`, active.ListingKey, agent.MemberKey, "/media/"]) expect(csv.includes(secret), secret).toBe(false);
    }
    // The agent file has the parcel; the client file does not.
    expect(agentCsv.includes(active.ParcelNumber!)).toBe(true);
    expect(clientCsv.includes(active.ParcelNumber!)).toBe(false);
  });

  it("says when the search was cut off, and does not claim a total it did not count", async () => {
    const city = `Many${run}`;
    for (let n = 0; n < MAX_SEARCH_RESULTS + 1; n++) await createListing(agent, fields(city, n === 0 ? { StandardStatus: "Coming Soon" } : {}));
    const file = (await searchExport(agent, { ...criteria(city), sort: "price_low" }, "client"))!;
    expect(file.searchCutOff).toBe(true);
    expect(file.listings + file.omittedForStatus).toBe(MAX_SEARCH_RESULTS);
    const lines = exportDisclosure(file, MAX_SEARCH_RESULTS);
    expect(lines.at(-1)).toBe(
      `The search found more than ${MAX_SEARCH_RESULTS} listings and read only the first ${MAX_SEARCH_RESULTS} in its order. The rest were not considered, and how many there are is not known. Some of them may be listings a client export would hold.`,
    );
    expect(lines.join(" ")).not.toMatch(/of \d+ (matching|found)/);
  });

  it("is for active members, and each one taken is on record", async () => {
    const city = `Logged${run}`;
    await createListing(agent, fields(city));
    for (const viewer of [null, { ...agent, MemberStatus: "Inactive" }]) expect(await searchExport(viewer, criteria(city), "agent")).toBeNull();
    const file = (await searchExport(agent, criteria(city), "client"))!;
    const before = (await exportsBy(agent)).length;
    await recordExport(agent, criteria(city), file);
    const [latest, ...rest] = await exportsBy(agent);
    expect(rest).toHaveLength(before);
    expect(latest).toMatchObject({ MemberKey: agent.MemberKey, Kind: "client", ListingCount: 1, OmittedForStatus: 0, SearchCutOff: false });
    expect((latest.Criteria as { city: string }).city).toBe(city);
    expect(Date.now() - latest.ExportTimestamp.getTime()).toBeLessThan(60_000);
    await db.delete(exportLog).where(eq(exportLog.ExportKey, latest.ExportKey));
  });
});
