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
  await add.getByLabel("Feed").selectOption("full");
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
  expect((await service.json()).value.map((r: { name: string }) => r.name)).toEqual(["Property", "Member", "Office", "Media", "Field", "Lookup"]);

  const metadata = await outside.get("/api/reso/$metadata");
  expect(metadata.status()).toBe(200);
  expect(metadata.headers()["content-type"]).toContain("application/xml");
  expect(metadata.headers()["odata-version"]).toBe("4.0");
  const xml = await metadata.text();
  expect(xml).toContain('<EntityType Name="Property">');
  expect(xml).not.toContain("ShowingInstructions");

  // Pages of records, following the link the server gives.
  // The consumer asks for pages of twenty, so the server cuts each short and links to the next.
  const paged = { headers: { Prefer: "odata.maxpagesize=20" } };
  const first = await outside.get("/api/reso/Property?$select=ListingKey,ListPrice,ModificationTimestamp&$count=true&$orderby=ListPrice desc", paged);
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
    const body = await (await outside.get(next, paged)).json();
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

test("a consumer on the public display feed reads only that feed, over HTTP", async ({ page, playwright, baseURL }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("morgan.ellis@osmls.example");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
  await page.getByRole("link", { name: "Data access" }).click();
  // The screen says what each feed carries, and the narrower one does not list what it leaves out.
  await expect(page.getByTestId("feed-full")).toContainText("ParcelNumber");
  await expect(page.getByTestId("feed-public")).toContainText("ListPrice");
  await expect(page.getByTestId("feed-public")).not.toContainText("ParcelNumber");
  await expect(page.getByTestId("feed-public")).toContainText("does not by itself mean a consumer may publish");

  const add = page.getByTestId("add-data-consumer");
  // No feed is chosen for you.
  await expect(add.getByLabel("Feed")).toHaveValue("");
  await add.getByLabel("Name of the system or company").fill(`Public reader ${run}`);
  await add.getByLabel("Feed").selectOption({ label: "Public display" });
  await add.getByRole("button", { name: "Add data consumer" }).click();
  await expect(add.getByRole("status")).toContainText("was added");
  const token = await add.getByTestId("bearer-token").inputValue();
  const row = page.getByTestId("data-consumers").locator("tbody tr", { hasText: `Public reader ${run}` });
  await expect(row.getByTestId("data-consumer-feed")).toHaveText("Public display");

  const outside = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}`, Prefer: "odata.maxpagesize=200" } });
  const metadata = await (await outside.get("/api/reso/$metadata")).text();
  expect(metadata).toContain('<Property Name="ListPrice"');
  for (const absent of ["ParcelNumber", "DaysOnMarket", "Latitude", "MemberMlsId", "OfficePhone"]) expect(metadata.includes(`"${absent}"`), absent).toBe(false);
  const listings = (await (await outside.get("/api/reso/Property")).json()).value as Record<string, unknown>[];
  expect(listings.length).toBeGreaterThan(10);
  for (const listing of listings) {
    expect(["Active", "Active Under Contract", "Pending", "Closed"]).toContain(listing.StandardStatus);
    expect(Object.keys(listing)).not.toContain("ParcelNumber");
    if (listing.StandardStatus !== "Closed") expect(listing.ClosePrice).toBeNull();
  }
  expect((await outside.get("/api/reso/Property?$select=ParcelNumber")).status()).toBe(400);
  expect((await outside.get("/api/reso/Property?$filter=StandardStatus eq 'Canceled'")).status()).toBe(200);
  expect((await (await outside.get("/api/reso/Property?$filter=StandardStatus eq 'Canceled' or StandardStatus eq 'Expired' or StandardStatus eq 'Coming Soon'")).json()).value).toEqual([]);
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row.getByTestId("data-consumer-state")).toHaveText("Revoked");
  await outside.dispose();
});

test("an agent exports search results as agent and client files, and each download is recorded", async ({ page, browser }) => {
  const { Client } = await import("pg");
  const { readFile } = await import("node:fs/promises");
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("sam.whitfield@osmls.example");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/search/);
    const { rows: [{ key: memberKey }] } = await db.query(`select "MemberKey" as key from "Member" where "MemberMlsId" = 'AG2001'`);
    const taken = async () => (await db.query(`select "Kind", "ListingCount", "OmittedForStatus", "SearchCutOff" from "OsmlsExport" where "MemberKey" = $1 order by "ExportKey"`, [memberKey])).rows;
    const before = (await taken()).length;

    // Every status on Relist Rd: the seed has canceled, expired and closed listings there as well as active ones.
    await page.goto("/search");
    for (const box of await page.getByRole("group", { name: "Status" }).getByRole("checkbox").all()) await box.check();
    await page.getByLabel("Address contains").fill("Relist Rd");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("market-time").first()).toBeVisible();
    const found = await page.getByTestId("market-time").count();
    expect(found).toBeGreaterThan(3);

    const download = async (kind: "agent" | "client") => {
      await page.getByRole("link", { name: `Export ${kind} CSV` }).click();
      await expect(page.getByTestId("export-kind")).toHaveText(kind === "client" ? "Client export" : "Agent export");
      const stated = await page.getByTestId("export-disclosure").innerText();
      const columns = (await page.getByTestId("export-columns").innerText()).split(", ");
      const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-download").click()]);
      const text = (await readFile((await file.path())!, "utf8")).replace(/^﻿/, "");
      await page.getByRole("link", { name: "Back to the search" }).click();
      await expect(page.getByTestId("market-time").first()).toBeVisible();
      return { stated, columns, name: file.suggestedFilename(), lines: text.trimEnd().split("\r\n") };
    };

    const agentFile = await download("agent");
    expect(agentFile.lines[0].split(",")).toEqual(agentFile.columns);
    expect(agentFile.columns).toContain("CumulativeDaysOnMarket");
    expect(agentFile.lines).toHaveLength(found + 1);
    expect(agentFile.stated).toContain(`The file holds ${found} listings.`);
    expect(agentFile.name).toBe(`osmls-agent-export-${found}-listings-${agentFile.name.slice(-14)}`);

    const clientFile = await download("client");
    expect(clientFile.lines[0].split(",")).toEqual(clientFile.columns);
    for (const absent of ["ParcelNumber", "DaysOnMarket", "OriginalListPrice"]) expect(clientFile.columns).not.toContain(absent);
    const held = clientFile.lines.length - 1;
    expect(held).toBeLessThan(found);
    expect(clientFile.stated).toContain(`The file holds ${held} listing`);
    expect(clientFile.stated).toContain(`${found - held} of the listings the search read`);
    for (const line of clientFile.lines.slice(1)) expect(line).not.toMatch(/,(Canceled|Expired|Withdrawn|Coming Soon|Hold),/);

    // Both downloads are on record, and looking at the export page alone recorded nothing.
    expect((await taken()).slice(before)).toEqual([
      { Kind: "agent", ListingCount: found, OmittedForStatus: 0, SearchCutOff: false },
      { Kind: "client", ListingCount: held, OmittedForStatus: found - held, SearchCutOff: false },
    ]);

    // Signed out, or suspended, there is no file.
    const fileUrl = "/exports/search/file?address=Relist+Rd&kind=agent";
    const anonymous = await browser.newContext();
    expect((await anonymous.request.get(fileUrl)).status()).toBe(404);
    const suspended = await anonymous.newPage();
    await suspended.goto("/sign-in");
    await suspended.getByLabel("Email").fill("riley.chen@osmls.example");
    await suspended.getByLabel("Password").fill(password);
    await suspended.getByRole("button", { name: "Sign in" }).click();
    await expect(suspended.getByRole("button", { name: "Sign in" })).toBeEnabled();
    const refused = await anonymous.request.get(fileUrl);
    expect(refused.status()).toBe(404);
    expect((await refused.text()).includes("ListingId")).toBe(false);
    await anonymous.close();
    expect(await taken()).toHaveLength(before + 2);
  } finally {
    await db.end();
  }
});

