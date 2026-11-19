/*
 * Market research against the seeded demo data: finding sold listings, reading
 * days on market, and pulling comparables. The seed puts a street of similar
 * homes on "Comparable Ct" and relisting examples on "Relist Rd".
 */
import { expect, test, type Page } from "@playwright/test";

const password = process.env.DEMO_PASSWORD!;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
}

async function searchFor(page: Page, address: string, status: string) {
  await page.goto("/search");
  for (const box of await page.getByRole("group", { name: "Status" }).getByRole("checkbox").all()) await box.uncheck();
  await page.getByLabel(status, { exact: true }).check();
  await page.getByLabel("Address contains").fill(address);
}

test("an agent researches sold listings, days on market, and comparables", async ({ page }) => {
  await signIn(page, "sam.whitfield@osmls.example");

  // ---- Sold listings by close date, sorted by days on market ----
  await searchFor(page, "Comparable Ct", "Closed");
  await page.getByLabel("Closed on or after").fill(daysAgo(200));
  await page.getByLabel("Sort by").selectOption({ label: "Days on market, most first" });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/closedFrom=/);

  const rows = page.getByRole("table").last().locator("tbody tr");
  // Seven sold on the street in the last 200 days; the one sold 290 days ago is left out.
  await expect(rows).toHaveCount(7);
  await expect(page.getByRole("table").last()).not.toContainText("15 Comparable Ct");
  await expect(rows.first()).toContainText(/Closed \$[\d,]+ on /);
  const dom = (await page.getByTestId("market-time").allInnerTexts()).map((t) => Number(t.split("/")[0]));
  expect(dom).toEqual([...dom].sort((a, b) => b - a));
  expect(new Set(dom).size).toBeGreaterThan(1);
  // The home that fell out of contract counts its two stretches, not the time between.
  await expect(rows.filter({ hasText: "13 Comparable Ct" }).getByTestId("market-time")).toHaveText("20 / 20");

  // A close price range narrows it further.
  await page.getByLabel("Minimum close price").fill("630000");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(rows).toHaveCount(3);

  // ---- The subject listing: time on market, timeline, comparables ----
  await searchFor(page, "1 Comparable Ct", "Active");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("table").last().getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("1 Comparable Ct");
  await expect(page.getByTestId("dom")).toHaveText("12");
  await expect(page.getByTestId("cdom")).toHaveText("12");
  await expect(page.getByTestId("timeline")).toContainText("Listed");
  // The member timeline names no one; full history is for staff.
  await expect(page.getByTestId("timeline")).not.toContainText("Rivera");
  await expect(page.getByTestId("history-table")).toHaveCount(0);

  await page.getByRole("link", { name: "Find comparables" }).click();
  const comparables = page.getByTestId("comparables");
  for (const number of [3, 5, 7, 9, 11, 13]) await expect(comparables).toContainText(`${number} Comparable Ct`);
  // Not the subject, not the sale from long ago, not the much larger home.
  await expect(comparables.getByRole("row").filter({ hasText: /^.*\b1 Comparable Ct/ })).toHaveCount(0);
  await expect(comparables).not.toContainText("15 Comparable Ct");
  await expect(comparables).not.toContainText("17 Comparable Ct");
  await expect(page.getByTestId("median-close-price")).toHaveText(/^\$[\d,]+$/);
  await expect(page.getByTestId("comparables-summary")).toContainText("not an estimate of this property's value");
  await expect(comparables).toContainText(/0\.\d\d mi/);

  // Widening the size range brings in the larger home.
  await page.getByLabel("Similar living area").uncheck();
  await page.getByLabel("Similar bedrooms").uncheck();
  await page.getByRole("button", { name: "Find comparables" }).click();
  await expect(comparables).toContainText("17 Comparable Ct");

  // Narrowing to almost nothing leaves too few to summarise.
  await page.getByLabel("Closed within (days)").fill("1");
  await page.getByRole("button", { name: "Find comparables" }).click();
  await expect(page.getByTestId("too-few")).toBeVisible();
  await expect(page.getByTestId("median-close-price")).toHaveCount(0);

  // ---- A relisting carries the earlier count forward ----
  await searchFor(page, "10 Relist Rd", "Active");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("market-time")).toHaveText("30 / 90");
  await rows.getByRole("link").first().click();
  await expect(page.getByTestId("dom")).toHaveText("30");
  await expect(page.getByTestId("cdom")).toHaveText("90");
  await expect(page.getByTestId("market")).toContainText("includes earlier listings of this property");

  // After a long gap, or a sale, the count starts again.
  for (const [address, days] of [["20 Relist Rd", "60"], ["30 Relist Rd", "20"]]) {
    await searchFor(page, address, "Active");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("market-time")).toHaveText(`${days} / ${days}`);
  }
});

test("market research is refused to signed-out visitors and suspended accounts", async ({ page, browser }) => {
  await signIn(page, "sam.whitfield@osmls.example");
  await searchFor(page, "1 Comparable Ct", "Active");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const href = await page.getByRole("table").last().getByRole("link").first().getAttribute("href");
  const comparablesPath = `${href}/comparables`;

  const signedOut = await browser.newContext();
  const refused = await signedOut.request.get(comparablesPath);
  expect(refused.url()).toContain("/sign-in");
  expect(await refused.text()).not.toContain("Comparable Ct");
  await signedOut.close();

  const suspended = await browser.newContext();
  const suspendedPage = await suspended.newPage();
  await suspendedPage.goto("/sign-in");
  await suspendedPage.getByLabel("Email").fill("riley.chen@osmls.example");
  await suspendedPage.getByLabel("Password").fill(password);
  await suspendedPage.getByRole("button", { name: "Sign in" }).click();
  await expect(suspendedPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const alsoRefused = await suspended.request.get(comparablesPath);
  expect(alsoRefused.url()).toContain("/sign-in");
  expect(await alsoRefused.text()).not.toContain("Comparable Ct");
  await suspended.close();
});
