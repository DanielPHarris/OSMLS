/*
 * The data exchange feed over HTTP, against the running application: staff add
 * a data consumer and are shown its bearer token once; the token reads the
 * service document, the metadata, and pages of records; a member's session
 * opens nothing; and revoking the consumer from the screen ends its access.
 */
import { expect, test } from "@playwright/test";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const NAME = `Feed reader ${run}`;

test("staff add a data consumer, its token reads the feed over HTTP, and revoking it ends that", async ({ page, playwright, baseURL }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("morgan.ellis@osmls.example");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);

  // ---- Staff add a data consumer; the token is shown once ----
  await page.getByRole("link", { name: "Data access" }).click();
  await expect(page.getByTestId("served-fields")).toContainText("ListingKey");
  await expect(page.getByTestId("served-fields")).not.toContainText("ShowingInstructions");
  const add = page.getByTestId("add-data-consumer");
  await add.getByLabel("Name of the system or company").fill(NAME);
  await add.getByRole("button", { name: "Add data consumer" }).click();
  await expect(add.getByRole("status")).toContainText(`${NAME} was added.`);
  const token = await add.getByTestId("bearer-token").inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.reload();
  await expect(page.getByTestId("bearer-token")).toHaveCount(0);
  expect((await page.content()).includes(token)).toBe(false);
  const row = page.getByTestId("data-consumers").locator("tbody tr", { hasText: NAME });
  await expect(row.getByTestId("data-consumer-state")).toHaveText("Active");

  // ---- An outside system: no cookies, only the token ----
  const outside = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const anonymous = await playwright.request.newContext({ baseURL });

  const service = await outside.get("/api/reso/");
  expect(service.status()).toBe(200);
  expect((await service.json()).value.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(["Property", "Member", "Office", "Media"]));

  const metadata = await outside.get("/api/reso/$metadata");
  expect(metadata.status()).toBe(200);
  expect(metadata.headers()["content-type"]).toContain("application/xml");
  expect(metadata.headers()["odata-version"]).toBe("4.0");
  const xml = await metadata.text();
  expect(xml).toContain('<EntityType Name="Property">');
  expect(xml).not.toContain("ShowingInstructions");

  // Pages of records, following the link the server gives.
  const first = await outside.get("/api/reso/Property?$select=ListingKey,ListPrice,ModificationTimestamp&$top=20&$count=true&$orderby=ListPrice desc");
  expect(first.status()).toBe(200);
  const firstPage = await first.json();
  expect(firstPage["@odata.count"]).toBeGreaterThan(40);
  expect(firstPage.value).toHaveLength(20);
  expect(Object.keys(firstPage.value[0])).toEqual(["ListingKey", "ListPrice", "ModificationTimestamp"]);
  expect(firstPage["@odata.nextLink"]).toContain("/api/reso/Property?");
  const seen = new Set<string>(firstPage.value.map((r: { ListingKey: string }) => r.ListingKey));
  let next: string | undefined = firstPage["@odata.nextLink"];
  let lastPrice: number = firstPage.value.at(-1).ListPrice;
  while (next) {
    const body = await (await outside.get(next)).json();
    for (const record of body.value) {
      expect(seen.has(record.ListingKey), "a record given twice").toBe(false);
      expect(record.ListPrice).toBeLessThanOrEqual(lastPrice);
      lastPrice = record.ListPrice;
      seen.add(record.ListingKey);
    }
    next = body["@odata.nextLink"];
  }
  // Every record, once each. Other tests may add listings while this runs, so at least the count seen first.
  expect(seen.size).toBeGreaterThanOrEqual(firstPage["@odata.count"]);

  // One record by key, and a refused field.
  const [key] = seen;
  const one = await outside.get(`/api/reso/Property('${key}')`);
  expect((await one.json()).ListingKey).toBe(key);
  const refused = await outside.get("/api/reso/Property?$select=ShowingInstructions");
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error.code).toBe("BadRequest");

  // ---- Neither no credentials nor a signed-in member's session opens the feed ----
  for (const path of ["/api/reso/", "/api/reso/$metadata", "/api/reso/Property"]) {
    expect((await anonymous.get(path)).status(), `anonymous ${path}`).toBe(401);
    expect((await page.request.get(path)).status(), `member session ${path}`).toBe(401);
  }

  // ---- Revoked from the screen ----
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row.getByTestId("data-consumer-state")).toHaveText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  for (const path of ["/api/reso/", "/api/reso/$metadata", "/api/reso/Property"]) expect((await outside.get(path)).status(), `revoked ${path}`).toBe(401);
  await outside.dispose();
  await anonymous.dispose();
});

test("the data access screen is for staff who hold Manage data access", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("alex.rivera@osmls.example");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
  await expect(page.getByRole("link", { name: "Data access" })).toHaveCount(0);
  expect((await page.goto("/admin/data-access"))?.status()).toBe(404);
});
