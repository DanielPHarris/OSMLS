/*
 * The data exchange feed against the test database, through its route
 * handlers: what a bearer token can read, that it is only what the export
 * allowlist names, the photo route, and what revoking the token ends.
 *
 * Issue #31.
 */
import { eq, like, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as feed } from "../src/app/api/reso/[[...path]]/route";
import { GET as photoRoute } from "../src/app/api/reso-photo/[key]/route";
import { db, pool } from "../src/db";
import { dataConsumer, dataRequest, member, property, type Member } from "../src/db/schema";
import { createDataConsumer, listDataConsumers, metadataDocument, revokeDataConsumer } from "../src/lib/data-exchange";
import { addDocument } from "../src/lib/documents";
import { addPhoto, createListing, removePhoto, updateListing } from "../src/lib/listings";
import { getMarketTime } from "../src/lib/market-time";
import { createMember, updateMember } from "../src/lib/members";
import { MAX_REQUESTS_PER_MINUTE, SERVED_RESOURCES, servedResource } from "../src/lib/rules/data-exchange";

const run = Date.now();
const ROOT = "http://localhost:3000/api/reso";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
// Names of things that must never be in the feed, whatever else changes.
const NEVER = [
  "ShowingInstructions", "ShowingRequirements", "ShowingContactName", "ShowingContactPhone", "ShowingContactType", "LockBoxType", "LockBoxLocation",
  "OsmlsLocalFields", "MemberEmail", "MemberDirectPhone", "OsmlsRole", "OsmlsCapabilities", "OsmlsUserId", "OsmlsStoragePath", "OsmlsFileHash", "OsmlsFileSize", "Permission",
];
let admin: Member;
let agent: Member;

const get = (path: string, token: string | null, headers: Record<string, string> = {}) =>
  feed(new Request(`${ROOT}${path}`, { headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }), {
    params: Promise.resolve({ path: path.split("?")[0].split("/").filter(Boolean) }),
  });
const getPhoto = (key: string, token: string | null) =>
  photoRoute(new Request(`http://localhost:3000/api/reso-photo/${key}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), { params: Promise.resolve({ key }) });

beforeAll(async () => {
  const members = await db.select().from(member);
  admin = members.find((m) => m.MemberMlsId === "ST0001")!;
  agent = members.find((m) => m.MemberMlsId === "AG1001")!;
});
afterAll(async () => {
  const mine = (await db.select().from(dataConsumer).where(like(dataConsumer.ConsumerName, `Proof ${run}%`))).map((c) => c.ConsumerKey);
  for (const key of mine) await db.delete(dataRequest).where(eq(dataRequest.ConsumerKey, key));
  await db.delete(dataConsumer).where(like(dataConsumer.ConsumerName, `Proof ${run}%`));
  await pool.end();
});

describe("what a bearer token can read", () => {
  it("describes exactly the allowlist in its metadata", () => {
    const metadata = metadataDocument();
    for (const resource of SERVED_RESOURCES) {
      const type = new RegExp(`<EntityType Name="${resource.name}">([\\s\\S]*?)</EntityType>`).exec(metadata)![1];
      const described = [...type.matchAll(/<Property Name="([^"]+)"/g)].map((m) => m[1]);
      expect(described, resource.name).toEqual(resource.fields.map((f) => f.name));
    }
    for (const name of NEVER) expect(metadata.includes(name), name).toBe(false);
    expect(SERVED_RESOURCES.map((r) => r.name)).toEqual(["Property", "Member", "Office", "Media", "Field", "Lookup"]);
  });

  it("serves a token an authenticated query and a photo, only from the allowlist, until the token is revoked", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const listing = await createListing(agent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "512345.5", ListingContractDate: "2026-01-01",
      StreetNumber: "1", StreetName: `Feed Rd ${run}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98993",
      BedroomsTotal: "3", BathroomsTotalInteger: "2", ShowingInstructions: `secret-showing-${run}`, LockBoxLocation: `secret-lockbox-${run}`,
    });
    const photo = await addPhoto(agent, listing.ListingKey, png);
    const document = await addDocument(agent, listing.ListingKey, { bytes: pdf, name: `secret-document-${run}`, permission: "Private" });

    // ---- Staff make a data consumer, and are given its token once ----
    const { consumer, token } = await createDataConsumer(admin, { name: `Proof ${run}` });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [atRest] = await db.select().from(dataConsumer).where(eq(dataConsumer.ConsumerKey, consumer.ConsumerKey));
    expect(JSON.stringify(atRest).includes(token)).toBe(false);
    expect(JSON.stringify(await listDataConsumers(admin)).includes(token)).toBe(false);
    expect(JSON.stringify(await listDataConsumers(admin)).includes(atRest.OsmlsTokenHash)).toBe(false);

    // ---- No token, a wrong token, and a member's session cookie open nothing ----
    for (const bad of [null, "x".repeat(43)]) {
      const refused = await get("/Property", bad);
      expect(refused.status).toBe(401);
      expect(await refused.text()).not.toContain(listing.ListingKey);
    }

    // ---- An authenticated query: filtered on ModificationTimestamp, with a $select ----
    const query = `/Property?$filter=ModificationTimestamp gt ${since} and StreetName eq 'Feed Rd ${run}'&$select=ListingKey,ListPrice,StandardStatus,ModificationTimestamp&$count=true`;
    const response = await get(query, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("OData-Version")).toBe("4.0");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json();
    expect(body["@odata.context"]).toBe(`${ROOT}/$metadata#Property(ListingKey,ListPrice,StandardStatus,ModificationTimestamp)`);
    expect(body["@odata.count"]).toBe(1);
    expect(body.value).toEqual([
      { ListingKey: listing.ListingKey, ListPrice: 512345.5, StandardStatus: "Active", ModificationTimestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) },
    ]);

    // ---- Without a $select, a record has exactly the allowlisted fields ----
    const whole = await (await get(`/Property('${listing.ListingKey}')`, token)).json();
    expect(Object.keys(whole).filter((k) => !k.startsWith("@"))).toEqual(servedResource("Property")!.fields.map((f) => f.name));
    expect(whole).toMatchObject({ ListingId: listing.ListingId, DaysOnMarket: 0, CumulativeDaysOnMarket: 0, ListAgentKey: agent.MemberKey });
    const everything = JSON.stringify(whole) + JSON.stringify(await (await get(`/Property?$filter=StreetName eq 'Feed Rd ${run}'`, token)).json());
    for (const secret of [`secret-showing-${run}`, `secret-lockbox-${run}`, `secret-document-${run}`, ...NEVER]) expect(everything.includes(secret), secret).toBe(false);

    // ---- Asking for what is not served is an error, not a silent omission ----
    for (const path of [
      "/Property?$select=ListingKey,ShowingInstructions",
      "/Property?$filter=ShowingInstructions ne null",
      "/Property?$orderby=LockBoxLocation",
      "/Member?$select=MemberEmail",
      "/Property?$expand=Documents",
    ]) {
      const refused = await get(path, token);
      expect(refused.status, path).toBe(400);
      expect((await refused.json()).error.code, path).toBe("BadRequest");
    }
    for (const path of ["/HistoryTransactional", "/OsmlsFlag", "/user", "/SavedSearch"]) expect((await get(path, token)).status, path).toBe(404);

    // ---- The photo: listed with a link, and the link serves it to the token ----
    const photos = await (await get(`/Media?$filter=ResourceRecordKey eq '${listing.ListingKey}'`, token)).json();
    expect(photos.value).toHaveLength(1);
    expect(photos.value[0]).toMatchObject({ MediaKey: photo.MediaKey, MediaCategory: "Photo", MediaURL: `http://localhost:3000/api/reso-photo/${photo.MediaKey}` });
    expect(JSON.stringify(photos).includes(document.MediaKey)).toBe(false);
    const served = await getPhoto(photo.MediaKey, token);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
    // A document's key, an unknown key, and no token.
    expect((await getPhoto(document.MediaKey, token)).status).toBe(404);
    expect((await get(`/Media('${document.MediaKey}')`, token)).status).toBe(404);
    expect((await getPhoto("00000000-0000-4000-8000-000000000000", token)).status).toBe(404);
    expect((await getPhoto(photo.MediaKey, null)).status).toBe(401);

    // ---- What was read is on record ----
    const log = await db.select().from(dataRequest).where(eq(dataRequest.ConsumerKey, consumer.ConsumerKey));
    expect(log.find((r) => r.Query.includes("ModificationTimestamp%20gt") || r.Query.includes("ModificationTimestamp gt"))).toMatchObject({ ResourceName: "Property", Status: 200, RecordCount: 1 });
    expect(log.filter((r) => r.Status === 400).length).toBe(5);
    expect(log.filter((r) => r.ResourceName === "photo" && r.Status === 200)).toHaveLength(1);

    // ---- Revoked: the query and the photo are both refused ----
    await revokeDataConsumer(admin, consumer.ConsumerKey);
    expect((await get(query, token)).status).toBe(401);
    expect((await get("/$metadata", token)).status).toBe(401);
    expect((await getPhoto(photo.MediaKey, token)).status).toBe(401);
  });

  it("gives every record once when records change between one page and the next", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} paging` });
    const city = `Paging${run}`;
    const fields = (price: number) => ({
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: String(price), ListingContractDate: "2026-01-01",
      StreetNumber: String(price), StreetName: "Paging Rd", City: city, StateOrProvince: "WA", PostalCode: "98992", BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    // The consumer asks for pages of two, so the server cuts each page short and links to the next.
    const page = async (path: string) => (await get(path.replace(ROOT, ""), token, { Prefer: "odata.maxpagesize=2" })).json();
    const prices = (body: { value: { ListPrice: number }[] }) => body.value.map((r) => r.ListPrice);
    const query = `/Property?$filter=City eq '${city}'&$select=ListingKey,ListPrice&$orderby=ListPrice desc`;

    // A record that sorts ahead of the page already read must not push one back into the next page.
    for (const price of [300000, 200000, 100000]) await createListing(agent, fields(price));
    const first = await page(query);
    expect(prices(first)).toEqual([300000, 200000]);
    await createListing(agent, fields(400000));
    const second = await page(first["@odata.nextLink"]);
    expect(prices(second)).toEqual([100000]);
    expect(second["@odata.nextLink"]).toBeUndefined();

    // A record that moves behind the reader must not make the reader miss the one after it.
    const again = await page(query);
    expect(prices(again)).toEqual([400000, 300000]);
    const moved = again.value[0];
    const [row] = await db.select().from(property).where(eq(property.ListingKey, moved.ListingKey));
    await updateListing(agent, row.ListingKey, { ...fields(400000), ListPrice: "50000" });
    const rest = [];
    for (let next = again["@odata.nextLink"]; next; ) {
      const body = await page(next);
      rest.push(...prices(body));
      next = body["@odata.nextLink"];
    }
    // 200000 and 100000 are both still to come; the moved record, now last, is read again with its new price.
    expect(rest).toEqual([200000, 100000, 50000]);

    // A link that has been tampered with is refused, not guessed at.
    expect((await get(`${query}&$skiptoken=not-a-token`, token)).status).toBe(400);
  });

  it("gives no link to a next page when the page asked for was given in full", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} top` });
    // $top is the most the consumer wants, not a page size: one record asked for and given is the whole answer.
    for (const resource of ["Property", "Member", "Office"]) {
      const body = await (await get(`/${resource}?$top=1`, token)).json();
      expect(body.value, resource).toHaveLength(1);
      expect(body["@odata.nextLink"], resource).toBeUndefined();
    }
    // The server cuts a page short only at its own limit, and then says where to go on, counting down what is still wanted.
    const cut = await (await get("/Property?$select=ListingKey&$top=5", token, { Prefer: "odata.maxpagesize=2" })).json();
    expect(cut.value).toHaveLength(2);
    expect(cut["@odata.nextLink"]).toContain("$top=3");
    const all = await (await get("/Property?$select=ListingKey", token, { Prefer: "odata.maxpagesize=3" })).json();
    expect(all.value).toHaveLength(3);
    expect(all["@odata.nextLink"]).toBeDefined();
    expect(all["@odata.nextLink"]).not.toContain("$top=");
  });

  it("finds a record by the timestamp it was served with", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} time` });
    // Stored to the microsecond, as the database's own clock writes it; served to the millisecond.
    const [stored] = await db.select().from(member).where(eq(member.MemberKey, agent.MemberKey));
    await db.execute(sql`update "Member" set "ModificationTimestamp" = '2026-05-05 05:05:05.123456+00' where "MemberKey" = ${agent.MemberKey}`);
    try {
      const served = "2026-05-05T05:05:05.123Z";
      const keys = async (filter: string) =>
        (await (await get(`/Member?$select=MemberKey,ModificationTimestamp&$filter=${filter}`, token)).json()).value.map((r: { MemberKey: string }) => r.MemberKey);
      expect((await (await get(`/Member('${agent.MemberKey}')`, token)).json()).ModificationTimestamp).toBe(served);
      expect(await keys(`ModificationTimestamp eq ${served}`)).toEqual([agent.MemberKey]);
      expect(await keys(`ModificationTimestamp le ${served} and ModificationTimestamp ge ${served}`)).toEqual([agent.MemberKey]);
      expect(await keys(`ModificationTimestamp gt ${served}`)).not.toContain(agent.MemberKey);
      expect(await keys(`ModificationTimestamp lt ${served}`)).not.toContain(agent.MemberKey);
      expect(await keys(`ModificationTimestamp ne ${served}`)).not.toContain(agent.MemberKey);
      // What is stored is not rewritten.
      const [{ at }] = (await db.execute(sql`select "ModificationTimestamp"::text as at from "Member" where "MemberKey" = ${agent.MemberKey}`)).rows as { at: string }[];
      expect(at).toContain("05:05:05.123456");
    } finally {
      await db.update(member).set({ ModificationTimestamp: stored.ModificationTimestamp }).where(eq(member.MemberKey, agent.MemberKey));
    }
  });

  it("declares living area as a decimal, as the Data Dictionary defines it", () => {
    expect(metadataDocument()).toMatch(/<Property Name="LivingArea" Type="Edm\.Decimal"/);
  });

  it("is managed only by staff who hold Manage data access", async () => {
    for (const viewer of [agent, { ...admin, OsmlsCapabilities: admin.OsmlsCapabilities.filter((c) => c !== "data") }, null]) {
      await expect(createDataConsumer(viewer, { name: `Proof ${run} refused` })).rejects.toThrow("Not found.");
      expect(await listDataConsumers(viewer)).toBeNull();
    }
    expect(await db.select().from(dataConsumer).where(eq(dataConsumer.ConsumerName, `Proof ${run} refused`))).toEqual([]);
  });
});

describe("what describes the feed", () => {
  it("lists every served field in the Field resource, and nothing else", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} field` });
    const data = SERVED_RESOURCES.filter((r) => !r.described);
    const all = await (await get("/Field?$count=true&$top=200", token)).json();
    expect(all["@odata.count"]).toBe(data.reduce((n, r) => n + r.fields.length, 0));
    expect(all.value.map((f: { FieldKey: string }) => f.FieldKey).sort()).toEqual(data.flatMap((r) => r.fields.map((f) => `${r.name}.${f.name}`)).sort());
    for (const name of NEVER) expect(JSON.stringify(all).includes(`"${name}"`), name).toBe(false);
    // It is queried like any other resource.
    const some = await (await get("/Field?$filter=ResourceName eq 'Office' and FieldName ne 'OfficeKey'&$select=FieldName,DisplayName&$orderby=FieldName desc", token)).json();
    expect(some.value.map((f: { FieldName: string }) => f.FieldName)).toEqual(servedResource("Office")!.fields.map((f) => f.name).filter((n) => n !== "OfficeKey").sort().reverse());
    expect(some.value.find((f: { FieldName: string }) => f.FieldName === "OfficeMlsId").DisplayName).toBe("Office Mls Id");
    expect((await (await get("/Field('Property.ListPrice')", token)).json()).FieldName).toBe("ListPrice");
  });

  it("says in the metadata which lookup each such field holds, and lists those values in the Lookup resource", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} lookup` });
    const city = `Lookup City ${run}`;
    const listing = await createListing(agent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: "1", StreetName: "Lookup Rd", City: city, StateOrProvince: "WA", PostalCode: "98991", BedroomsTotal: "3", BathroomsTotalInteger: "2",
      CountyOrParish: `Lookup County ${run}`,
    });
    await addPhoto(agent, listing.ListingKey, png);
    await addDocument(agent, listing.ListingKey, { bytes: pdf, name: "Plans", permission: "Private" });

    const metadata = metadataDocument();
    for (const resource of SERVED_RESOURCES) {
      for (const f of resource.fields) {
        const declared = new RegExp(`<Property Name="${f.name}" Type="Edm\\.String"[^>]*>\\s*<Annotation Term="RESO\\.OData\\.Metadata\\.LookupName" String="${f.lookup}"/>`).test(
          new RegExp(`<EntityType Name="${resource.name}">([\\s\\S]*?)</EntityType>`).exec(metadata)![1],
        );
        expect(declared, `${resource.name}.${f.name}`).toBe(f.lookup !== undefined);
      }
    }

    const values = async (name: string) =>
      (await (await get(`/Lookup?$filter=LookupName eq '${name}'&$top=200`, token)).json()).value as { LookupValue: string; StandardLookupValue: string | null; LookupKey: string }[];
    // A fixed list is given whole, each value as the standard value it is.
    const statuses = await values("StandardStatus");
    expect(statuses.map((v) => v.LookupValue).sort()).toEqual(["Active", "Active Under Contract", "Canceled", "Closed", "Coming Soon", "Expired", "Hold", "Pending", "Withdrawn"]);
    expect(statuses.every((v) => v.StandardLookupValue === v.LookupValue)).toBe(true);
    // A lookup OSMLS does not fix lists what served records hold, without calling any of it standard.
    const cities = await values("City");
    expect(cities.find((v) => v.LookupValue === city)).toMatchObject({ StandardLookupValue: null });
    expect((await values("CountyOrParish")).map((v) => v.LookupValue)).toContain(`Lookup County ${run}`);
    // A state is called standard only if it is a real postal abbreviation. "ZZ" is accepted by OSMLS and is not one.
    await createListing(agent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: "2", StreetName: "Lookup Rd", City: city, StateOrProvince: "ZZ", PostalCode: "98991", BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const states = await values("StateOrProvince");
    expect(states.find((v) => v.LookupValue === "WA")).toMatchObject({ StandardLookupValue: "WA" });
    expect(states.find((v) => v.LookupValue === "ZZ")).toMatchObject({ StandardLookupValue: null });
    expect(cities.every((v) => v.StandardLookupValue === null)).toBe(true);
    // A value held only by a record the feed leaves out is not listed: a document's type, never a photo's.
    const types = (await values("MediaType")).map((v) => v.LookupValue);
    expect(types).toContain("image/png");
    expect(types).not.toContain("application/pdf");
    expect(await values("MediaCategory")).toEqual([expect.objectContaining({ LookupValue: "Photo", StandardLookupValue: "Photo" })]);
    expect(await values("ResourceName")).toEqual([expect.objectContaining({ LookupValue: "Property", StandardLookupValue: "Property" })]);
    // Every lookup a field names has values, and keys do not repeat.
    const everything = (await (await get("/Lookup?$top=200&$count=true", token, { Prefer: "odata.maxpagesize=200" })).json()) as { value: { LookupName: string; LookupKey: string }[] };
    const named = new Set(SERVED_RESOURCES.flatMap((r) => r.fields.map((f) => f.lookup)).filter(Boolean));
    expect(new Set(everything.value.map((v) => v.LookupName))).toEqual(named);
    expect(new Set(everything.value.map((v) => v.LookupKey)).size).toBe(everything.value.length);
  });
});

describe("reading listings with what belongs to them", () => {
  it("expands a listing's photos, held to the same allowlist, and nothing else", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} expand` });
    const listing = await createListing(agent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: "1", StreetName: `Expand Rd ${run}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98990", BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const first = await addPhoto(agent, listing.ListingKey, png);
    const second = await addPhoto(agent, listing.ListingKey, png);
    const document = await addDocument(agent, listing.ListingKey, { bytes: pdf, name: `secret-expanded-${run}`, permission: "Private" });
    const bare = await createListing(agent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "400000", ListingContractDate: "2026-01-01",
      StreetNumber: "2", StreetName: `Expand Rd ${run}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98990", BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });

    const body = await (await get(`/Property?$filter=StreetName eq 'Expand Rd ${run}'&$select=ListingKey&$expand=Media&$orderby=ListPrice desc`, token)).json();
    expect(body.value.map((r: { ListingKey: string }) => r.ListingKey)).toEqual([listing.ListingKey, bare.ListingKey]);
    const [withPhotos, without] = body.value;
    expect(without.Media).toEqual([]);
    expect(withPhotos.Media.map((m: { MediaKey: string }) => m.MediaKey)).toEqual([first.MediaKey, second.MediaKey]);
    for (const photo of withPhotos.Media) {
      expect(Object.keys(photo)).toEqual(servedResource("Media")!.fields.map((f) => f.name));
      expect(photo.MediaURL).toBe(`http://localhost:3000/api/reso-photo/${photo.MediaKey}`);
    }
    const text = JSON.stringify(body);
    for (const secret of [document.MediaKey, `secret-expanded-${run}`, "OsmlsStoragePath", "Permission"]) expect(text.includes(secret), secret).toBe(false);
    // One record by key expands too.
    expect((await (await get(`/Property('${listing.ListingKey}')?$expand=Media`, token)).json()).Media).toHaveLength(2);
    // Only what the allowlist names for the resource can be expanded.
    for (const path of ["/Property?$expand=Documents", "/Property?$expand=ListAgent", "/Member?$expand=Media", "/Media?$expand=Property"]) expect((await get(path, token)).status, path).toBe(400);
    expect(metadataDocument()).toContain('<NavigationProperty Name="Media" Type="Collection(org.reso.metadata.Media)"/>');
  });

  it("filters, sorts, counts and pages on the days-on-market figures, using the one calculation", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} figures` });
    const city = `Figures${run}`;
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const fields = (number: number, status = "Active") => ({
      StandardStatus: status, PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: String(number), StreetName: "Figures Rd", City: city, StateOrProvince: "WA", PostalCode: "98989", BedroomsTotal: "3", BathroomsTotalInteger: "2",
      CountyOrParish: "Test County", ParcelNumber: `F${run}-${number}`,
    });
    // Ten days on the market; forty; and one relisted ten days after sixty days, thirty days ago.
    const ten = await createListing(agent, fields(1), { at: days(10) });
    const forty = await createListing(agent, fields(2), { at: days(40) });
    const earlier = await createListing(agent, fields(3), { at: days(100) });
    await updateListing(agent, earlier.ListingKey, fields(3, "Canceled"), null, { at: days(40) });
    const relisted = await createListing(agent, fields(3), { at: days(30) });

    const calculated = await getMarketTime([ten.ListingKey, forty.ListingKey, earlier.ListingKey, relisted.ListingKey]);
    expect(calculated.get(relisted.ListingKey)).toMatchObject({ daysOnMarket: 30, cumulativeDaysOnMarket: 90 });
    const read = async (query: string, headers: Record<string, string> = {}) =>
      (await get(`/Property?$select=ListingKey,DaysOnMarket,CumulativeDaysOnMarket&$filter=City eq '${city}'${query}`, token, headers)).json();
    const keys = (body: { value: { ListingKey: string }[] }) => body.value.map((r) => r.ListingKey);

    // The figures served are the figures the screens show.
    const all = await read("");
    for (const record of all.value) {
      expect(record.DaysOnMarket).toBe(calculated.get(record.ListingKey)!.daysOnMarket);
      expect(record.CumulativeDaysOnMarket).toBe(calculated.get(record.ListingKey)!.cumulativeDaysOnMarket);
    }
    expect(keys(await read(" and DaysOnMarket ge 35"))).toEqual(expect.arrayContaining([forty.ListingKey, earlier.ListingKey]));
    expect(keys(await read(" and DaysOnMarket ge 35"))).toHaveLength(2);
    expect(keys(await read(" and DaysOnMarket lt 35 and CumulativeDaysOnMarket gt 35"))).toEqual([relisted.ListingKey]);
    expect(keys(await read(" and (DaysOnMarket eq 10 or CumulativeDaysOnMarket eq 90) and not (DaysOnMarket eq 30)"))).toEqual([ten.ListingKey]);

    // Sorted on a figure, filtered on a figure, counted before paging, and paged to the end.
    const sorted = await read(" and CumulativeDaysOnMarket ge 30&$orderby=CumulativeDaysOnMarket desc&$count=true", { Prefer: "odata.maxpagesize=1" });
    expect(sorted["@odata.count"]).toBe(3);
    const order = [...keys(sorted)];
    for (let next = sorted["@odata.nextLink"]; next; ) {
      const body = await (await get(next.replace(ROOT, ""), token, { Prefer: "odata.maxpagesize=1" })).json();
      order.push(...keys(body));
      next = body["@odata.nextLink"];
    }
    expect(order).toEqual([relisted.ListingKey, earlier.ListingKey, forty.ListingKey]);
    // A photo's address is worked out too, and is not something to filter on.
    expect((await get("/Media?$filter=MediaURL ne null", token)).status).toBe(400);
  });
});

describe("what a consumer must reconcile, and when access ends", () => {
  it("drops an agent made MLS staff from the feed, and brings them back if they are made an agent again", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} members` });
    const made = (await createMember(admin, { firstName: "Feed", lastName: `Member${run}`, email: `feed-${run}@osmls.example`, memberId: `DX${run}`, role: "agent", officeKey: agent.OfficeKey!, phone: "" })).member;
    const inFeed = async () => (await (await get(`/Member?$filter=MemberMlsId eq 'DX${run}'`, token)).json()).value.length === 1;
    const details = { firstName: made.MemberFirstName, lastName: made.MemberLastName, memberId: made.MemberMlsId, phone: "" };
    expect(await inFeed()).toBe(true);
    const before = new Date().toISOString();

    await updateMember(admin, made.MemberKey, { ...details, role: "staff", officeKey: "" });
    // Still in the database, and gone from the feed: by filter, by key, and from a poll for changes.
    expect((await db.select().from(member).where(eq(member.MemberKey, made.MemberKey)))[0].OsmlsRole).toBe("staff");
    expect(await inFeed()).toBe(false);
    expect((await get(`/Member('${made.MemberKey}')`, token)).status).toBe(404);
    const polled = await (await get(`/Member?$filter=ModificationTimestamp ge ${before}&$top=200`, token)).json();
    expect(polled.value.map((m: { MemberKey: string }) => m.MemberKey)).not.toContain(made.MemberKey);
    // Staff accounts are never in the feed at all.
    expect((await (await get(`/Member?$filter=MemberMlsId eq 'ST0001'`, token)).json()).value).toEqual([]);

    await updateMember(admin, made.MemberKey, { ...details, role: "agent", officeKey: agent.OfficeKey! });
    expect(await inFeed()).toBe(true);
  });

  it("moves a listing's timestamp when a photo is added or removed, so a poll says to read its photos again", async () => {
    const { token } = await createDataConsumer(admin, { name: `Proof ${run} photos` });
    const listing = await createListing(agent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: "1", StreetName: `Photo Rd ${run}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98988", BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const stamp = async () => (await (await get(`/Property('${listing.ListingKey}')?$select=ModificationTimestamp`, token)).json()).ModificationTimestamp;
    const photoKeys = async () =>
      (await (await get(`/Media?$filter=ResourceRecordKey eq '${listing.ListingKey}'&$select=MediaKey`, token)).json()).value.map((m: { MediaKey: string }) => m.MediaKey);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const created = await stamp();
    await pause();
    const kept = await addPhoto(agent, listing.ListingKey, png);
    const removed = await addPhoto(agent, listing.ListingKey, png);
    const added = await stamp();
    expect(added > created).toBe(true);
    expect(await photoKeys()).toEqual(expect.arrayContaining([kept.MediaKey, removed.MediaKey]));

    await pause();
    await removePhoto(agent, removed.MediaKey);
    // The photo's own record is gone, and no record says so. The listing's timestamp moved, which is what a poll sees.
    expect((await stamp()) > added).toBe(true);
    const polled = await (await get(`/Property?$filter=ModificationTimestamp gt ${added}&$select=ListingKey&$expand=Media&$top=200`, token)).json();
    const again = polled.value.find((r: { ListingKey: string }) => r.ListingKey === listing.ListingKey);
    expect(again.Media.map((m: { MediaKey: string }) => m.MediaKey)).toEqual([kept.MediaKey]);
    expect(await photoKeys()).toEqual([kept.MediaKey]);
    expect((await get(`/Media('${removed.MediaKey}')`, token)).status).toBe(404);
    expect((await getPhoto(removed.MediaKey, token)).status).toBe(404);
  });

  it("refuses an expired token, and a revoked one from the moment the revocation is committed", async () => {
    const { consumer, token } = await createDataConsumer(admin, { name: `Proof ${run} expiry`, expiresInDays: 1 });
    expect((await get("/Office?$top=1", token)).status).toBe(200);
    await db.update(dataConsumer).set({ ExpirationTimestamp: new Date(Date.now() - 1000) }).where(eq(dataConsumer.ConsumerKey, consumer.ConsumerKey));
    expect((await get("/Office?$top=1", token)).status).toBe(401);
    expect((await listDataConsumers(admin))!.find((c) => c.consumerKey === consumer.ConsumerKey)!.state).toBe("Expired");

    // A revocation still being made refuses no one; once it is committed, every request after it is refused.
    const second = await createDataConsumer(admin, { name: `Proof ${run} revoking` });
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("begin");
      await other.query(`update "OsmlsDataConsumer" set "RevokedTimestamp" = now(), "RevokedByMemberKey" = $1 where "ConsumerKey" = $2`, [admin.MemberKey, second.consumer.ConsumerKey]);
      expect((await get("/Office?$top=1", second.token)).status).toBe(200);
      await other.query("commit");
    } finally {
      await other.end();
    }
    expect((await get("/Office?$top=1", second.token)).status).toBe(401);
    await expect(createDataConsumer(admin, { name: "  " })).rejects.toThrow("Give the data consumer a name.");
    await expect(createDataConsumer(admin, { name: `Proof ${run} bad`, expiresInDays: "soon" })).rejects.toThrow(/whole number of days/);
  });

  it("stops a consumer that has made too many requests in a minute, and no one else", async () => {
    const busy = await createDataConsumer(admin, { name: `Proof ${run} busy` });
    const quiet = await createDataConsumer(admin, { name: `Proof ${run} quiet` });
    await db.execute(sql`
      insert into "OsmlsDataRequest" ("ConsumerKey", "ResourceName", "Query", "Status", "RecordCount")
      select ${busy.consumer.ConsumerKey}::uuid, 'Office', '', 200, 1 from generate_series(1, ${MAX_REQUESTS_PER_MINUTE})`);
    const refused = await get("/Office?$top=1", busy.token);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect((await get("/Office?$top=1", quiet.token)).status).toBe(200);
    // A minute later the same consumer is served again.
    await db.execute(sql`update "OsmlsDataRequest" set "RequestTimestamp" = now() - interval '2 minutes' where "ConsumerKey" = ${busy.consumer.ConsumerKey}::uuid`);
    expect((await get("/Office?$top=1", busy.token)).status).toBe(200);
  });
});

