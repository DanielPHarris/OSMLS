/*
 * Sharing with a client, end to end through the running application and a real
 * mail catcher: a member emails a link, the link is opened signed out, the
 * whole response is read for anything a client must not get, and revoking the
 * link ends both the page and its photos.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const password = process.env.DEMO_PASSWORD!;
const mailpit = process.env.MAILPIT_URL!;
const run = Date.now();
const ALEX = "alex.rivera@osmls.example";
const CLIENT = `client-${run}@clients.example`;
const NOTE = `A note for you ${run}`;

// A distinctive value in every field a client must not be given.
const MARKS = {
  showing: `showing-mark-${run}`,
  contactName: `contact-mark-${run}`,
  lockBox: `lockbox-mark-${run}`,
  county: `County-mark-${run}`,
  parcel: `PARCEL-${run}`,
  latitude: "47.234567",
  local: `local-mark-${run}`,
  originalPrice: "888,888",
  document: `document-mark-${run}`,
  storagePath: `storage-mark-${run}`,
  reason: `reason-mark-${run}`,
};
const REMARKS = `Public remarks ${run}`;
// A 1x1 PNG.
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

type Listing = { ListingKey: string; ListingId: string };
let db: Client;
let listing: Listing;
let alexKeys: { MemberKey: string; MemberMlsId: string; OfficeKey: string };

/** A listing with a distinctive value in every private field. */
async function insertListing(status: string, number: string): Promise<Listing> {
  const { rows } = await db.query(
    `insert into "Property" ("StandardStatus", "PropertyType", "ListPrice", "OriginalListPrice", "ListingContractDate",
       "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode", "UnparsedAddress", "CountyOrParish",
       "ParcelNumber", "BedroomsTotal", "BathroomsTotalInteger", "PublicRemarks", "ShowingInstructions",
       "ShowingContactName", "LockBoxLocation", "ListAgentKey", "ListOfficeKey", "OsmlsLocalFields")
     values ($1, 'Residential', 640000, 888888, '2026-01-05', $2, 'Share St', $3, 'WA', '96561', $4, $5, $6, 3, 2,
       $7, $8, $9, $10, $11, $12, $13)
     returning "ListingKey", "ListingId"`,
    [status, number, `Shareville${run}`, `${number} Share St, Shareville${run}, WA 96561`, MARKS.county, `${MARKS.parcel}-${number}`,
      REMARKS, MARKS.showing, MARKS.contactName, MARKS.lockBox, alexKeys.MemberKey, alexKeys.OfficeKey, JSON.stringify({ note: MARKS.local })],
  );
  return rows[0];
}

test.beforeAll(async () => {
  if (!mailpit) throw new Error("MAILPIT_URL is not set. Copy it from .env.example into .env and run `docker compose up -d mail`.");
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const { rows: [alex] } = await db.query(`select "MemberKey", "MemberMlsId", "OfficeKey" from "Member" where "MemberEmail" = $1`, [ALEX]);
  alexKeys = alex;
  listing = await insertListing("Active", "1");
  await db.query(
    `insert into "Media" ("ResourceRecordKey", "MediaCategory", "MediaType", "Order", "ShortDescription", "Permission",
       "OsmlsStoragePath", "OsmlsFileSize", "OsmlsFileHash")
     values ($1, 'Document', 'application/pdf', 1, $2, 'Private', $3, 10, 'x')`,
    [listing.ListingKey, MARKS.document, MARKS.storagePath],
  );
  await db.query(
    `insert into "HistoryTransactional" ("ResourceRecordKey", "ResourceRecordID", "ClassName", "FieldName", "PreviousValue",
       "NewValue", "ChangedByMemberKey", "ChangedByMemberID", "OsmlsStaffCorrection", "OsmlsCorrectionReason")
     values ($1, $2, 'Residential', 'PublicRemarks', null, 'x', $3, $4, true, $5)`,
    [listing.ListingKey, listing.ListingId, alex.MemberKey, alex.MemberMlsId, MARKS.reason],
  );
});
test.afterAll(() => db.end());

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
}

/** The one email the mail catcher holds for an address, as plain text with its headers. */
async function emailTo(address: string, subject?: string) {
  let found: { ID: string }[] = [];
  const query = `to:${address}${subject ? ` subject:"${subject}"` : ""}`;
  await expect(async () => {
    const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(query)}`);
    found = (await response.json()).messages;
    expect(found).toHaveLength(1);
  }).toPass({ timeout: 10_000 });
  return (await (await fetch(`${mailpit}/api/v1/message/${found[0].ID}`)).json()) as {
    Text: string;
    Subject: string;
    ReplyTo: { Address: string }[];
  };
}

test("a listing emailed to a client opens signed out, carries only the client copy, and stops when revoked", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page, ALEX);
  await page.goto(`/listings/${listing.ListingKey}/edit`);
  await page.getByLabel("Add a photo").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("img", { name: "Photo 1", exact: true })).toBeVisible();

  // ---- 1. The member shares the listing by email ----
  await page.goto(`/listings/${listing.ListingKey}`);
  const shares = page.getByTestId("shares");
  await shares.getByLabel("Client’s email (optional)").fill(CLIENT);
  await shares.getByLabel("Note to include in the email (optional)").fill(NOTE);
  await shares.getByRole("button", { name: "Make link" }).click();
  await expect(shares.getByRole("status")).toContainText(`Link emailed to ${CLIENT}.`);

  // ---- 2. The email arrives in the mail catcher; the link is taken from it ----
  const email = await emailTo(CLIENT);
  expect(email.Subject).toBe("Alex Rivera shared a listing with you");
  expect(email.ReplyTo.map((r) => r.Address)).toEqual([ALEX]);
  expect(email.Text).toContain(NOTE);
  // The email carries the link and nothing about the listing.
  for (const absent of [listing.ListingId, "Share St", "640,000", REMARKS]) expect(email.Text.includes(absent), absent).toBe(false);
  const link = email.Text.match(/http:\/\/localhost:\d+\/share\/[A-Za-z0-9_-]{43}/)?.[0];
  expect(link, "a link in the email").toBeTruthy();
  const sharePath = new URL(link!).pathname;
  // Only a hash of the link is stored.
  const { rows: stored } = await db.query(`select * from "OsmlsShare" where "ListingKey" = $1`, [listing.ListingKey]);
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored).includes(sharePath.split("/")[2])).toBe(false);

  // ---- 3. Signed out, the link opens, and the whole response is the client copy only ----
  const visitor = await browser.newContext();
  const client = await visitor.newPage();
  const requested: string[] = [];
  client.on("request", (request) => requested.push(new URL(request.url()).origin));
  const opened = await client.goto(sharePath);
  expect(opened!.status()).toBe(200);
  expect(opened!.headers()["cache-control"]).toContain("no-store");
  expect(opened!.headers()["referrer-policy"]).toBe("no-referrer");
  expect(opened!.headers()["x-robots-tag"]).toContain("noindex");
  await expect(client.getByTestId("shared-by")).toContainText("Shared by Alex Rivera");
  await expect(client.getByRole("heading", { name: `1 Share St, Shareville${run}, WA 96561` })).toBeVisible();
  await expect(client.getByTestId("report-listing")).toContainText("$640,000");
  await expect(client.getByTestId("report-remarks")).toHaveText(REMARKS);
  const body = await (await visitor.request.get(sharePath)).text();
  expect(body).toContain(listing.ListingId);
  for (const [name, mark] of Object.entries(MARKS)) expect(body.includes(mark), name).toBe(false);
  for (const key of [listing.ListingKey, stored[0].ShareKey, stored[0].MemberKey, CLIENT, "Days on market"]) {
    expect(body.includes(key), key).toBe(false);
  }

  // ---- 4. Signed out, the photo loads through the link; the members-only address still refuses ----
  const img = client.getByTestId("report-photos").locator("img");
  await expect(img).toHaveCount(1);
  const src = (await img.getAttribute("src"))!;
  expect(src.startsWith(`${sharePath}/media/`)).toBe(true);
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  const shared = await visitor.request.get(src);
  expect(shared.status()).toBe(200);
  expect(shared.headers()["content-type"]).toBe("image/png");
  expect(shared.headers()["cache-control"]).toBe("no-store");
  const mediaKey = src.split("/").pop()!;
  expect((await visitor.request.get(`/media/${mediaKey}`)).status()).toBe(401);
  // A link gives its own photos only: not a document's key, and not through another link.
  const { rows: [document] } = await db.query(`select "MediaKey" from "Media" where "ResourceRecordKey" = $1 and "MediaCategory" = 'Document'`, [listing.ListingKey]);
  expect((await visitor.request.get(`${sharePath}/media/${document.MediaKey}`)).status()).toBe(404);
  expect((await visitor.request.get(`/share/${"A".repeat(43)}/media/${mediaKey}`)).status()).toBe(404);

  // The page loaded nothing from any other site.
  expect([...new Set(requested)]).toEqual([new URL(link!).origin]);

  // ---- 5. The member revokes the link: the page and the photo both stop ----
  await page.reload();
  await page.getByTestId("share-list").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("share-list")).toHaveCount(0);
  expect((await visitor.request.get(sharePath)).status()).toBe(404);
  expect((await visitor.request.get(src)).status()).toBe(404);
  const after = await client.goto(sharePath);
  expect(after!.status()).toBe(404);
  await expect(client.getByText("Share St")).toHaveCount(0);
  // A revoked link answers exactly as one that never existed.
  const never = await visitor.request.get(`/share/${"A".repeat(43)}`);
  expect(never.status()).toBe(404);
  // Revoking also drops the client's address.
  const { rows: [ended] } = await db.query(`select "OsmlsRecipientEmail", "OsmlsRevokedTimestamp" from "OsmlsShare" where "ShareKey" = $1`, [stored[0].ShareKey]);
  expect(ended.OsmlsRecipientEmail).toBeNull();
  expect(ended.OsmlsRevokedTimestamp).not.toBeNull();
  await visitor.close();
});

test("a collection link shows the collection as it is now, as client copies only", async ({ page, browser }) => {
  const comingSoon = await insertListing("Coming Soon", "2");
  const later = await insertListing("Pending", "3");
  const name = `Collection-mark-${run}`;
  const { rows: [collection] } = await db.query(
    `insert into "OsmlsCollection" ("MemberKey", "CollectionName") values ($1, $2) returning "CollectionKey"`,
    [alexKeys.MemberKey, name],
  );
  const add = (l: Listing) =>
    db.query(`insert into "OsmlsCollectionListing" ("CollectionKey", "ListingKey") values ($1, $2)`, [collection.CollectionKey, l.ListingKey]);
  await add(listing);
  await add(comingSoon);

  await signIn(page, ALEX);
  await page.goto(`/collections/${collection.CollectionKey}`);
  const shares = page.getByTestId("shares");
  // The warning is there before a link is made.
  await expect(shares.getByTestId("share-warning")).toContainText("Listings you add later become visible to anyone holding a link.");
  await shares.getByRole("button", { name: "Make link" }).click();
  await expect(shares.getByRole("status")).toContainText("Link made.");
  // Shown this once, for the member to send themself.
  const link = await shares.getByTestId("share-link").inputValue();
  const sharePath = new URL(link).pathname;
  await page.reload();
  await expect(shares.getByTestId("share-warning")).toContainText("This collection is shared through 1 link.");
  await expect(page.getByTestId("share-link")).toHaveCount(0);

  const visitor = await browser.newContext();
  const client = await visitor.newPage();
  expect((await client.goto(sharePath))!.status()).toBe(200);
  await expect(client.getByTestId("report-listing")).toHaveCount(1);
  await expect(client.getByTestId("shared-notes")).toContainText("1 listing in this collection is not included");
  let body = await (await visitor.request.get(sharePath)).text();
  expect(body).toContain(listing.ListingId);
  for (const [mark, value] of Object.entries({ ...MARKS, name, comingSoon: comingSoon.ListingId, key: collection.CollectionKey })) {
    expect(body.includes(value), mark).toBe(false);
  }
  // A listing added after the link was made is visible through it.
  await add(later);
  body = await (await visitor.request.get(sharePath)).text();
  expect(body).toContain(later.ListingId);
  // Deleting the collection ends the link.
  await page.getByRole("button", { name: "Delete collection" }).click();
  await expect(page).toHaveURL(/\/collections\?notice=collection-deleted/);
  expect((await visitor.request.get(sharePath)).status()).toBe(404);
  await visitor.close();
});

test("a recipient stops email with the link in it; opening that link alone stops nothing", async ({ page, browser }) => {
  const recipient = `stop-${run}@clients.example`;
  await signIn(page, ALEX);
  await page.goto(`/listings/${listing.ListingKey}`);
  const shares = page.getByTestId("shares");
  await shares.getByLabel("Client’s email (optional)").fill(recipient);
  await shares.getByRole("button", { name: "Make link" }).click();
  await expect(shares.getByRole("status")).toContainText(`Link emailed to ${recipient}.`);
  const email = await emailTo(recipient);
  const stop = email.Text.match(/http:\/\/localhost:\d+(\/share\/[A-Za-z0-9_-]{43}\/stop)/)?.[1];
  expect(stop, "a stop link in the email").toBeTruthy();
  const sharePath = stop!.replace(/\/stop$/, "");
  const address = async () =>
    (await db.query(`select "OsmlsRecipientEmail" from "OsmlsShare" where "OsmlsRecipientHash" is not null and "OsmlsSentTimestamp" is not null
       and "ListingKey" = $1 order by "OriginalEntryTimestamp" desc limit 1`, [listing.ListingKey])).rows[0].OsmlsRecipientEmail;

  const visitor = await browser.newContext();
  const client = await visitor.newPage();
  // Fetching the page, as a mail scanner would, changes nothing.
  expect((await visitor.request.get(stop!)).status()).toBe(200);
  await client.goto(stop!);
  expect(await address()).toBe(recipient);
  await client.getByRole("button", { name: "Stop email to my address" }).click();
  await expect(client.getByRole("status")).toHaveText("Done. This system will not email your address again.");
  expect(await address()).toBeNull();
  // The link they were sent still opens.
  expect((await visitor.request.get(sharePath)).status()).toBe(200);
  // A link that was never made has no stop page.
  expect((await visitor.request.get(`/share/${"A".repeat(43)}/stop`)).status()).toBe(404);
  await visitor.close();

  // The member is told, and no email goes out.
  await page.reload();
  await shares.getByLabel("Client’s email (optional)").fill(recipient);
  await shares.getByRole("button", { name: "Make link" }).click();
  await expect(shares.getByRole("alert")).toContainText("That address has asked not to receive email from this system.");
  await emailTo(recipient);
});

test("a saved search's alert is emailed by the scheduled command and leaves in-app activity unseen", async ({ page, baseURL }) => {
  const watched = await insertListing("Active", "4");
  const name = `Alerting ${run}`;
  await signIn(page, ALEX);
  await page.goto(`/search?s=1&status=Active&city=Shareville${run}`);
  const save = page.getByTestId("save-search");
  await save.getByLabel("Name").fill(name);
  await save.getByRole("button", { name: "Save this search" }).click();
  await expect(save.getByRole("status")).toHaveText("Search saved.");
  const key = new URL(page.url()).searchParams.get("saved")!;

  await page.goto("/saved-searches");
  const card = page.getByTestId("saved-searches").getByRole("listitem").filter({ hasText: name });
  await card.getByLabel(`Email alerts for ${name}`, { exact: true }).selectOption("daily");
  await card.getByRole("button", { name: `Save email alerts for ${name}` }).click();
  await expect(card.getByTestId("alert").getByRole("status")).toHaveText("Email alerts saved. Only activity from now on is emailed.");

  // A price change, recorded as the application records one; then a day passes.
  await db.query("begin");
  await db.query(`update "Property" set "ListPrice" = 630000 where "ListingKey" = $1`, [watched.ListingKey]);
  await db.query(
    `insert into "HistoryTransactional" ("ResourceRecordKey", "ResourceRecordID", "ClassName", "FieldName", "PreviousValue",
       "NewValue", "ChangeType", "ChangedByMemberKey", "ChangedByMemberID")
     values ($1, $2, 'Residential', 'ListPrice', '640000', '630000', 'Price Change', $3, $4)`,
    [watched.ListingKey, watched.ListingId, alexKeys.MemberKey, alexKeys.MemberMlsId],
  );
  await db.query("commit");
  await db.query(`update "SavedSearch" set "OsmlsAlertLastSentAt" = now() - interval '25 hours' where "SavedSearchKey" = $1`, [key]);

  const runCommand = () =>
    execFileSync("pnpm", ["exec", "tsx", "scripts/send-alerts.ts"], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, BETTER_AUTH_URL: baseURL },
      encoding: "utf8",
    });
  expect(runCommand()).toContain('"sent":1');
  const email = await emailTo(ALEX, name);
  expect(email.Subject).toBe(`New activity for your saved search "${name}"`);
  expect(email.Text).toContain("1 listing has new activity");
  for (const absent of [watched.ListingId, "Share St", "630"]) expect(email.Text.includes(absent), absent).toBe(false);
  // Running it again sends nothing more.
  expect(runCommand()).not.toContain('"sent"');
  await emailTo(ALEX, name);

  // The link in the email leads to the activity, which the email did not mark as seen.
  const link = email.Text.match(/http:\/\/localhost:\d+(\/saved-searches\/[0-9a-f-]{36}\/activity)/)?.[1];
  expect(link).toBe(`/saved-searches/${key}/activity`);
  await page.goto(link!);
  await expect(page.getByTestId("activity-listing")).toContainText("List price $640,000 → $630,000");
  await page.goto("/saved-searches");
  await expect(card.getByTestId("activity-count")).toHaveText("Activity on 1 listing");
});
