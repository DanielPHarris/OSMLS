/*
 * Staff permissions and the market-time settings, through the running
 * application with no restart: an administrator narrows a colleague to "Manage
 * settings"; the colleague, in a session that was already open, changes a
 * setting and the figures change everywhere they are shown; the colleague is
 * refused the Members screens; and once the capability is revoked, the same
 * open session is refused its next change.
 *
 * This changes the settings every other test's figures depend on, so it runs
 * after all of them (see playwright.config.ts) and puts the settings back.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const password = process.env.DEMO_PASSWORD!;
const ADMIN = "morgan.ellis@osmls.example";
const COLLEAGUE = "taylor.brooks@osmls.example";
const ALL = ["Manage members", "Manage offices", "Manage settings", "Manage compliance", "Manage data access", "Import listings", "Manage staff"];

let db: Client;
test.beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
});
test.afterAll(() => db.end());

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
}

async function setCapabilities(admin: Page, held: string[], reason: string) {
  await admin.goto("/admin/members?q=Brooks");
  await admin.getByRole("link", { name: "Taylor Brooks" }).click();
  const form = admin.getByTestId("member-capabilities");
  for (const label of ALL) await form.getByLabel(label).setChecked(held.includes(label));
  await form.getByLabel("Reason for the change").fill(reason);
  await form.getByRole("button", { name: "Save capabilities" }).click();
  await expect(form.getByRole("status")).toContainText("Capabilities saved");
}

async function saveGap(page: Page, days: string, reason: string) {
  const form = page.getByTestId("settings-form");
  await form.getByLabel("Relisting gap (days)").fill(days);
  await form.getByLabel("Reason for the change").fill(reason);
  await form.getByLabel("I understand this changes the figures shown for past listings.").check();
  await form.getByRole("button", { name: "Save settings" }).click();
}

/** The relisted demo listing: 30 days of its own, after an earlier listing's 60, relisted 10 days later. */
async function relistedFigures(page: Page) {
  await page.goto("/search");
  for (const box of await page.getByRole("group", { name: "Status" }).getByRole("checkbox").all()) await box.uncheck();
  await page.getByLabel("Active", { exact: true }).check();
  await page.getByLabel("Address contains").fill("10 Relist Rd");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("market-time")).toHaveCount(1);
  return page.getByTestId("market-time");
}

test("a staff member given only Manage settings changes a setting, and loses the power in the session already open", async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await (await browser.newContext()).newPage();
  const colleague = await (await browser.newContext()).newPage();
  // The colleague is signed in before anything about them changes.
  await signIn(colleague, COLLEAGUE);
  await signIn(admin, ADMIN);

  try {
    // ---- 1. The administrator leaves the colleague with Manage settings only ----
    await setCapabilities(admin, ["Manage settings"], "Proof: settings only");

    // ---- 2. The colleague, in the session already open, changes the relisting gap ----
    await expect(await relistedFigures(colleague)).toHaveText("30 / 90");
    await colleague.goto("/search");
    await expect(colleague.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(colleague.getByRole("link", { name: "Members" })).toHaveCount(0);
    await expect(colleague.getByRole("link", { name: "Offices" })).toHaveCount(0);
    await colleague.getByRole("link", { name: "Settings" }).click();
    await expect(colleague.getByTestId("settings-version")).toHaveText("1");
    await expect(colleague.getByTestId("recalculation-notice")).toContainText("every listing, past and present");
    await saveGap(colleague, "5", "Proof: shorter relisting gap");
    await expect(colleague.getByTestId("settings-form").getByRole("status")).toContainText("Settings saved");
    await expect(colleague.getByTestId("settings-version")).toHaveText("2");

    // ---- 3. The cumulative figure changes in search results, on the listing, and in an agent report ----
    const inSearch = await relistedFigures(colleague);
    await expect(inSearch).toHaveText("30 / 30");
    await colleague.locator("tr", { has: inSearch }).getByRole("link").first().click();
    await expect(colleague.getByTestId("dom")).toHaveText("30");
    await expect(colleague.getByTestId("cdom")).toHaveText("30");
    const listingKey = colleague.url().split("/listings/")[1].split(/[/?#]/)[0];
    await colleague.goto(`/reports/listing/${listingKey}?copy=agent`);
    await expect(colleague.getByTestId("report-copy-label")).toContainText("Agent copy");
    await expect(colleague.locator("body")).toContainText("30 (cumulative 30)");

    // ---- 4. The change is on the record, with old and new value, who, and why ----
    await colleague.goto("/admin/settings");
    const newest = colleague.getByTestId("settings-history").locator("tbody tr").first();
    await expect(newest).toContainText("Relisting gap (days): 30 → 5");
    await expect(newest).toContainText("Taylor Brooks");
    await expect(newest).toContainText("Proof: shorter relisting gap");

    // ---- 5. The colleague has no Members or Offices screens ----
    for (const path of ["/admin/members", "/admin/offices"]) {
      const response = await colleague.goto(path);
      expect(response?.status(), path).toBe(404);
    }

    // ---- 6. Revoked: the form the colleague still has open is refused ----
    await colleague.goto("/admin/settings");
    await expect(colleague.getByTestId("settings-version")).toHaveText("2");
    await setCapabilities(admin, [], "Proof: revoked");
    await saveGap(colleague, "45", "Proof: should be refused");
    await expect(colleague.getByTestId("settings-form")).toHaveCount(0);
    const { rows } = await db.query(`select "Version", "RelistingGapDays" from "OsmlsMarketTimeSettings" order by "Version" desc limit 1`);
    expect(rows[0]).toEqual({ Version: 2, RelistingGapDays: 5 });
    expect((await colleague.goto("/admin/settings"))?.status()).toBe(404);
  } finally {
    // Put back what the other tests and the next run rely on.
    await admin.goto("/admin/settings");
    if ((await admin.getByLabel("Relisting gap (days)").inputValue()) !== "30") {
      await saveGap(admin, "30", "Proof: restored");
      await expect(admin.getByTestId("settings-form").getByRole("status")).toContainText("Settings saved");
    }
    await setCapabilities(admin, ALL, "Proof: restored");
  }
  await expect(await relistedFigures(admin)).toHaveText("30 / 90");
});

test("a staff member who manages members sees staff accounts but cannot change them", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  const colleague = await (await browser.newContext()).newPage();
  await signIn(colleague, COLLEAGUE);
  await signIn(admin, ADMIN);
  try {
    await setCapabilities(admin, ["Manage members"], "Proof: members only");

    await colleague.goto("/admin/members?q=Ellis");
    await expect(colleague.getByRole("link", { name: "Offices" })).toHaveCount(0);
    await expect(colleague.getByRole("link", { name: "Settings" })).toHaveCount(0);
    // They can add agents, and are not offered the choice of adding staff.
    await expect(colleague.getByTestId("add-member").getByLabel("Role").locator("option")).toHaveText(["Agent"]);

    // A staff account: on view, with nothing to change it by.
    await colleague.getByRole("link", { name: "Morgan Ellis" }).click();
    await expect(colleague.getByTestId("member-read-only")).toContainText("takes the Manage staff capability");
    for (const section of ["member-details", "member-sign-in", "member-capabilities"]) await expect(colleague.getByTestId(section)).toHaveCount(0);
    await expect(colleague.getByRole("button", { name: /Suspend access|Make MLS staff/ })).toHaveCount(0);

    // An agent: everything but the role.
    await colleague.goto("/admin/members?q=Whitfield");
    await colleague.getByRole("link", { name: "Sam Whitfield" }).click();
    await expect(colleague.getByTestId("member-details").getByLabel("First name")).toBeVisible();
    await expect(colleague.getByTestId("member-details").getByLabel("Role")).toHaveCount(0);
    await expect(colleague.getByTestId("member-sign-in")).toBeVisible();
    await expect(colleague.getByRole("button", { name: "Suspend access" })).toBeVisible();
  } finally {
    await setCapabilities(admin, ALL, "Proof: restored");
  }
});

