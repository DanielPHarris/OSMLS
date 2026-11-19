/*
 * Printable reports through the running application. The client-copy checks
 * read the whole response the server sends, so anything sent but not displayed
 * would still be caught. The print checks use Chromium's own print output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const CITY = `Printville${run}`;
const ALEX = "alex.rivera@osmls.example";
const SAM = "sam.whitfield@osmls.example";
const STAFF = "morgan.ellis@osmls.example";

// A distinctive value in every field a client copy must not carry.
const MARKS = {
  showing: `showing-mark-${run}`,
  contactName: `contact-mark-${run}`,
  contactPhone: `555-01${String(run).slice(-2)}-77`,
  lockBox: `lockbox-mark-${run}`,
  county: `County-mark-${run}`,
  parcel: `PARCEL-${run}`,
  latitude: "47.123456",
  longitude: "-122.654321",
  local: `local-mark-${run}`,
  originalPrice: "777,777",
  document: `document-mark-${run}`,
  storagePath: `storage-mark-${run}`,
  hash: `hash-mark-${run}`,
  history: `history-mark-${run}`,
  reason: `reason-mark-${run}`,
  collection: `Collection-mark-${run}`,
};
// A 1x1 PNG.
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const REMARKS = Array.from({ length: 80 }, (_, i) => `Sentence ${i + 1} of a long description for ${run}.`).join(" ").padEnd(4000, " x");

type Setup = { main: string; mainId: string; comingSoon: string; collection: string; documentKey: string; agentKey: string; officeKey: string };
let made: Setup;

async function prepare(): Promise<Setup> {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    const { rows: [alex] } = await db.query(`select "MemberKey", "MemberMlsId", "OfficeKey" from "Member" where "MemberEmail" = $1`, [ALEX]);
    const insert = async (status: string, number: string) => {
      const { rows: [row] } = await db.query(
        `insert into "Property" ("StandardStatus", "PropertyType", "ListPrice", "OriginalListPrice", "ListingContractDate",
           "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode", "UnparsedAddress", "CountyOrParish",
           "ParcelNumber", "Latitude", "Longitude", "BedroomsTotal", "BathroomsTotalInteger", "PublicRemarks",
           "ShowingInstructions", "ShowingContactName", "ShowingContactPhone", "LockBoxLocation", "ListAgentKey",
           "ListOfficeKey", "OsmlsLocalFields")
         values ($1, 'Residential', 650000, 777777, '2026-01-05', $2, 'Print Pl', $3, 'WA', '96557', $4, $5, $6, $7, $8,
           4, 3, $9, $10, $11, $12, $13, $14, $15, $16)
         returning "ListingKey", "ListingId"`,
        [status, number, CITY, `${number} Print Pl, ${CITY}, WA 96557`, MARKS.county, `${MARKS.parcel}-${number}`,
          // Only the Active listing has a pin, so other tests' maps gain no Coming Soon marker.
          ...(status === "Active" ? [MARKS.latitude, MARKS.longitude] : [null, null]), REMARKS, MARKS.showing, MARKS.contactName, MARKS.contactPhone, MARKS.lockBox,
          alex.MemberKey, alex.OfficeKey, JSON.stringify({ note: MARKS.local })],
      );
      return row as { ListingKey: string; ListingId: string };
    };
    const main = await insert("Active", "1");
    const comingSoon = await insert("Coming Soon", "2");
    const { rows: [document] } = await db.query(
      `insert into "Media" ("ResourceRecordKey", "MediaCategory", "MediaType", "Order", "ShortDescription", "Permission",
         "OsmlsStoragePath", "OsmlsFileSize", "OsmlsFileHash")
       values ($1, 'Document', 'application/pdf', 1, $2, 'Private', $3, 10, $4) returning "MediaKey"`,
      [main.ListingKey, MARKS.document, MARKS.storagePath, MARKS.hash],
    );
    await db.query(
      `insert into "HistoryTransactional" ("ResourceRecordKey", "ResourceRecordID", "ClassName", "FieldName", "PreviousValue",
         "NewValue", "ChangedByMemberKey", "ChangedByMemberID", "OsmlsStaffCorrection", "OsmlsCorrectionReason")
       values ($1, $2, 'Residential', 'PublicRemarks', null, $3, $4, $5, true, $6)`,
      [main.ListingKey, main.ListingId, MARKS.history, alex.MemberKey, alex.MemberMlsId, MARKS.reason],
    );
    const { rows: [collection] } = await db.query(
      `insert into "OsmlsCollection" ("MemberKey", "CollectionName") values ($1, $2) returning "CollectionKey"`,
      [alex.MemberKey, MARKS.collection],
    );
    for (const listing of [comingSoon, main]) {
      await db.query(`insert into "OsmlsCollectionListing" ("CollectionKey", "ListingKey") values ($1, $2)`, [
        collection.CollectionKey,
        listing.ListingKey,
      ]);
    }
    return {
      main: main.ListingKey,
      mainId: main.ListingId,
      comingSoon: comingSoon.ListingKey,
      collection: collection.CollectionKey,
      documentKey: document.MediaKey,
      agentKey: alex.MemberKey,
      officeKey: alex.OfficeKey,
    };
  } finally {
    await db.end();
  }
}

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function contextFor(browser: Browser, email: string, active = true): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  if (active) await expect(page).toHaveURL(/\/search/);
  else await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.close();
  return context;
}

const searchQuery = () => `s=1&city=${CITY}&sort=price_low`;
const urls = (copy: string) => ({
  listing: `/reports/listing/${made.main}?copy=${copy}`,
  collection: `/reports/collection/${made.collection}?copy=${copy}`,
  search: `/reports/search?${searchQuery()}&copy=${copy}`,
});

/** PDFs are kept when REPORT_PDF_DIR is set, to be looked at by eye. */
async function printed(page: Page, name: string): Promise<number> {
  const pdf = await page.pdf({ format: "Letter", printBackground: true });
  if (process.env.REPORT_PDF_DIR) {
    mkdirSync(process.env.REPORT_PDF_DIR, { recursive: true });
    writeFileSync(path.join(process.env.REPORT_PDF_DIR, `${name}.pdf`), pdf);
  }
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

test.beforeAll(async () => {
  made = await prepare();
});

test("a client copy's response carries only what a client may have", async ({ browser }) => {
  const alex = await contextFor(browser, ALEX);
  const sam = await contextFor(browser, SAM);
  for (const [who, context] of [["alex", alex], ["sam", sam]] as const) {
    for (const [kind, url] of Object.entries(urls("client"))) {
      // Sam has no such collection: covered under refusals.
      if (who === "sam" && kind === "collection") continue;
      const response = await context.request.get(url);
      expect(response.status(), `${who} ${kind}`).toBe(200);
      const body = await response.text();
      expect(body, `${who} ${kind}`).toContain(made.mainId);
      expect(body).toContain("Sentence 80 of a long description");
      for (const [name, mark] of Object.entries(MARKS)) expect(body.includes(mark), `${who} ${kind} ${name}`).toBe(false);
      for (const key of [made.documentKey, made.agentKey, made.officeKey, made.comingSoon]) {
        expect(body.includes(key), `${who} ${kind} key`).toBe(false);
      }
      // The listing's own key is in a single listing's address, and nowhere in a list.
      if (kind !== "listing") expect(body.includes(made.main), `${who} ${kind} listing key`).toBe(false);
      expect(body).not.toMatch(/Days on market|Original list price|Parcel number|Showing/);
      // The listing agent is named; his contact details are given only on his own copies.
      expect(body).toContain("Alex Rivera");
      expect(body.includes(ALEX), `${who} ${kind} agent email`).toBe(who === "alex");
    }
  }
  await alex.close();
  await sam.close();
});

test("an agent copy adds what the member may see, and never history or documents", async ({ browser }) => {
  for (const email of [ALEX, STAFF]) {
    const context = await contextFor(browser, email);
    for (const [kind, url] of Object.entries(urls("agent"))) {
      if (email === STAFF && kind === "collection") continue;
      const body = await (await context.request.get(url)).text();
      for (const mark of [MARKS.showing, MARKS.lockBox, MARKS.parcel, MARKS.county, MARKS.originalPrice]) {
        expect(body.includes(mark), `${email} ${kind} ${mark}`).toBe(true);
      }
      for (const mark of [MARKS.document, MARKS.storagePath, MARKS.hash, MARKS.history, MARKS.reason, MARKS.local]) {
        expect(body.includes(mark), `${email} ${kind} ${mark}`).toBe(false);
      }
      expect(body).toContain("Agent copy. For MLS members only. Not for distribution.");
    }
    await context.close();
  }
});

test("reports are refused where they should be", async ({ browser }) => {
  const alex = await contextFor(browser, ALEX);
  for (const url of [
    `/reports/listing/${made.main}`,
    `/reports/listing/${made.main}?copy=both`,
    `/reports/listing/${made.main}?copy=constructor`,
    `/reports/collection/${made.collection}?copy=Agent`,
    `/reports/search?${searchQuery()}`,
    `/reports/search?${searchQuery()}&copy=client&copy=agent`,
    `/reports/listing/${NO_SUCH_KEY}?copy=agent`,
    `/reports/collection/${NO_SUCH_KEY}?copy=client`,
  ]) {
    expect((await alex.request.get(url)).status(), url).toBe(404);
  }
  // A client copy of a listing whose status is not given to clients.
  const page = await alex.newPage();
  await page.goto(`/reports/listing/${made.comingSoon}?copy=client`);
  await expect(page.getByTestId("report-refused")).toContainText("This listing is Coming Soon.");
  await expect(page.getByTestId("report")).toHaveCount(0);
  await alex.close();

  // Someone else's collection answers exactly like one that does not exist.
  for (const email of [SAM, STAFF]) {
    const context = await contextFor(browser, email);
    for (const copy of ["agent", "client"]) {
      const theirs = await context.request.get(`/reports/collection/${made.collection}?copy=${copy}`);
      const none = await context.request.get(`/reports/collection/${NO_SUCH_KEY}?copy=${copy}`);
      expect(theirs.status()).toBe(404);
      expect(none.status()).toBe(404);
      expect(await theirs.text()).not.toContain(MARKS.collection);
    }
    await context.close();
  }

  // A suspended account and a signed-out visitor are sent to sign in.
  const suspended = await contextFor(browser, "riley.chen@osmls.example", false);
  const signedOut = await browser.newContext();
  for (const context of [suspended, signedOut]) {
    for (const url of Object.values(urls("client"))) {
      const response = await context.request.get(url);
      expect(response.url()).toContain("/sign-in");
      expect(await response.text()).not.toContain(made.mainId);
    }
    await context.close();
  }
});

test("a member opens, switches, and prints reports", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, ALEX);
  await expect(page).toHaveURL(/\/search/);

  // ---- One listing, from its page, with one more photo than a report shows ----
  await page.goto(`/listings/${made.main}/edit`);
  for (let n = 1; n <= 7; n++) {
    await page.getByLabel("Add a photo").setInputFiles({ name: `photo-${n}.png`, mimeType: "image/png", buffer: photo });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("img", { name: `Photo ${n}`, exact: true })).toBeVisible();
  }
  await page.goto(`/listings/${made.main}`);
  await page.getByRole("link", { name: "Print client copy" }).click();
  await expect(page.getByTestId("report-copy-label")).toHaveText("Client copy");
  // Photos are referred to by the application's photo address and nothing else, and they load.
  const photos = page.getByTestId("report-photos").locator("img");
  await expect(photos).toHaveCount(6);
  for (const src of await photos.evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")))) {
    expect(src).toMatch(/^\/media\/[0-9a-f-]{36}$/);
  }
  expect(await photos.evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  for (const where of ["top", "bottom"]) await expect(page.getByTestId(`report-notes-${where}`)).toHaveText("6 of 7 photos shown.");
  await expect(page.getByTestId("report-prepared-by")).toContainText("Prepared by Alex Rivera");
  await expect(page.getByTestId("report-showing")).toHaveCount(0);
  await page.emulateMedia({ media: "print" });
  expect(await printed(page, "listing-client")).toBeGreaterThanOrEqual(2);
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("link", { name: "Switch to agent copy" }).click();
  await expect(page.getByTestId("report-copy-label")).toContainText("Agent copy");
  await expect(page.getByTestId("report-showing")).toContainText(MARKS.showing);

  // On paper: no navigation or buttons, nothing clipped, and the remarks run on to another page.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("report-toolbar")).toBeHidden();
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  const remarks = page.getByTestId("report-remarks");
  await expect(remarks).toContainText("Sentence 80 of a long description");
  expect(await remarks.evaluate((el) => el.scrollHeight <= el.clientHeight && getComputedStyle(el).overflow === "visible")).toBe(true);
  expect(await page.locator(".report-keep").first().evaluate((el) => getComputedStyle(el).breakInside)).toBe("avoid");
  expect(await printed(page, "listing-agent")).toBeGreaterThanOrEqual(2);
  await page.emulateMedia({ media: "screen" });

  // ---- A collection: status first, then the order added ----
  await page.goto(`/collections/${made.collection}`);
  await page.getByRole("link", { name: "Print client copy" }).click();
  await expect(page.getByTestId("report-listing")).toHaveCount(1);
  for (const where of ["top", "bottom"]) {
    await expect(page.getByTestId(`report-notes-${where}`)).toHaveText(
      "1 listing in this collection is not included: client copies include only Active, Active Under Contract, Pending, Closed listings.",
    );
  }
  await expect(page.getByTestId("report")).not.toContainText(MARKS.collection);
  await page.getByRole("link", { name: "Switch to agent copy" }).click();
  await expect(page.getByTestId("report-listing")).toHaveCount(2);
  await expect(page.getByTestId("report-listing").first()).toContainText("Coming Soon");
  await expect(page.getByTestId("report")).toContainText(MARKS.collection);
  await expect(page.getByTestId("report-notes-top")).toHaveCount(0);

  // ---- A search of more listings than a report holds ----
  await page.goto("/search?s=1&sort=price_low");
  const firstOnSearch = await page.getByRole("table").last().locator("tbody tr td:nth-child(3) a").first().innerText();
  await page.getByRole("link", { name: "Print agent copy" }).click();
  await expect(page.getByTestId("report-listing")).toHaveCount(50);
  await expect(page.getByTestId("report-listing").first()).toContainText(firstOnSearch);
  for (const where of ["top", "bottom"]) {
    await expect(page.getByTestId(`report-notes-${where}`)).toContainText(/^Showing the first 50 /);
  }
  await page.emulateMedia({ media: "print" });
  const pages = await printed(page, "search-agent");
  expect(pages).toBeGreaterThanOrEqual(5);
  // No listing's heading, photo, and facts are cut by a page: each block is kept whole.
  const kept = await page.locator('[data-testid="report-listing"] > .report-keep').evaluateAll(
    (blocks) => blocks.every((el) => getComputedStyle(el).breakInside === "avoid"),
  );
  expect(kept).toBe(true);
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("link", { name: "Switch to client copy" }).click();
  await expect(page.getByTestId("report-copy-label")).toHaveText("Client copy");
  await page.emulateMedia({ media: "print" });
  expect(await printed(page, "search-client")).toBeGreaterThanOrEqual(3);
});
