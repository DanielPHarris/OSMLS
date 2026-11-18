/*
 * The version 0.1 workflow, end to end: an agent creates a listing, another
 * agent finds it, and MLS staff inspect its history and correct it.
 * Runs on the test database, which `pnpm test:e2e` creates and seeds.
 */
import { expect, test, type Page } from "@playwright/test";

const password = process.env.DEMO_PASSWORD!;
// A 1x1 PNG.
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
}

test("agent creates a listing, another agent finds it, staff inspect its history", async ({ page }) => {
  const street = `Workflow Test Rd ${Date.now()}`;

  // --- Listing agent enters the listing ---
  await signIn(page, "alex.rivera@osmls.example");
  await page.getByRole("link", { name: "New listing" }).click();

  // Required fields and validation are enforced.
  await page.getByRole("button", { name: "Create listing" }).click();
  await expect(page.getByText("Some fields need attention.")).toBeVisible();
  await expect(page.getByText("Street name is required.")).toBeVisible();

  await page.getByLabel("List price").fill("525000");
  await page.getByLabel("Street number").fill("42");
  await page.getByLabel("Street name").fill(street);
  await page.getByLabel("City").fill("Port Alder");
  await page.getByLabel("State").fill("WA");
  await page.getByLabel("ZIP code").fill("98001");
  await page.getByLabel("Bedrooms").fill("3");
  await page.getByLabel("Bathrooms").fill("2");
  await page.getByLabel("Public remarks").fill("Synthetic listing created by the automated workflow test.");
  await page.getByRole("button", { name: "Create listing" }).click();

  await expect(page.getByRole("status")).toContainText("Listing created.");
  const listingId = await page.getByTestId("listing-id").innerText();
  expect(listingId).toMatch(/^OS\d+$/);
  // The listing agent does not see the staff-only history.
  await expect(page.getByTestId("history-table")).toHaveCount(0);

  // Add a photo, then change the price.
  await page.getByRole("link", { name: "Edit listing" }).click();
  await page.getByLabel("Add a photo").setInputFiles({ name: "front.png", mimeType: "image/png", buffer: photo });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("img", { name: "Photo 1" })).toBeVisible();

  // Only permitted status changes are offered: an active listing cannot jump to Closed.
  const statusOptions = await page.getByLabel("Status").locator("option").allInnerTexts();
  expect(statusOptions).toContain("Pending");
  expect(statusOptions).not.toContain("Closed");

  await page.getByLabel("List price").fill("510000");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved.");
  await expect(page.getByTestId("list-price")).toHaveText("$510,000");
  await signOut(page);

  // --- Another agent finds it ---
  await signIn(page, "sam.whitfield@osmls.example");
  await page.getByLabel("Listing number").fill(listingId);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByTestId("result-count")).toHaveText("1 listing");
  await page.getByRole("link", { name: listingId }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText(street);
  await expect(page.getByTestId("list-price")).toHaveText("$510,000");
  await expect(page.getByText("Alex Rivera")).toBeVisible();
  await expect(page.getByText("Harborview Realty (Demo)")).toBeVisible();
  const img = page.getByRole("img", { name: /Photo 1 of/ });
  await expect(img).toBeVisible();
  // The photo really loads for a signed-in member.
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const photoUrl = (await img.getAttribute("src"))!;
  expect((await page.request.get(photoUrl)).headers()["content-type"]).toBe("image/png");
  // Not their listing: no edit, no history.
  await expect(page.getByRole("link", { name: "Edit listing" })).toHaveCount(0);
  await expect(page.getByTestId("history-table")).toHaveCount(0);
  const listingUrl = page.url();
  await page.goto(`${listingUrl}/edit`);
  await expect(page).toHaveURL(listingUrl);

  // It also turns up in a field search.
  await page.goto("/search");
  await page.getByLabel("Address contains").fill(street);
  await page.getByLabel("City").fill("Port Alder");
  await page.getByLabel("Minimum price").fill("500000");
  await page.getByLabel("Maximum price").fill("520000");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: listingId })).toBeVisible();
  await signOut(page);

  // --- MLS staff inspect the history ---
  await signIn(page, "morgan.ellis@osmls.example");
  await page.goto(listingUrl);
  const history = page.getByTestId("history-table");
  await expect(history).toBeVisible();
  const row = (text: string | RegExp) => history.getByRole("row").filter({ hasText: text });
  await expect(row("New Listing")).toContainText("Alex Rivera");
  await expect(row("Price Change")).toContainText("$525,000");
  await expect(row("Price Change")).toContainText("$510,000");
  await expect(row("Price Change")).toContainText("AG1001");
  await expect(row("Photo 1 added")).toContainText("Alex Rivera");

  // A staff correction needs a reason and is recorded as a correction.
  await page.getByRole("link", { name: "Correct listing" }).click();
  await page.getByLabel("Bedrooms").fill("4");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Explain why this correction is being made.")).toBeVisible();
  await expect(page.getByLabel("Bedrooms")).toHaveValue("4");
  await page.getByLabel("Reason for this correction").fill("Bedroom count verified against county record.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved.");
  const correction = row("Staff correction");
  await expect(correction).toContainText("Morgan Ellis");
  await expect(correction).toContainText("Bedroom count verified against county record.");
  await expect(correction).toContainText("Bedrooms Total");
  await signOut(page);

  // Signed out, the listing and its photo are not reachable.
  await page.goto(listingUrl);
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await page.request.get(photoUrl)).status()).toBe(401);
});
