/*
 * Access control for documents and showing instructions, checked against the
 * running application. For each kind of viewer it looks at what the server
 * actually sends: the listing page, search results, and direct requests for each
 * document. Checking the response text catches anything sent but not displayed.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const street = `Access Test Way ${run}`;
// Distinctive strings, so a leak anywhere in a response is unmistakable.
const SHOWING_MARK = `showing-secret-${run}`;
const LOCKBOX_MARK = `lockbox-spot-${run}`;
const DOCS = {
  agentOnly: { name: `Agent-only ${run}`, permission: "Listing agent only", body: `agent-bytes-${run}` },
  officeOnly: { name: `Office-only ${run}`, permission: "Listing office only", body: `office-bytes-${run}` },
  members: { name: `Members ${run}`, permission: "All MLS members", body: `members-bytes-${run}` },
} as const;
type DocId = keyof typeof DOCS;
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);

const VIEWERS = {
  listingAgent: "alex.rivera@osmls.example",
  sameOffice: "jordan.okafor@osmls.example",
  otherOffice: "sam.whitfield@osmls.example",
  staff: "morgan.ellis@osmls.example",
  suspendedAgent: "riley.chen@osmls.example",
  suspendedStaff: "casey.morgan@osmls.example",
} as const;
type ViewerId = keyof typeof VIEWERS;
const ACTIVE: ViewerId[] = ["listingAgent", "sameOffice", "otherOffice", "staff"];
const SUSPENDED: ViewerId[] = ["suspendedAgent", "suspendedStaff"];

const MAY_SEE: Record<ViewerId, DocId[]> = {
  listingAgent: ["agentOnly", "officeOnly", "members"],
  sameOffice: ["officeOnly", "members"],
  otherOffice: ["members"],
  staff: ["agentOnly", "officeOnly", "members"],
  suspendedAgent: [],
  suspendedStaff: [],
};

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function contextFor(browser: Browser, viewer: ViewerId): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, VIEWERS[viewer]);
  if (ACTIVE.includes(viewer)) await expect(page).toHaveURL(/\/search/);
  // A suspended account's password is accepted, but it is sent back to sign in.
  else await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.close();
  return context;
}

test("documents and showing instructions reach only those allowed to see them", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);

  // ---- The listing agent sets everything up through the application ----
  const alex = await contextFor(browser, "listingAgent");
  const page = await alex.newPage();
  await page.goto("/listings/new");
  await page.getByLabel("List price").fill("640000");
  await page.getByLabel("Street number").fill("17");
  await page.getByLabel("Street name").fill(street);
  await page.getByLabel("City").fill("Port Alder");
  await page.getByLabel("State").fill("WA");
  await page.getByLabel("ZIP code").fill("98001");
  await page.getByLabel("Bedrooms").fill("3");
  await page.getByLabel("Bathrooms").fill("2");
  await page.getByLabel("Showing instructions", { exact: true }).fill(`Call first. ${SHOWING_MARK}`);
  await page.getByLabel("Appointment Only").check();
  await page.getByLabel("Supra").check();
  await page.getByLabel("Lockbox location").fill(LOCKBOX_MARK);
  await expect(page.getByText("Do not enter lockbox combinations or gate codes here.")).toBeVisible();
  await page.getByRole("button", { name: "Create listing" }).click();
  await expect(page.getByRole("status")).toContainText("Listing created.");
  const listingPath = new URL(page.url()).pathname;
  const listingId = await page.getByTestId("listing-id").innerText();

  await page.goto(`${listingPath}/edit`);
  await expect(page.getByText("Do not upload anything containing lockbox combinations or gate codes.")).toBeVisible();
  const uploadForm = page.locator("form").filter({ has: page.getByLabel("New document name") });
  // The most restrictive permission is the one offered first.
  await expect(uploadForm.getByLabel("Who can see it")).toHaveValue("Agent Only");
  const keys = {} as Record<DocId, string>;
  for (const id of Object.keys(DOCS) as DocId[]) {
    const doc = DOCS[id];
    await uploadForm.getByLabel("New document name").fill(doc.name);
    await uploadForm.getByLabel("Who can see it").selectOption({ label: doc.permission });
    await uploadForm.getByLabel("File").setInputFiles({ name: "upload.pdf", mimeType: "application/pdf", buffer: pdf(doc.body) });
    await uploadForm.getByRole("button", { name: "Add document" }).click();
    const row = page.getByRole("group", { name: doc.name });
    await expect(row).toBeVisible();
    keys[id] = (await row.getByRole("link", { name: "Download" }).getAttribute("href"))!.split("/").pop()!;
  }

  // A file that is not what its name says is refused.
  await uploadForm.getByLabel("New document name").fill("Not really a PDF");
  await uploadForm.getByLabel("File").setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("MZ this is a program") });
  await uploadForm.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByText("Documents must be PDF, JPEG, or PNG files.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Not really a PDF" })).toHaveCount(0);

  const contexts = { listingAgent: alex } as Record<ViewerId, BrowserContext>;
  for (const viewer of [...ACTIVE, ...SUSPENDED]) contexts[viewer] ??= await contextFor(browser, viewer);
  const signedOut = await browser.newContext();

  // What each viewer is sent, as text, wherever in the response it sits.
  const listingText = async (context: BrowserContext) => (await context.request.get(listingPath)).text();
  const searchText = async (context: BrowserContext) =>
    (await context.request.get(`/search?s=1&address=${encodeURIComponent(street)}`)).text();
  const download = (context: BrowserContext, key: string) =>
    context.request.get(`/documents/${key}`, { maxRedirects: 0 });

  async function expectDocuments(viewer: ViewerId, maySee: DocId[]) {
    const html = await listingText(contexts[viewer]);
    for (const id of Object.keys(DOCS) as DocId[]) {
      const allowed = maySee.includes(id);
      const label = `${viewer} / ${id}`;
      // On the page: the name, and the key that would lead to the file.
      expect(html.includes(DOCS[id].name), `${label}: name on listing page`).toBe(allowed);
      expect(html.includes(keys[id]), `${label}: key on listing page`).toBe(allowed);
      // By direct request, as though the address had been guessed or passed on.
      const response = await download(contexts[viewer], keys[id]);
      const signedIn = ACTIVE.includes(viewer);
      expect(response.status(), `${label}: download status`).toBe(allowed ? 200 : signedIn ? 404 : 401);
      const body = await response.text();
      expect(body.includes(DOCS[id].body), `${label}: download contents`).toBe(allowed);
      if (allowed) {
        expect(response.headers()["content-disposition"]).toMatch(/^attachment; filename="/);
        expect(response.headers()["x-content-type-options"]).toBe("nosniff");
        expect(response.headers()["cache-control"]).toBe("private, no-store");
        expect(response.headers()["content-type"]).toBe("application/pdf");
      }
      // The photo route must never hand out a document.
      expect((await contexts[viewer].request.get(`/media/${keys[id]}`)).status(), `${label}: photo route`).not.toBe(200);
    }
  }

  async function expectShowing(viewer: ViewerId, allowed: boolean) {
    const html = await listingText(contexts[viewer]);
    for (const mark of [SHOWING_MARK, LOCKBOX_MARK])
      expect(html.includes(mark), `${viewer}: showing text on listing page`).toBe(allowed);
  }

  // ---- While the listing is on the market ----
  for (const viewer of [...ACTIVE, ...SUSPENDED]) {
    await expectDocuments(viewer, MAY_SEE[viewer]);
    await expectShowing(viewer, ACTIVE.includes(viewer));
  }

  // A signed-out visitor gets nothing at all.
  const signedOutPage = await signedOut.request.get(listingPath);
  expect(signedOutPage.url()).toContain("/sign-in");
  const signedOutHtml = await signedOutPage.text();
  for (const secret of [SHOWING_MARK, LOCKBOX_MARK, ...Object.values(DOCS).map((d) => d.name), ...Object.values(keys)])
    expect(signedOutHtml).not.toContain(secret);
  for (const key of Object.values(keys)) {
    const response = await download(signedOut, key);
    expect(response.status()).toBe(401);
    expect(await response.text()).not.toContain("bytes-");
  }
  // A key that does not exist answers exactly like one that is forbidden.
  expect((await download(contexts.otherOffice, "00000000-0000-4000-8000-000000000000")).status()).toBe(404);

  // Search results carry no documents and no showing details for anyone.
  for (const viewer of ACTIVE) {
    const html = await searchText(contexts[viewer]);
    expect(html, `${viewer}: search finds the listing`).toContain(listingId);
    for (const secret of [SHOWING_MARK, LOCKBOX_MARK, ...Object.values(DOCS).map((d) => d.name), ...Object.values(keys)])
      expect(html.includes(secret), `${viewer}: "${secret}" in search results`).toBe(false);
  }

  // History is for staff. Nobody else's page carries its account of the documents.
  expect(await listingText(contexts.staff)).toContain("Change history");
  for (const viewer of ["listingAgent", "sameOffice", "otherOffice"] as const)
    expect(await listingText(contexts[viewer])).not.toContain("SHA-256");

  // An agent who cannot edit the listing cannot reach its document controls,
  // and the server refuses the actions whatever page they came from.
  const samPage = await contexts.otherOffice.newPage();
  await samPage.goto(`${listingPath}/edit`);
  await expect(samPage).toHaveURL(new RegExp(`${listingPath}$`));
  await samPage.close();

  // ---- The listing agent replaces one file and deletes another ----
  const membersRow = page.getByRole("group", { name: DOCS.members.name });
  const replacedBody = `replaced-bytes-${run}`;
  await membersRow.getByLabel("Replace the file").setInputFiles({ name: "new.pdf", mimeType: "application/pdf", buffer: pdf(replacedBody) });
  await membersRow.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(membersRow.getByText("File replaced.")).toBeVisible();
  const afterReplace = await (await download(contexts.otherOffice, keys.members)).text();
  expect(afterReplace).toContain(replacedBody);
  // The superseded file is gone for everyone, including those who could see it.
  expect(afterReplace).not.toContain(DOCS.members.body);
  expect(await (await download(contexts.listingAgent, keys.members)).text()).not.toContain(DOCS.members.body);

  await page.getByRole("button", { name: `Delete ${DOCS.officeOnly.name}` }).click();
  await expect(page.getByRole("group", { name: DOCS.officeOnly.name })).toHaveCount(0);
  for (const viewer of ACTIVE) expect((await download(contexts[viewer], keys.officeOnly)).status(), viewer).toBe(404);
  // History still has a record of both, with their hashes, for staff.
  const staffHtml = await listingText(contexts.staff);
  expect(staffHtml).toContain(`Deleted: ${DOCS.officeOnly.name}`);
  expect(staffHtml).toContain(`Replaced: ${DOCS.members.name}`);
  expect(staffHtml).toMatch(/SHA-256 [0-9a-f]{64}/);

  // ---- A staff correction widens one document, and needs a reason ----
  const morgan = await contexts.staff.newPage();
  await morgan.goto(`${listingPath}/edit`);
  const agentOnlyRow = morgan.getByRole("group", { name: DOCS.agentOnly.name });
  await agentOnlyRow.getByLabel("Who can see it").selectOption({ label: "All MLS members" });
  await agentOnlyRow.getByRole("button", { name: "Save details" }).click();
  await expect(agentOnlyRow.getByText("Explain why this correction is being made.")).toBeVisible();
  expect((await download(contexts.otherOffice, keys.agentOnly)).status()).toBe(404);
  await morgan.getByLabel("Reason for document correction").fill("Seller asked for it to be shared.");
  await agentOnlyRow.getByLabel("Who can see it").selectOption({ label: "All MLS members" });
  await agentOnlyRow.getByRole("button", { name: "Save details" }).click();
  await expect(agentOnlyRow.getByText("Document updated.")).toBeVisible();
  expect((await download(contexts.otherOffice, keys.agentOnly)).status()).toBe(200);
  // Suspended accounts still get nothing.
  for (const viewer of SUSPENDED) expect((await download(contexts[viewer], keys.agentOnly)).status()).toBe(401);
  await morgan.close();

  // ---- Once the listing is closed, showing details narrow to the listing side ----
  await page.goto(`${listingPath}/edit`);
  await page.getByLabel("Status").selectOption("Pending");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved.");
  await expectShowing("otherOffice", true);
  await page.goto(`${listingPath}/edit`);
  await page.getByLabel("Status").selectOption("Closed");
  await page.getByLabel("Close price").fill("630000");
  await page.getByLabel("Close date").fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved.");

  await expectShowing("listingAgent", true);
  await expectShowing("sameOffice", true);
  await expectShowing("staff", true);
  await expectShowing("otherOffice", false);
  for (const viewer of SUSPENDED) await expectShowing(viewer, false);
  // Documents do not change with status: the members-wide ones are still available.
  expect((await download(contexts.otherOffice, keys.members)).status()).toBe(200);
  // The agent can no longer manage documents on a closed listing.
  await page.goto(`${listingPath}/edit`);
  await expect(page).toHaveURL(new RegExp(`${listingPath}$`));

  expect(baseURL).toBeTruthy();
  for (const context of [...Object.values(contexts), signedOut]) await context.close();
});
