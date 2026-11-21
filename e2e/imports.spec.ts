/*
 * Importing new listings through the running application: staff upload a file
 * and are shown what each row would do; nothing exists until they commit; the
 * accepted row becomes an ordinary listing under its agent, recorded as made
 * by the staff member; the agent finds it; and the same file a second time
 * creates nothing.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const STREET = `Screen Import Rd ${run}`;
const HEADER = "SourceListingId,ListAgentMlsId,StandardStatus,PropertyType,ListPrice,ListingContractDate,StreetNumber,StreetName,City,StateOrProvince,PostalCode,BedroomsTotal,BathroomsTotalInteger,PublicRemarks";
const line = (id: string, number: number, changes: { price?: string; status?: string } = {}) =>
  `${id},AG2001,${changes.status ?? "Active"},Residential,${changes.price ?? "610000"},2026-01-01,${number},${STREET},Maple Ridge,WA,98983,3,2,"Imported, through the screen"`;
const file = (lines: string[]) => ({ name: "from-screen.csv", mimeType: "text/csv", buffer: Buffer.from([HEADER, ...lines].join("\r\n")) });

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
}
async function upload(page: Page, lines: string[]) {
  await page.goto("/admin/imports");
  const form = page.getByTestId("upload-import");
  await form.getByLabel("System the file came from").fill(`Screen Source ${run}`);
  await form.getByLabel("CSV file").setInputFiles(file(lines));
  await form.getByRole("button", { name: "Upload and preview" }).click();
  await expect(page).toHaveURL(/\/admin\/imports\/[0-9a-f-]{36}$/);
}

test("staff preview an import, commit it, and the listing is an ordinary one under its agent", async ({ page, browser }) => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const listings = async () => (await db.query(`select "ListingKey", "ListingId" from "Property" where "StreetName" = $1 order by "StreetNumber"`, [STREET])).rows;
  try {
    await signIn(page, "morgan.ellis@osmls.example");
    await page.getByRole("link", { name: "Imports" }).click();
    await expect(page.getByRole("heading", { name: "Import listings" })).toBeVisible();

    // ---- A file with a valid row, an invalid row, and a repeated source identifier ----
    await upload(page, [line(`S-${run}-1`, 1), line(`S-${run}-2`, 2, { price: "-1", status: "Closed" }), line(`S-${run}-1`, 3)]);
    await expect(page.getByTestId("import-state")).toHaveText("Preview: nothing has been created");
    await expect(page.getByTestId("import-row-outcome")).toHaveText(["Refused", "Refused", "Refused"]);
    await expect(page.getByTestId("import-row").nth(0)).toContainText("is in the file more than once (rows 1, 3)");
    await expect(page.getByTestId("import-row").nth(1)).toContainText("A new listing must start as Coming Soon or Active.");
    await expect(page.getByTestId("import-accepted")).toHaveText("0 rows would create a listing.");
    await expect(page.getByRole("button", { name: /Commit/ })).toHaveCount(0);
    expect(await listings()).toEqual([]);

    // ---- The valid row alone: previewed, still nothing, then committed ----
    await upload(page, [line(`S-${run}-1`, 1)]);
    await expect(page.getByTestId("import-row-outcome")).toHaveText(["Would be created"]);
    expect(await listings()).toEqual([]);
    await page.getByRole("button", { name: "Commit: create 1 listing" }).click();
    await expect(page.getByTestId("import-state")).toHaveText("Committed");
    await expect(page.getByTestId("import-row-outcome")).toHaveText(["Created"]);
    const [created] = await listings();
    expect(await listings()).toHaveLength(1);

    // ---- An ordinary listing: under Sam Whitfield, with its history naming the import and the staff member ----
    await page.getByTestId("import-row").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/listings/${created.ListingKey}$`));
    await expect(page.locator("body")).toContainText("Sam Whitfield");
    await expect(page.getByTestId("history-origin")).toHaveText(`Imported from Screen Source ${run} (file from-screen.csv, row 1), on behalf of the listing agent.`);
    await expect(page.locator("tr", { has: page.getByTestId("history-origin") })).toContainText("Morgan Ellis");

    // ---- The agent finds it ----
    const agent = await (await browser.newContext()).newPage();
    await signIn(agent, "sam.whitfield@osmls.example");
    await agent.getByLabel("Address contains").fill(STREET);
    await agent.getByRole("button", { name: "Search", exact: true }).click();
    await expect(agent.locator("tbody tr")).toHaveCount(1);
    await expect(agent.locator("tbody tr")).toContainText(created.ListingId);
    // An agent has no import screens.
    await expect(agent.getByRole("link", { name: "Imports" })).toHaveCount(0);
    expect((await agent.goto("/admin/imports"))?.status()).toBe(404);

    // ---- The same file again creates nothing ----
    await upload(page, [line(`S-${run}-1`, 1)]);
    await expect(page.getByTestId("import-row-outcome")).toHaveText(["Refused"]);
    await expect(page.getByTestId("import-row")).toContainText(`was already imported from this source, as listing ${created.ListingId}`);
    await expect(page.getByRole("button", { name: /Commit/ })).toHaveCount(0);
    expect(await listings()).toHaveLength(1);
  } finally {
    await db.end();
  }
});
