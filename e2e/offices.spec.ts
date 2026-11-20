/*
 * Office administration through the running application: MLS staff add an
 * office and move an agent into it while that agent is signed in. On the
 * agent's next request their own listing is still theirs and still names its
 * old office, and what they may see of colleagues' listings has changed.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";

const password = process.env.DEMO_PASSWORD!;
const run = Date.now();
const STAFF = "morgan.ellis@osmls.example";
const MOVER = `mover-${run}@osmls.example`;
const OLD_OFFICE = `Old Office ${run}`;
const NEW_OFFICE = `New Office ${run}`;
const OLD_DOC = `old-office-document-${run}`;
const NEW_DOC = `new-office-document-${run}`;

let db: Client;
test.beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
});
test.afterAll(() => db.end());

/** An agent with a sign-in. Its password is the demo one, copied as stored from a seeded account. */
async function insertAgent(email: string, id: string, officeKey: string) {
  const userId = randomUUID();
  await db.query(`insert into "user" (id, name, email) values ($1, $2, $3)`, [userId, `Agent ${id}`, email]);
  await db.query(
    `insert into "account" (id, "accountId", "providerId", "userId", password)
     select $1, $2, 'credential', $2, a.password from "account" a join "user" u on u.id = a."userId" where u.email = 'alex.rivera@osmls.example'`,
    [randomUUID(), userId],
  );
  const { rows } = await db.query(
    `insert into "Member" ("MemberMlsId", "MemberFirstName", "MemberLastName", "MemberFullName", "MemberEmail", "OfficeKey", "OsmlsRole", "OsmlsUserId")
     values ($1, 'Agent', $1, $2, $3, $4, 'agent', $5) returning "MemberKey"`,
    [id, `Agent ${id}`, email, officeKey, userId],
  );
  return rows[0].MemberKey as string;
}

/** A Pending listing, so that how it is shown is not open to every member. */
async function insertListing(number: string, agentKey: string, officeKey: string) {
  const { rows } = await db.query(
    `insert into "Property" ("StandardStatus", "PropertyType", "ListPrice", "OriginalListPrice", "ListingContractDate",
       "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode", "UnparsedAddress", "BedroomsTotal",
       "BathroomsTotalInteger", "ListAgentKey", "ListOfficeKey")
     values ('Active', 'Residential', 500000, 500000, '2026-01-05', $1, 'Office Rd', $2, 'WA', '96565', $3, 3, 2, $4, $5)
     returning "ListingKey"`,
    [number, `Officeville${run}`, `${number} Office Rd, Officeville${run}, WA 96565`, agentKey, officeKey],
  );
  return rows[0].ListingKey as string;
}

async function insertOfficeDocument(listingKey: string, name: string) {
  const { rows } = await db.query(
    `insert into "Media" ("ResourceRecordKey", "MediaCategory", "MediaType", "Order", "ShortDescription", "Permission",
       "OsmlsStoragePath", "OsmlsFileSize", "OsmlsFileHash")
     values ($1, 'Document', 'application/pdf', 1, $2, 'Office Only', $3, 10, 'x') returning "MediaKey"`,
    [listingKey, name, `missing-${name}.pdf`],
  );
  return rows[0].MediaKey as string;
}

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/search/);
}

/** What a signed-in session is sent for a listing, as text. */
const sent = async (context: BrowserContext, listingKey: string) => (await context.request.get(`/listings/${listingKey}`)).text();

test("staff add an office and move a signed-in agent into it; the agent's access changes on their next request", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const { rows: [oldOffice] } = await db.query(
    `insert into "Office" ("OfficeMlsId", "OfficeName") values ($1, $2) returning "OfficeKey"`,
    [`OLD${run}`, OLD_OFFICE],
  );
  const mover = await insertAgent(MOVER, `MV${run}`, oldOffice.OfficeKey);
  const formerColleague = await insertAgent(`colleague-${run}@osmls.example`, `FC${run}`, oldOffice.OfficeKey);
  const ownListing = await insertListing("1", mover, oldOffice.OfficeKey);
  const oldListing = await insertListing("2", formerColleague, oldOffice.OfficeKey);
  const oldDoc = await insertOfficeDocument(oldListing, OLD_DOC);

  // ---- The agent signs in while still in the old office ----
  const theirs = await browser.newContext();
  const agent = await theirs.newPage();
  await signIn(agent, MOVER);
  expect(await sent(theirs, oldListing)).toContain(OLD_DOC);

  // ---- 1. Staff create an office ----
  await signIn(page, STAFF);
  await page.getByRole("link", { name: "Offices" }).click();
  const add = page.getByTestId("add-office");
  await add.getByLabel("Office name").fill(NEW_OFFICE);
  await add.getByLabel("Office ID").fill(`NEW${run}`);
  await add.getByLabel("City (optional)").fill("Port Alder");
  await add.getByRole("button", { name: "Add office" }).click();
  await expect(add.getByRole("status")).toHaveText(`${NEW_OFFICE} was added.`);
  const officeRow = page.getByTestId("offices").getByRole("row").filter({ hasText: `NEW${run}` });
  await expect(officeRow).toContainText("Active");
  await expect(officeRow.getByRole("cell").nth(3)).toHaveText("0");

  // Someone already works there, with an office-only document on their listing.
  const { rows: [newOffice] } = await db.query(`select "OfficeKey" from "Office" where "OfficeMlsId" = $1`, [`NEW${run}`]);
  const newColleague = await insertAgent(`new-colleague-${run}@osmls.example`, `NC${run}`, newOffice.OfficeKey);
  const newListing = await insertListing("3", newColleague, newOffice.OfficeKey);
  const newDoc = await insertOfficeDocument(newListing, NEW_DOC);
  // Before the move, that document is not the agent's to see.
  expect(await sent(theirs, newListing)).not.toContain(NEW_DOC);

  // ---- 2. Staff move the agent, who still has their session open ----
  await page.goto(`/admin/members/${mover}`);
  const officeSection = page.getByTestId("member-office");
  await expect(officeSection.getByTestId("member-office-name")).toHaveText(OLD_OFFICE);
  await officeSection.getByLabel("Move to").selectOption({ label: NEW_OFFICE });
  await officeSection.getByRole("button", { name: "Move agent" }).click();
  // A reason is required.
  await expect(officeSection.getByTestId("member-office-name")).toHaveText(OLD_OFFICE);
  await officeSection.getByLabel("Reason for the move").fill(`Joined the new office ${run}`);
  await officeSection.getByRole("button", { name: "Move agent" }).click();
  await expect(officeSection.getByTestId("member-office-name")).toHaveText(NEW_OFFICE);

  // ---- 3. The agent's own listing: still editable, still under the old office ----
  await agent.goto(`/listings/${ownListing}`);
  await expect(agent).toHaveURL(new RegExp(ownListing));
  await expect(agent.getByText(OLD_OFFICE)).toBeVisible();
  await agent.getByRole("link", { name: "Edit listing" }).click();
  await agent.getByLabel("Bedrooms").fill("4");
  await agent.getByRole("button", { name: "Save changes" }).click();
  await expect(agent.getByRole("status")).toContainText("Changes saved.");
  const { rows: [own] } = await db.query(`select "ListOfficeKey", "ListAgentKey", "BedroomsTotal" from "Property" where "ListingKey" = $1`, [ownListing]);
  expect(own).toEqual({ ListOfficeKey: oldOffice.OfficeKey, ListAgentKey: mover, BedroomsTotal: 4 });

  // ---- 4. Colleagues' listings: the old office's document is gone, the new office's has come ----
  const old = await sent(theirs, oldListing);
  expect(old.includes(OLD_DOC)).toBe(false);
  expect(old.includes(oldDoc)).toBe(false);
  const fresh = await sent(theirs, newListing);
  expect(fresh).toContain(NEW_DOC);
  expect(fresh).toContain(newDoc);
  // Asked for directly, the old office's document is refused like one that does not exist.
  expect((await theirs.request.get(`/documents/${oldDoc}`, { maxRedirects: 0 })).status()).toBe(404);

  // The move is on record with who made it and why.
  const { rows: history } = await db.query(
    `select h."ChangeType", h."PreviousValue", h."NewValue", h."OsmlsCorrectionReason", m."MemberEmail" as by
     from "HistoryTransactional" h join "Member" m on m."MemberKey" = h."ChangedByMemberKey"
     where h."ResourceName" = 'Member' and h."ResourceRecordKey" = $1`,
    [mover],
  );
  expect(history).toEqual([
    { ChangeType: "Office Move", PreviousValue: oldOffice.OfficeKey, NewValue: newOffice.OfficeKey, OsmlsCorrectionReason: `Joined the new office ${run}`, by: STAFF },
  ]);
  await theirs.close();
});

test("office pages are for MLS staff only; an office with an active agent cannot be deactivated, and a suspended agent cannot return to an inactive office", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const name = `Closing Office ${run}`;
  const { rows: [target] } = await db.query(`insert into "Office" ("OfficeMlsId", "OfficeName") values ($1, $2) returning "OfficeKey"`, [`CLO${run}`, name]);
  const agentKey = await insertAgent(`closing-${run}@osmls.example`, `CL${run}`, target.OfficeKey);
  const officePage = `/admin/offices/${target.OfficeKey}`;

  // ---- No one but active MLS staff has these pages ----
  for (const [email, expected] of [["alex.rivera@osmls.example", 404], ["riley.chen@osmls.example", "sign-in"], [null, "sign-in"]] as const) {
    const context = await browser.newContext();
    if (email) {
      const visitor = await context.newPage();
      await visitor.goto("/sign-in");
      await visitor.getByLabel("Email").fill(email);
      await visitor.getByLabel("Password").fill(password);
      await visitor.getByRole("button", { name: "Sign in" }).click();
      if (expected === 404) await expect(visitor).toHaveURL(/\/search/);
      else await expect(visitor.getByRole("button", { name: "Sign in" })).toBeEnabled();
      await visitor.close();
    }
    for (const path of ["/admin/offices", officePage, "/admin/offices/00000000-0000-4000-8000-000000000000"]) {
      const response = await context.request.get(path);
      if (expected === 404) expect(response.status(), `${email} ${path}`).toBe(404);
      else expect(response.url(), `${email} ${path}`).toContain("/sign-in");
      expect((await response.text()).includes(name), `${email} ${path}`).toBe(false);
    }
    await context.close();
  }

  // ---- Deactivating is refused while the office has an active agent ----
  await signIn(page, STAFF);
  await page.goto(`/admin/offices?q=CLO${run}`);
  await expect(page.getByTestId("office-count")).toHaveText("1 office");
  await page.getByTestId("offices").getByRole("link", { name }).click();
  await expect(page.getByTestId("office-summary")).toContainText("Main office");
  const status = page.getByTestId("office-status-section");
  await status.getByLabel("Reason").fill("Closing for the test");
  await status.getByRole("button", { name: "Deactivate office" }).click();
  await expect(status.getByRole("alert")).toContainText(`This office has 1 active agent (Agent CL${run}). Move or suspend them first.`);
  await expect(status.getByTestId("office-status")).toHaveText("Active");

  // ---- With the agent suspended, it goes through ----
  await page.getByTestId("office-members").getByRole("link", { name: `Agent CL${run}` }).click();
  const access = page.getByTestId("member-access");
  await access.getByLabel("Reason").fill("Suspended for the test");
  await access.getByRole("button", { name: "Suspend access" }).click();
  await expect(access.getByTestId("member-status")).toHaveText("Suspended");
  await page.goto(officePage);
  await status.getByLabel("Reason").fill("Closing for the test");
  await status.getByRole("button", { name: "Deactivate office" }).click();
  await expect(status.getByTestId("office-status")).toHaveText("Inactive");

  // ---- The suspended agent cannot be reinstated into the inactive office ----
  await page.goto(`/admin/members/${agentKey}`);
  await access.getByLabel("Reason").fill("Back for the test");
  await access.getByRole("button", { name: "Reinstate access" }).click();
  await expect(access.getByRole("alert")).toContainText(`${name} is inactive, so this agent cannot be reinstated there.`);
  await expect(access.getByTestId("member-status")).toHaveText("Suspended");
  // The inactive office is not offered as somewhere to add a member.
  await page.goto("/admin/members");
  await expect(page.getByTestId("add-member").getByLabel("Office (agents only)").getByRole("option", { name })).toHaveCount(0);

  // ---- Reactivated, the office takes them back, and the record shows it all ----
  await page.goto(officePage);
  await status.getByLabel("Reason").fill("Reopened for the test");
  await status.getByRole("button", { name: "Reactivate office" }).click();
  await expect(status.getByTestId("office-status")).toHaveText("Active");
  await page.goto(`/admin/members/${agentKey}`);
  await access.getByLabel("Reason").fill("Back for the test");
  await access.getByRole("button", { name: "Reinstate access" }).click();
  await expect(access.getByTestId("member-status")).toHaveText("Active");
  await page.goto(officePage);
  const record = page.getByTestId("office-history");
  await expect(record).toContainText("Reopened for the test");
  await expect(record).toContainText("Closing for the test");
  await expect(record.getByRole("row").nth(1)).toContainText("Morgan Ellis");
});
