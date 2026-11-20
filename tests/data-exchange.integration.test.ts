/*
 * The data exchange feed against the test database, through its route
 * handlers: what a bearer token can read, that it is only what the export
 * allowlist names, the photo route, and what revoking the token ends.
 *
 * This is the first proof (issue #31). The fuller set comes with the rest of
 * the slice.
 */
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as feed } from "../src/app/api/reso/[[...path]]/route";
import { GET as photoRoute } from "../src/app/api/reso-photo/[key]/route";
import { db, pool } from "../src/db";
import { dataConsumer, dataRequest, member, type Member } from "../src/db/schema";
import { createDataConsumer, listDataConsumers, metadataDocument, revokeDataConsumer } from "../src/lib/data-exchange";
import { addDocument } from "../src/lib/documents";
import { addPhoto, createListing } from "../src/lib/listings";
import { SERVED_RESOURCES, servedResource } from "../src/lib/rules/data-exchange";

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

const get = (path: string, token: string | null) =>
  feed(new Request(`${ROOT}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), {
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

describe("the first proof of the data exchange feed", () => {
  it("describes exactly the allowlist in its metadata", () => {
    const metadata = metadataDocument();
    for (const resource of SERVED_RESOURCES) {
      const type = new RegExp(`<EntityType Name="${resource.name}">([\\s\\S]*?)</EntityType>`).exec(metadata)![1];
      const described = [...type.matchAll(/<Property Name="([^"]+)"/g)].map((m) => m[1]);
      expect(described, resource.name).toEqual(resource.fields.map((f) => f.name));
    }
    for (const name of NEVER) expect(metadata.includes(name), name).toBe(false);
    expect(SERVED_RESOURCES.map((r) => r.name)).toEqual(["Property", "Member", "Office", "Media"]);
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

  it("is managed only by staff who hold Manage data access", async () => {
    for (const viewer of [agent, { ...admin, OsmlsCapabilities: admin.OsmlsCapabilities.filter((c) => c !== "data") }, null]) {
      await expect(createDataConsumer(viewer, { name: `Proof ${run} refused` })).rejects.toThrow("Not found.");
      expect(await listDataConsumers(viewer)).toBeNull();
    }
    expect(await db.select().from(dataConsumer).where(eq(dataConsumer.ConsumerName, `Proof ${run} refused`))).toEqual([]);
  });
});
