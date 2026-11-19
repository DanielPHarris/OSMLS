/*
 * Map search: an agent pins a listing on the map, then finds it by searching the
 * visible map area. Uses a blank local map style (see playwright.config.ts), so it
 * does not depend on an outside map service.
 */
import { expect, test, type Page } from "@playwright/test";

const password = process.env.DEMO_PASSWORD!;

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
}

async function fillRequired(page: Page, street: string) {
  await page.getByLabel("List price").fill("450000");
  await page.getByLabel("Street number").fill("9");
  await page.getByLabel("Street name").fill(street);
  await page.getByLabel("City").fill("Port Alder");
  await page.getByLabel("State").fill("WA");
  await page.getByLabel("ZIP code").fill("98001");
  await page.getByLabel("Bedrooms").fill("2");
  await page.getByLabel("Bathrooms").fill("1");
}

const mapReady = (page: Page, testId: string) =>
  expect(page.getByTestId(testId)).toHaveAttribute("data-map-status", "ready", { timeout: 20_000 });

test("an agent pins a listing and finds it by searching the map area", async ({ page }) => {
  const street = `Map Test Ln ${Date.now()}`;
  await signIn(page, "alex.rivera@osmls.example");

  // --- Place the pin while entering the listing ---
  await page.goto("/listings/new");
  await fillRequired(page, street);
  await mapReady(page, "location-map");
  const latitude = page.getByLabel("Latitude", { exact: true });
  const longitude = page.getByLabel("Longitude", { exact: true });
  await expect(latitude).toHaveValue("");
  await page.getByTestId("location-map").click({ position: { x: 200, y: 140 } });
  await expect(latitude).toHaveValue(/^47\.\d{6}$/);
  await expect(longitude).toHaveValue(/^-122\.\d{6}$/);

  // Half a location is refused, and what was typed is kept.
  await longitude.fill("");
  await page.getByRole("button", { name: "Create listing" }).click();
  await expect(page.getByText("A location needs both latitude and longitude.")).toBeVisible();
  await expect(page.getByLabel("Street name")).toHaveValue(street);

  // Typing coordinates works in place of the pin.
  // (Located by name: after an error, the field's label also carries the message.)
  await page.locator('input[name="Latitude"]').fill("47.305");
  await page.locator('input[name="Longitude"]').fill("-122.255");
  await page.getByRole("button", { name: "Create listing" }).click();
  await expect(page.getByRole("status")).toContainText("Listing created.");
  const listingId = await page.getByTestId("listing-id").innerText();
  await expect(page.getByText("47.305, -122.255")).toBeVisible();

  // A second listing on the same street with no pin.
  await page.goto("/listings/new");
  await fillRequired(page, street);
  await page.getByRole("button", { name: "Create listing" }).click();
  await expect(page.getByRole("status")).toContainText("Listing created.");
  const unpinnedId = await page.getByTestId("listing-id").innerText();

  // --- Ordinary search: both listed, one on the map ---
  await page.goto(`/search?s=1&address=${encodeURIComponent(street)}`);
  await mapReady(page, "search-map");
  await expect(page.getByTestId("result-count")).toHaveText("2 listings");
  await expect(page.getByTestId("location-note")).toHaveText(
    "1 matching listing has no map location and is not on the map.",
  );
  const unpinnedRow = page.getByRole("row").filter({ hasText: unpinnedId });
  await expect(unpinnedRow).toContainText("Location unavailable");
  await expect(page.getByRole("row").filter({ hasText: listingId })).not.toContainText("Location unavailable");

  // The marker is a button: reach it and open it from the keyboard.
  const marker = page.getByRole("button", { name: new RegExp(`^${listingId}, 9 ${street}`) });
  await expect(marker).toHaveCount(1);
  await expect(page.locator(".osmls-pin")).toHaveCount(1);
  await marker.focus();
  await page.keyboard.press("Enter");
  const popup = page.locator(".maplibregl-popup");
  await expect(popup).toContainText("$450,000 · Active");
  await expect(popup.getByRole("link", { name: listingId })).toHaveAttribute("href", /\/listings\/[0-9a-f-]{36}$/);

  // The style's credit line is shown in full, not collapsed behind a button.
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("No base map");
  await expect(page.locator(".maplibregl-ctrl-attrib")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(page.locator(".maplibregl-ctrl-attrib-inner")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });

  // --- Search this area: the pinned listing stays, the unpinned one is left out ---
  await page.getByRole("button", { name: "Search this area" }).click();
  await expect(page).toHaveURL(/bounds=-?\d/);
  await expect(page.getByTestId("area-note")).toBeVisible();
  await expect(page.getByTestId("result-count")).toHaveText("1 listing");
  await expect(page.getByRole("link", { name: listingId })).toBeVisible();
  await expect(page.getByRole("link", { name: unpinnedId })).toHaveCount(0);
  await expect(page.getByTestId("location-note")).toHaveText(
    "1 matching listing with no map location was left out, because it cannot be placed inside the area.",
  );

  // The area is in the URL, so the search survives a reload, and other filters still apply.
  await page.reload();
  await expect(page.getByTestId("result-count")).toHaveText("1 listing");
  await page.getByLabel("Maximum price").fill("400000");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/bounds=/);
  await expect(page.getByTestId("result-count")).toHaveText("No listings match.");

  // An area somewhere else finds nothing; clearing the area brings both back.
  await page.goto(`/search?s=1&address=${encodeURIComponent(street)}&bounds=0,0,1,1`);
  await expect(page.getByTestId("result-count")).toHaveText("No listings match.");
  await page.getByRole("link", { name: "Clear area" }).click();
  await expect(page.getByTestId("result-count")).toHaveText("2 listings");
});

test("searching an area from the first view keeps the default statuses", async ({ page }) => {
  await signIn(page, "sam.whitfield@osmls.example");
  await mapReady(page, "search-map");
  await expect(page.getByLabel("Active", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Closed", { exact: true })).not.toBeChecked();

  await page.getByRole("button", { name: "Search this area" }).click();
  await expect(page).toHaveURL(/bounds=/);
  await expect(page).toHaveURL(/status=Active/);
  await expect(page.getByLabel("Active", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Coming Soon")).toBeChecked();
  await expect(page.getByLabel("Closed", { exact: true })).not.toBeChecked();
  await expect(page.getByRole("table")).not.toContainText("Closed");
});

test("pins still show when the map's tiles cannot be loaded", async ({ page }) => {
  // The style arrives, but every tile request fails.
  await page.route("**/blank-map-style.json", (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: { base: { type: "raster", tiles: ["http://localhost:1/{z}/{x}/{y}.png"], tileSize: 256, attribution: "Test tiles" } },
        layers: [{ id: "base", type: "raster", source: "base" }],
      },
    }),
  );
  await signIn(page, "sam.whitfield@osmls.example");
  await mapReady(page, "search-map");
  await expect(page.locator(".osmls-pin").first()).toBeVisible();
  await expect(page.getByText("The map is unavailable right now.")).toHaveCount(0);
});

test("search still works when the map service cannot be reached", async ({ page }) => {
  await signIn(page, "sam.whitfield@osmls.example");
  await page.route("**/blank-map-style.json", (route) => route.abort());
  await page.goto("/search");
  await expect(page.getByText("The map is unavailable right now.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("table")).toContainText("Port Alder");
  await page.getByLabel("City").fill("Cedar Hollow");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("Cedar Hollow");
  await expect(page.getByRole("table")).not.toContainText("Port Alder");

  // The listing form still takes typed coordinates.
  await page.goto("/listings/new");
  await expect(page.getByText("The map is unavailable right now. You can still type the coordinates")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('input[name="Latitude"]')).toBeEditable();
});
