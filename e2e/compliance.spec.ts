/*
 * The compliance workflow through the running application, with no restart: an
 * agent flags a listing whose cumulative days on market counts an earlier
 * listing it should not; compliance staff find the flag, say the listing
 * continues no earlier listing, and the figure changes everywhere it is shown;
 * putting it back to automatic restores the figure; the flag is resolved; and
 * each kind of viewer sees what they should of it and no more.
 *
 * This changes a figure other tests check, so it runs after all of them (see
 * playwright.config.ts) and puts the listing back.
 */
import { expect, test, type Page } from "@playwright/test";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const DESCRIPTION = `Proof ${run}: this counts an earlier listing of a different property.`;
const NOTE = `Proof ${run}: unlinked from the earlier listing.`;
const CAPABILITIES = ["Manage members", "Manage offices", "Manage settings", "Manage compliance", "Manage data access", "Import listings", "Manage staff"];
// Who raised the flag: nothing of this may reach the listing side.
const REPORTER = { email: "alex.rivera@osmls.example", traces: ["Alex", "Rivera", "AG1001", "alex.rivera"] };

async function signedIn(browser: import("@playwright/test").Browser, email: string) {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
  return page;
}

/** The relisted demo listing in search results: 30 days of its own, after an earlier listing's 60. */
async function inSearch(page: Page) {
  await page.goto("/search");
  for (const box of await page.getByRole("group", { name: "Status" }).getByRole("checkbox").all()) await box.uncheck();
  await page.getByLabel("Active", { exact: true }).check();
  await page.getByLabel("Address contains").fill("10 Relist Rd");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("market-time")).toHaveCount(1);
  return page.getByTestId("market-time");
}

async function setLink(staff: Page, mode: "Whatever matching finds (automatic)" | "No earlier listing", reason: string) {
  const form = staff.getByTestId("relisting-link");
  await form.getByLabel(mode).check();
  await form.getByLabel("Reason").fill(reason);
  await form.getByRole("button", { name: "Save earlier listing" }).click();
  await expect(form.getByRole("status")).toContainText("Saved");
}

async function setColleagueCapabilities(admin: Page, held: string[]) {
  await admin.goto("/admin/members?q=Brooks");
  await admin.getByRole("link", { name: "Taylor Brooks" }).click();
  const form = admin.getByTestId("member-capabilities");
  for (const label of CAPABILITIES) await form.getByLabel(label).setChecked(held.includes(label));
  await form.getByLabel("Reason for the change").fill("Compliance proof");
  await form.getByRole("button", { name: "Save capabilities" }).click();
  await expect(form.getByRole("status")).toContainText("Capabilities saved");
}

test("a flagged relisting link is corrected by compliance staff, and each viewer sees only their part", async ({ browser }) => {
  test.setTimeout(180_000);
  const reporter = await signedIn(browser, REPORTER.email);
  const staff = await signedIn(browser, "morgan.ellis@osmls.example");
  let listingPath = "";

  try {
    // ---- 1. An agent flags the listing ----
    const before = await inSearch(reporter);
    await expect(before).toHaveText("30 / 90");
    await reporter.locator("tr", { has: before }).getByRole("link").first().click();
    await expect(reporter.getByTestId("cdom")).toHaveText("90");
    listingPath = new URL(reporter.url()).pathname;
    // Agents are not offered the staff tool.
    await expect(reporter.getByTestId("relisting-link")).toHaveCount(0);
    const flags = reporter.getByTestId("flags");
    await flags.getByText("Flag a problem with this listing").click();
    await flags.getByLabel("What is it about?").selectOption("Market time or relisting link");
    await flags.getByLabel("Describe the problem").fill(DESCRIPTION);
    await flags.getByRole("button", { name: "Raise flag" }).click();
    await expect(flags.getByRole("status")).toContainText("Flag raised");
    await expect(flags.getByTestId("flag")).toContainText(DESCRIPTION);
    await expect(flags.getByTestId("flag-state")).toHaveText("Open");

    // ---- 2. Compliance staff find it in the queue, with who raised it ----
    await staff.getByRole("link", { name: "Flags" }).click();
    const row = staff.getByTestId("flag-queue").locator("tbody tr", { hasText: DESCRIPTION });
    await expect(row).toContainText("Market time or relisting link");
    await expect(row).toContainText("Alex Rivera");
    await row.getByRole("link").click();
    await expect(staff).toHaveURL(new RegExp(`${listingPath}$`));

    // ---- 3 and 4. "No earlier listing": the figure changes everywhere ----
    await expect(staff.getByTestId("relisting-link-current")).toHaveText("chosen automatically");
    await setLink(staff, "No earlier listing", "Proof: a different property");
    await expect(staff.getByTestId("relisting-link-current")).toHaveText("none");
    await expect(staff.getByTestId("dom")).toHaveText("30");
    await expect(staff.getByTestId("cdom")).toHaveText("30");
    await expect(await inSearch(staff)).toHaveText("30 / 30");
    await staff.goto(`/reports/listing/${listingPath.split("/").pop()}?copy=agent`);
    await expect(staff.locator("body")).toContainText("30 (cumulative 30)");

    // ---- 5. Back to automatic restores matching; then "none" again ----
    await staff.goto(listingPath);
    await setLink(staff, "Whatever matching finds (automatic)", "Proof: checking automatic comes back");
    await expect(staff.getByTestId("relisting-link-current")).toHaveText("chosen automatically");
    await expect(staff.getByTestId("cdom")).toHaveText("90");
    await expect(await inSearch(staff)).toHaveText("30 / 90");
    await staff.goto(listingPath);
    await setLink(staff, "No earlier listing", "Proof: a different property");
    await expect(staff.getByTestId("cdom")).toHaveText("30");

    // ---- 6. Staff resolve the flag ----
    const open = staff.getByTestId("flags").getByTestId("flag").filter({ hasText: DESCRIPTION });
    await expect(open).toContainText("by Alex Rivera (AG1001");
    await open.getByLabel("Closing note").fill(NOTE);
    await open.getByRole("button", { name: "Resolve" }).click();
    await expect(open.getByTestId("flag-state")).toHaveText("Resolved");

    // ---- 7. What each of the others sees ----
    await reporter.goto(listingPath);
    const mine = reporter.getByTestId("flag").filter({ hasText: DESCRIPTION });
    await expect(mine.getByTestId("flag-state")).toHaveText("Resolved");
    await expect(mine.getByTestId("flag-closing-note")).toContainText(NOTE);
    await expect(reporter.getByTestId("cdom")).toHaveText("30");

    // The listing agent sees the flag and the note, and nothing sent to them says who raised it.
    const listingAgent = await signedIn(browser, "sam.whitfield@osmls.example");
    const response = await listingAgent.goto(listingPath);
    const theirs = listingAgent.getByTestId("flag").filter({ hasText: DESCRIPTION });
    await expect(theirs.getByTestId("flag-closing-note")).toContainText(NOTE);
    const sent = `${await response!.text()}\n${await listingAgent.content()}`;
    for (const trace of REPORTER.traces) expect(sent.includes(trace), `"${trace}" sent to the listing agent`).toBe(false);
    await expect(listingAgent.getByTestId("relisting-link")).toHaveCount(0);

    // An agent with no part in it sees no flag at all.
    const bystander = await signedIn(browser, "jordan.okafor@osmls.example");
    await bystander.goto(listingPath);
    await expect(bystander.getByTestId("flags")).toContainText("You have raised no flags on this listing.");
    await expect(bystander.getByTestId("flag")).toHaveCount(0);
    expect((await bystander.content()).includes(DESCRIPTION)).toBe(false);

    // ---- 8. Staff without the capability have no queue and no tool ----
    await setColleagueCapabilities(staff, CAPABILITIES.filter((c) => c !== "Manage compliance"));
    const colleague = await signedIn(browser, "taylor.brooks@osmls.example");
    await expect(colleague.getByRole("link", { name: "Flags" })).toHaveCount(0);
    expect((await colleague.goto("/admin/flags"))?.status()).toBe(404);
    await colleague.goto(listingPath);
    await expect(colleague.getByTestId("relisting-link")).toHaveCount(0);
    await expect(colleague.getByTestId("flag")).toHaveCount(0);
  } finally {
    // Put back what the other tests and the next run rely on.
    await setColleagueCapabilities(staff, CAPABILITIES);
    if (listingPath) {
      await staff.goto(listingPath);
      if ((await staff.getByTestId("relisting-link-current").innerText()) !== "chosen automatically") {
        await setLink(staff, "Whatever matching finds (automatic)", "Proof: restored");
      }
    }
  }
  await expect(await inSearch(staff)).toHaveText("30 / 90");
});
