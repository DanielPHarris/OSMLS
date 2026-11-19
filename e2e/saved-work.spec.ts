/*
 * Saved searches and collections through the application: one agent uses them,
 * and every other kind of account is checked for what it is sent.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const SEARCH_NAME = `Sold on the court ${run}`;
const RENAMED = `Court sales ${run}`;
const COLLECTION_NAME = `Shortlist ${run}`;
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";

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

const resultsTable = (page: Page) => page.getByRole("table").last();
const listingIds = (page: Page) => resultsTable(page).locator("tbody tr td:nth-child(3) a").allInnerTexts();

test("an agent keeps saved searches and collections, and no one else can see them", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signIn(page, "alex.rivera@osmls.example");
  await expect(page).toHaveURL(/\/search/);

  // ---- Save a search ----
  for (const box of await page.getByRole("group", { name: "Status" }).getByRole("checkbox").all()) await box.uncheck();
  await page.getByLabel("Closed", { exact: true }).check();
  await page.getByLabel("Address contains").fill("Comparable Ct");
  await page.getByLabel("Sort by").selectOption({ label: "Days on market, most first" });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("result-count")).toHaveText("8 listings");
  const byHand = await listingIds(page);

  const save = page.getByTestId("save-search");
  await save.getByLabel("Name").fill(SEARCH_NAME);
  await save.getByRole("button", { name: "Save this search" }).click();
  await expect(save.getByRole("status")).toHaveText("Search saved.");
  await expect(save.getByRole("heading")).toHaveText(`Saved search: ${SEARCH_NAME}`);
  const savedKey = new URL(page.url()).searchParams.get("saved")!;
  expect(savedKey).toMatch(/^[0-9a-f-]{36}$/);

  // The same name again is refused.
  await save.getByLabel("Save as a new search named").fill(SEARCH_NAME.toUpperCase());
  await save.getByRole("button", { name: "Save this search" }).click();
  await expect(save.getByRole("alert")).toHaveText("Choose a different name.");

  // ---- Run it: the same listings in the same order as the search done by hand ----
  await page.getByRole("link", { name: "Saved searches" }).first().click();
  const saved = page.getByTestId("saved-searches").getByRole("listitem").filter({ hasText: SEARCH_NAME });
  await expect(saved).toContainText("Closed");
  await expect(saved).toContainText("Comparable Ct");
  await saved.getByRole("link", { name: "Run" }).click();
  await expect(page).toHaveURL(/ran=1/);
  await expect(page.getByTestId("result-count")).toHaveText("8 listings");
  expect(await listingIds(page)).toEqual(byHand);
  await expect(page.getByTestId("ignored-criteria")).toHaveCount(0);

  // ---- Change the criteria and update the saved search ----
  await page.getByLabel("Minimum close price").fill("630000");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("result-count")).toHaveText("3 listings");
  await page.getByRole("button", { name: `Update “${SEARCH_NAME}” with these criteria` }).click();
  await expect(page.getByTestId("save-search").getByRole("status")).toHaveText("Saved search updated.");
  await page.goto(`/saved-searches/${savedKey}/run`);
  await expect(page.getByTestId("result-count")).toHaveText("3 listings");

  // ---- A saved search whose criteria are no longer valid says what it ignored ----
  const database = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await database.connect();
  await database.query(`update "SavedSearch" set "OsmlsCriteria" = $1::jsonb where "SavedSearchKey" = $2`, [
    JSON.stringify({ address: "Comparable Ct", statuses: ["Closed", "Sold"], sort: "by_magic" }),
    savedKey,
  ]);
  await database.end();
  await page.goto(`/saved-searches/${savedKey}/run`);
  const ignored = page.getByTestId("ignored-criteria");
  await expect(ignored).toContainText("one status");
  await expect(ignored).toContainText("sort order");
  await expect(ignored).not.toContainText("Sold");
  await expect(page.getByTestId("result-count")).toHaveText("8 listings");
  // Once the member searches again, the notice has done its job.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("ignored-criteria")).toHaveCount(0);

  // ---- Rename ----
  await page.goto("/saved-searches");
  await page.getByLabel(`New name for ${SEARCH_NAME}`).fill(RENAMED);
  await page.getByTestId("saved-searches").getByRole("listitem").filter({ hasText: SEARCH_NAME }).getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("link", { name: RENAMED, exact: true })).toBeVisible();

  // ---- Collections ----
  await page.getByRole("link", { name: "Collections" }).first().click();
  await page.getByLabel("New collection name").fill(COLLECTION_NAME);
  await page.getByRole("button", { name: "Create collection" }).click();
  const collectionLink = page.getByTestId("collections").getByRole("link", { name: COLLECTION_NAME });
  await expect(collectionLink).toBeVisible();
  const collectionKey = (await collectionLink.getAttribute("href"))!.split("/").pop()!;

  // Add two from search results.
  await page.goto(`/saved-searches/${savedKey}/run`);
  const [firstId, secondId] = await listingIds(page);
  await page.getByLabel(`Tick ${firstId} to add to a collection`).check();
  await page.getByLabel(`Tick ${secondId} to add to a collection`).check();
  await page.getByLabel("Add ticked listings to").selectOption({ label: COLLECTION_NAME });
  await page.getByRole("button", { name: "Add to collection" }).click();
  await expect(page.getByText("Added 2 listings.")).toBeVisible();
  // Adding them again is not an error.
  await page.getByLabel(`Tick ${firstId} to add to a collection`).check();
  await page.getByLabel("Add ticked listings to").selectOption({ label: COLLECTION_NAME });
  await page.getByRole("button", { name: "Add to collection" }).click();
  await expect(page.getByText("Already in that collection.")).toBeVisible();

  // Add a third from its own page.
  await page.goto("/search?s=1&address=1+Comparable+Ct&status=Active");
  await resultsTable(page).getByRole("link").first().click();
  const listingPath = new URL(page.url()).pathname;
  const mine = page.getByTestId("listing-collections");
  await mine.getByRole("button", { name: `Add to ${COLLECTION_NAME}` }).click();
  await expect(mine.getByRole("listitem").filter({ hasText: COLLECTION_NAME })).toContainText("In this collection");

  // The collection lists all three in the order they were added, as they are today.
  await page.goto(`/collections/${collectionKey}`);
  const entries = page.getByTestId("collection-listings").locator("tbody tr");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText(firstId);
  await expect(entries.nth(1)).toContainText(secondId);
  await expect(entries.nth(2)).toContainText("1 Comparable Ct");
  await expect(entries.nth(0)).toContainText(/Closed \$/);
  await page.getByRole("button", { name: `Remove ${secondId} from this collection` }).click();
  await expect(entries).toHaveCount(2);

  // ---- No one else is sent any of it ----
  const secrets = [SEARCH_NAME, RENAMED, COLLECTION_NAME, savedKey, collectionKey];
  const others: [string, string][] = [
    ["an agent in the same office", "jordan.okafor@osmls.example"],
    ["an agent in another office", "sam.whitfield@osmls.example"],
    ["MLS staff", "morgan.ellis@osmls.example"],
  ];
  for (const [label, email] of others) {
    const context = await contextFor(browser, email);
    for (const path of ["/saved-searches", "/collections", `/search?saved=${savedKey}`, `/search?saved=${savedKey}&ran=1`, listingPath]) {
      const html = await (await context.request.get(path)).text();
      // A key the requester typed into the address comes back in the page's own
      // address; that tells them nothing. What must not appear is anything they did not supply.
      const mustBeAbsent = secrets.filter((secret) => !path.includes(secret));
      for (const secret of mustBeAbsent) expect(html.includes(secret), `${label}: "${secret}" in ${path}`).toBe(false);
      // Nor is the page any different for the owner's key than for a key never issued.
      if (path.includes(savedKey)) {
        const forNothing = await (await context.request.get(path.replace(savedKey, NO_SUCH_KEY))).text();
        expect(html.includes("Saved search:"), `${label}: saved-search banner in ${path}`).toBe(false);
        expect(html.includes("Update “"), `${label}: update button in ${path}`).toBe(false);
        expect(forNothing.includes("Saved search:")).toBe(false);
      }
    }
    // Asked for directly, it answers exactly as something that does not exist.
    for (const path of [`/collections/KEY`, `/saved-searches/KEY/run`]) {
      const theirs = await context.request.get(path.replace("KEY", path.includes("collections") ? collectionKey : savedKey), { maxRedirects: 0 });
      const nothing = await context.request.get(path.replace("KEY", NO_SUCH_KEY), { maxRedirects: 0 });
      expect(theirs.status(), `${label}: ${path}`).toBe(404);
      expect(nothing.status(), `${label}: ${path} for a key never issued`).toBe(404);
      const body = await theirs.text();
      for (const secret of [SEARCH_NAME, RENAMED, COLLECTION_NAME]) expect(body.includes(secret), `${label}: body of ${path}`).toBe(false);
    }
    await context.close();
  }

  // A suspended account and a signed-out visitor are sent to sign in, and get nothing.
  const refused: [string, BrowserContext][] = [
    ["a suspended agent", await contextFor(browser, "riley.chen@osmls.example", false)],
    ["suspended MLS staff", await contextFor(browser, "casey.morgan@osmls.example", false)],
    ["a signed-out visitor", await browser.newContext()],
  ];
  for (const [label, context] of refused) {
    for (const path of ["/saved-searches", "/collections", `/collections/${collectionKey}`, `/saved-searches/${savedKey}/run`]) {
      const response = await context.request.get(path);
      expect(response.url(), `${label}: ${path}`).toContain("/sign-in");
      const html = await response.text();
      for (const secret of secrets) expect(html.includes(secret), `${label}: "${secret}" in ${path}`).toBe(false);
    }
    await context.close();
  }

  // ---- The owner still has everything, and can delete it ----
  await page.goto(`/collections/${collectionKey}`);
  await expect(entries).toHaveCount(2);
  await page.getByRole("button", { name: "Delete collection" }).click();
  await expect(page).toHaveURL(/\/collections\?notice=collection-deleted/);
  await expect(page.getByRole("status")).toContainText("The listings themselves are unchanged.");
  expect((await page.request.get(`/collections/${collectionKey}`)).status()).toBe(404);
  // The listing it held is still there.
  expect((await page.request.get(listingPath)).status()).toBe(200);

  await page.goto("/saved-searches");
  await page.getByRole("button", { name: `Delete ${RENAMED}` }).click();
  await expect(page.getByRole("link", { name: RENAMED, exact: true })).toHaveCount(0);
  expect((await page.request.get(`/saved-searches/${savedKey}/run`, { maxRedirects: 0 })).status()).toBe(404);
});
