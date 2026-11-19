/*
 * Saved-search activity through the running application: what a member is
 * shown, that looking never clears it, that marking as seen clears exactly what
 * was loaded, and that no one else can reach it.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const CITY = `Activityville${run}`;
const SEARCH_NAME = `Watching ${run}`;
const REASON_MARK = `reason-mark-${run}`;
const ALEX = "alex.rivera@osmls.example";
const SAM = "sam.whitfield@osmls.example";

type Listing = { ListingKey: string; ListingId: string };
let db: Client;
let agent: { MemberKey: string; MemberMlsId: string; OfficeKey: string };
let staff: { MemberKey: string; MemberMlsId: string };

async function insertListing(number: string): Promise<Listing> {
  const { rows } = await db.query(
    `insert into "Property" ("StandardStatus", "PropertyType", "ListPrice", "OriginalListPrice", "ListingContractDate",
       "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode", "UnparsedAddress", "BedroomsTotal",
       "BathroomsTotalInteger", "ListAgentKey", "ListOfficeKey")
     values ('Active', 'Residential', 500000, 500000, '2026-01-05', $1, 'Watch Way', $2, 'WA', '96560', $3, 3, 2, $4, $5)
     returning "ListingKey", "ListingId"`,
    [number, CITY, `${number} Watch Way, ${CITY}, WA 96560`, agent.MemberKey, agent.OfficeKey],
  );
  return rows[0];
}

/** A change as the application records one: the listing and its history row together, here made by MLS staff. */
async function record(listing: Listing, field: "ListPrice" | "StandardStatus", previous: string, next: string) {
  await db.query("begin");
  await db.query(`update "Property" set "${field}" = $2 where "ListingKey" = $1`, [listing.ListingKey, next]);
  await db.query(
    `insert into "HistoryTransactional" ("ResourceRecordKey", "ResourceRecordID", "ClassName", "FieldName", "PreviousValue",
       "NewValue", "ChangeType", "ChangedByMemberKey", "ChangedByMemberID", "OsmlsStaffCorrection", "OsmlsCorrectionReason")
     values ($1, $2, 'Residential', $3, $4, $5, $6, $7, $8, true, $9)`,
    [listing.ListingKey, listing.ListingId, field, previous, next, field === "ListPrice" ? "Price Change" : "Status Change",
      staff.MemberKey, staff.MemberMlsId, REASON_MARK],
  );
  await db.query("commit");
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

test.beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  ({ rows: [agent] } = await db.query(`select "MemberKey", "MemberMlsId", "OfficeKey" from "Member" where "MemberEmail" = $1`, [ALEX]));
  ({ rows: [staff] } = await db.query(`select "MemberKey", "MemberMlsId" from "Member" where "MemberMlsId" = 'ST0001'`));
});
test.afterAll(() => db.end());

test("a member sees what changed for a saved search, and it stays until they mark it as seen", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const priced = await insertListing("1");
  const pending = await insertListing("2");
  const busy = await insertListing("3");

  // ---- Save a search for Active listings in the town: it starts with no activity ----
  await signIn(page, ALEX);
  await expect(page).toHaveURL(/\/search/);
  await page.goto(`/search?s=1&status=Active&city=${CITY}`);
  await expect(page.getByTestId("result-count")).toHaveText("3 listings");
  const save = page.getByTestId("save-search");
  await save.getByLabel("Name").fill(SEARCH_NAME);
  await save.getByRole("button", { name: "Save this search" }).click();
  await expect(save.getByRole("status")).toHaveText("Search saved.");
  const key = new URL(page.url()).searchParams.get("saved")!;

  const card = page.getByTestId("saved-searches").getByRole("listitem").filter({ hasText: SEARCH_NAME });
  await page.goto("/saved-searches");
  await expect(card.getByTestId("activity-count")).toHaveText("No new activity");

  // ---- Changes happen: a price, a status that takes a listing out of the search, and many on one listing ----
  await record(priced, "ListPrice", "500000", "480000");
  await record(pending, "StandardStatus", "Active", "Pending");
  for (let i = 1; i <= 11; i++) await record(busy, "ListPrice", String(500000 - (i - 1) * 1000), String(500000 - i * 1000));

  // Looking, reloading, and fetching the page without opening it change nothing.
  const activityUrl = `/saved-searches/${key}/activity`;
  for (let i = 0; i < 2; i++) {
    await page.goto("/saved-searches");
    await expect(card.getByTestId("activity-count")).toHaveText("Activity on 3 listings");
    expect((await page.request.get(activityUrl)).status()).toBe(200);
  }
  await card.getByRole("link", { name: "Activity on 3 listings" }).click();
  await expect(page.getByRole("heading", { name: `Activity: ${SEARCH_NAME}` })).toBeVisible();
  await page.reload();

  // ---- What is shown ----
  const matching = page.getByTestId("activity-matching").getByTestId("activity-listing");
  await expect(matching).toHaveCount(2);
  // Most recently changed first.
  await expect(matching.nth(0)).toContainText(busy.ListingId);
  await expect(matching.nth(0).getByTestId("omitted-events")).toHaveText("1 earlier change not shown.");
  await expect(matching.nth(0)).toContainText("List price $490,000 → $489,000");
  await expect(matching.nth(0)).not.toContainText("$500,000 → $499,000");
  await expect(matching.nth(1)).toContainText(priced.ListingId);
  await expect(matching.nth(1)).toContainText("List price $500,000 → $480,000");
  const left = page.getByTestId("activity-may-no-longer-match").getByTestId("activity-listing");
  await expect(left).toHaveCount(1);
  await expect(left).toContainText(pending.ListingId);
  await expect(left).toContainText("Status Active → Pending");
  await expect(page.getByTestId("may-no-longer-match-note")).toContainText("Only status and list price are taken from history.");

  // The whole response: the change, never who made it, that staff made it, or why.
  const body = await (await page.request.get(activityUrl)).text();
  expect(body).toContain(priced.ListingId);
  for (const hidden of [REASON_MARK, "Morgan Ellis", staff.MemberMlsId, staff.MemberKey, "orrection"]) {
    expect(body.includes(hidden), hidden).toBe(false);
  }

  // ---- Marking as seen says what else it clears, and clears only what this page was loaded with ----
  const mark = page.getByTestId("mark-seen");
  await expect(mark.getByRole("button")).toHaveText("Mark all as seen, including what is not shown");
  await expect(page.getByTestId("mark-seen-note")).toContainText("It also clears: 1 earlier change left out of the listings shown.");
  // A change arrives after the page was loaded and before the button is pressed.
  await record(priced, "ListPrice", "480000", "470000");
  await mark.getByRole("button").click();

  await expect(page.getByTestId("activity-listing")).toHaveCount(1);
  await expect(page.getByTestId("activity-listing")).toContainText("List price $480,000 → $470,000");
  await expect(page.getByTestId("activity-listing")).not.toContainText("$500,000 → $480,000");
  // Nothing is left out now, so the button and its note are the plain ones.
  await expect(page.getByTestId("mark-seen").getByRole("button")).toHaveText("Mark as seen");
  await expect(page.getByTestId("mark-seen-note")).toHaveText(
    "This clears what is shown here. Anything that changed after this page was loaded stays.",
  );
  await page.getByTestId("mark-seen").getByRole("button").click();
  await expect(page.getByTestId("no-activity")).toBeVisible();
  await page.goto("/saved-searches");
  await expect(card.getByTestId("activity-count")).toHaveText("No new activity");

  // ---- No one else can reach it ----
  await record(priced, "ListPrice", "470000", "460000");
  const sam = await contextFor(browser, SAM);
  const theirs = await sam.request.get(activityUrl);
  expect(theirs.status()).toBe(404);
  expect((await sam.request.get(`/saved-searches/${NO_SUCH_KEY}/activity`)).status()).toBe(404);
  expect(await theirs.text()).not.toContain(SEARCH_NAME);
  await sam.close();
  for (const context of [await contextFor(browser, "riley.chen@osmls.example", false), await browser.newContext()]) {
    const response = await context.request.get(activityUrl);
    expect(response.url()).toContain("/sign-in");
    expect(await response.text()).not.toContain(SEARCH_NAME);
    await context.close();
  }
  // The owner's activity was untouched by any of that.
  await page.goto("/saved-searches");
  await expect(card.getByTestId("activity-count")).toHaveText("Activity on 1 listing");
});
