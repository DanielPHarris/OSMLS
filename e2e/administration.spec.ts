/*
 * Member administration through the running application and the mail catcher:
 * MLS staff add a member, the member sets their own password from the emailed
 * link and signs in, and suspending them ends the session they already have.
 */
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const demoPassword = process.env.DEMO_PASSWORD!;
const mailpit = process.env.MAILPIT_URL!;
const run = Date.now();
const STAFF = "morgan.ellis@osmls.example";
const NEW_EMAIL = `new-agent-${run}@osmls.example`;
const MEMBER_ID = `AG${run}`;
// Chosen by "the member" in this test; staff never see or set it.
const chosenPassword = randomBytes(18).toString("base64url");

let db: Client;
test.beforeAll(async () => {
  if (!mailpit) throw new Error("MAILPIT_URL is not set. Copy it from .env.example into .env and run `docker compose up -d mail`.");
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
});
test.afterAll(() => db.end());

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function emailTo(address: string) {
  let found: { ID: string }[] = [];
  await expect(async () => {
    const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    found = (await response.json()).messages;
    expect(found).toHaveLength(1);
  }).toPass({ timeout: 10_000 });
  return (await (await fetch(`${mailpit}/api/v1/message/${found[0].ID}`)).json()) as { Text: string; Subject: string };
}

test.describe.configure({ mode: "serial" });

test("staff add a member, who sets a password and signs in; suspending them ends their open session", async ({ page, browser }) => {
  test.setTimeout(120_000);

  // ---- 1. Staff create a member ----
  await signIn(page, STAFF, demoPassword);
  await expect(page).toHaveURL(/\/search/);
  await page.getByRole("link", { name: "Members" }).click();
  const add = page.getByTestId("add-member");
  await add.getByLabel("First name").fill("Newly");
  await add.getByLabel("Last name").fill(`Added${run}`);
  await add.getByLabel("Email").fill(NEW_EMAIL);
  await add.getByLabel("Member ID").fill(MEMBER_ID);
  await add.getByLabel("Role").selectOption("agent");
  await add.getByLabel("Office (agents only)").selectOption({ label: "Harborview Realty (Demo)" });
  await add.getByRole("button", { name: "Add member" }).click();
  await expect(add.getByRole("status")).toHaveText(`Newly Added${run} was added. A link to set a password was emailed to ${NEW_EMAIL}.`);
  // Staff are not shown the link when it was emailed.
  await expect(page.getByTestId("password-link")).toHaveCount(0);
  const row = page.getByTestId("members").getByRole("row").filter({ hasText: MEMBER_ID });
  await expect(row).toContainText("Active");

  // ---- 2. The member receives the link ----
  const email = await emailTo(NEW_EMAIL);
  expect(email.Subject).toBe("Set your OSMLS password");
  const link = email.Text.match(/http:\/\/localhost:\d+(\/set-password\/[A-Za-z0-9_-]{43})/)?.[1];
  expect(link, "a link in the email").toBeTruthy();
  const token = link!.split("/").pop()!;
  // Only a hash of the link is stored, and the account has no password yet.
  const { rows: stored } = await db.query(`select v.* from "verification" v join "user" u on u.id = v.value where u.email = $1`, [NEW_EMAIL]);
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored).includes(token)).toBe(false);
  const passwords = () => db.query(`select a.password from "account" a join "user" u on u.id = a."userId" where u.email = $1`, [NEW_EMAIL]);
  expect((await passwords()).rows).toEqual([]);

  // ---- 3. The member sets a password with it ----
  const theirs = await browser.newContext();
  const member = await theirs.newPage();
  const opened = await member.goto(link!);
  expect(opened!.headers()["cache-control"]).toContain("no-store");
  expect(opened!.headers()["referrer-policy"]).toBe("no-referrer");
  const form = member.getByTestId("set-password");
  // Too short, and mismatched, are refused without spending the link.
  await form.getByLabel("New password", { exact: true }).fill(chosenPassword);
  await form.getByLabel("New password again").fill(`${chosenPassword}x`);
  await form.getByRole("button", { name: "Set password" }).click();
  await expect(form.getByRole("alert")).toHaveText("The two passwords do not match.");
  await form.getByLabel("New password", { exact: true }).fill(chosenPassword);
  await form.getByLabel("New password again").fill(chosenPassword);
  await form.getByRole("button", { name: "Set password" }).click();
  await expect(form.getByRole("status")).toHaveText("Password set. You can now sign in.");
  // The password is stored hashed, and the link is spent.
  const [{ password: hash }] = (await passwords()).rows;
  expect(hash).toBeTruthy();
  expect(hash.includes(chosenPassword)).toBe(false);
  await member.goto(link!);
  await member.getByLabel("New password", { exact: true }).fill(`${chosenPassword}-again`);
  await member.getByLabel("New password again").fill(`${chosenPassword}-again`);
  await member.getByRole("button", { name: "Set password" }).click();
  await expect(member.getByTestId("set-password").getByRole("alert")).toContainText("This link does not work.");

  // ---- 4. The member signs in ----
  await signIn(member, NEW_EMAIL, chosenPassword);
  await expect(member).toHaveURL(/\/search/);
  await expect(member.getByText(`Newly Added${run} · Agent`)).toBeVisible();
  // An agent has no administration pages: they do not exist for them.
  expect((await theirs.request.get("/admin/members")).status()).toBe(404);
  await expect(member.getByRole("link", { name: "Members" })).toHaveCount(0);

  // ---- 5. Staff suspend the member ----
  await row.getByRole("link", { name: `Newly Added${run}` }).click();
  const access = page.getByTestId("member-access");
  await expect(access.getByTestId("member-status")).toHaveText("Active");
  await access.getByRole("button", { name: "Suspend access" }).click();
  // A reason is required.
  await expect(access.getByTestId("member-status")).toHaveText("Active");
  await access.getByLabel("Reason").fill(`Suspended for the test ${run}`);
  await access.getByRole("button", { name: "Suspend access" }).click();
  await expect(access.getByTestId("member-status")).toHaveText("Suspended");

  // ---- 6. The member's existing session loses access on its next request ----
  await member.goto("/search?s=1");
  await expect(member).toHaveURL(/\/sign-in/);
  await expect(member.getByTestId("result-count")).toHaveCount(0);
  const refused = await theirs.request.get("/saved-searches");
  expect(refused.url()).toContain("/sign-in");
  // The change is on record with who made it and why.
  const { rows: history } = await db.query(
    `select h."ChangeType", h."PreviousValue", h."NewValue", h."OsmlsCorrectionReason", m."MemberEmail" as by
     from "HistoryTransactional" h join "Member" m on m."MemberKey" = h."ChangedByMemberKey"
     where h."ResourceName" = 'Member' and h."ResourceRecordID" = $1 order by h."OsmlsSequence"`,
    [MEMBER_ID],
  );
  expect(history).toEqual([
    { ChangeType: "New Member", PreviousValue: null, NewValue: "Active", OsmlsCorrectionReason: null, by: STAFF },
    { ChangeType: "Suspended", PreviousValue: "Active", NewValue: "Inactive", OsmlsCorrectionReason: `Suspended for the test ${run}`, by: STAFF },
  ]);
  await theirs.close();
});

test("suspending from the screen ends a member's client link and reinstating restores it; an email change moves their sign-in", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const RENAMED = `renamed-${run}@osmls.example`;
  const { rows: [listing] } = await db.query(`select "ListingKey" from "Property" where "StandardStatus" = 'Active' order by "ListingId" limit 1`);
  const { rows: [target] } = await db.query(`select "MemberKey" from "Member" where "MemberMlsId" = $1`, [MEMBER_ID]);
  const memberPage = `/admin/members/${target.MemberKey}`;

  // ---- No one but active MLS staff has these pages ----
  for (const [email, expected] of [["alex.rivera@osmls.example", 404], ["riley.chen@osmls.example", "sign-in"], [null, "sign-in"]] as const) {
    const context = await browser.newContext();
    if (email) {
      const visitor = await context.newPage();
      await signIn(visitor, email, demoPassword);
      // Signed in before going on: the agent lands on search, the suspended member back on sign-in.
      if (expected === 404) await expect(visitor).toHaveURL(/\/search/);
      else await expect(visitor.getByRole("button", { name: "Sign in" })).toBeEnabled();
      await visitor.close();
    }
    for (const path of ["/admin/members", memberPage, "/admin/members/00000000-0000-4000-8000-000000000000"]) {
      const response = await context.request.get(path);
      if (expected === 404) expect(response.status(), `${email} ${path}`).toBe(404);
      else expect(response.url(), `${email} ${path}`).toContain("/sign-in");
      expect((await response.text()).includes(MEMBER_ID), `${email} ${path}`).toBe(false);
    }
    await context.close();
  }

  // ---- Reinstated, the member signs in and makes a client link ----
  await signIn(page, STAFF, demoPassword);
  await expect(page).toHaveURL(/\/search/);
  await page.goto(memberPage);
  const access = page.getByTestId("member-access");
  const setAccess = async (button: string, reason: string, status: string) => {
    await access.getByLabel("Reason").fill(reason);
    await access.getByRole("button", { name: button }).click();
    await expect(access.getByTestId("member-status")).toHaveText(status);
  };
  await setAccess("Reinstate access", "Reinstated for the test", "Active");

  const theirs = await browser.newContext();
  const member = await theirs.newPage();
  await signIn(member, NEW_EMAIL, chosenPassword);
  await expect(member).toHaveURL(/\/search/);
  await member.goto(`/listings/${listing.ListingKey}`);
  await member.getByTestId("shares").getByRole("button", { name: "Make link" }).click();
  const sharePath = new URL(await member.getByTestId("share-link").inputValue()).pathname;
  const outsider = await browser.newContext();
  expect((await outsider.request.get(sharePath)).status()).toBe(200);

  // ---- Suspended from the screen: the link and the open session are refused ----
  await setAccess("Suspend access", "Suspended again for the test", "Suspended");
  expect((await outsider.request.get(sharePath)).status()).toBe(404);
  await member.goto("/search?s=1");
  await expect(member).toHaveURL(/\/sign-in/);

  // ---- Reinstated: both work again, and the member did not have to sign in again ----
  await setAccess("Reinstate access", "Reinstated again for the test", "Active");
  expect((await outsider.request.get(sharePath)).status()).toBe(200);
  await member.goto("/search?s=1");
  await expect(member).toHaveURL(/\/search/);
  await expect(member.getByTestId("result-count")).toBeVisible();
  await outsider.close();

  // ---- An email change moves the sign-in: the old address stops working ----
  const signInSection = page.getByTestId("member-sign-in");
  await signInSection.getByLabel("Email they sign in with").fill(RENAMED);
  await signInSection.getByRole("button", { name: "Change email" }).click();
  await expect(signInSection.getByRole("status").first()).toContainText("Email changed.");
  await expect(page.getByTestId("member-summary")).toContainText(RENAMED);
  await member.getByRole("button", { name: "Sign out" }).click();
  // Signed out before going on: navigating away at once can cut the sign-out short,
  // and the sign-in page then sends the still signed-in member back to search.
  await expect(member).toHaveURL(/\/sign-in/);
  await signIn(member, NEW_EMAIL, chosenPassword);
  await expect(member.getByRole("alert").filter({ hasText: "do not match" })).toBeVisible();
  await signIn(member, RENAMED, chosenPassword);
  await expect(member).toHaveURL(/\/search/);
  await theirs.close();

  // ---- A reset goes to the new address, as a new link ----
  await signInSection.getByRole("button", { name: "Send a new password link" }).click();
  await expect(signInSection.getByRole("status").last()).toContainText(`A new link was emailed to ${RENAMED}.`);
  const reset = await emailTo(RENAMED);
  expect(reset.Subject).toBe("Reset your OSMLS password");
  expect(reset.Text).toMatch(/\/set-password\/[A-Za-z0-9_-]{43}/);

  // ---- The change record shows each of these, with who and why, and no link ----
  await page.reload();
  const record = page.getByTestId("member-history");
  for (const line of ["Password Link Sent", "Email Change", "Reinstated again for the test", "Suspended again for the test", "New Member"]) {
    await expect(record).toContainText(line);
  }
  await expect(record.getByRole("row").nth(1)).toContainText("Morgan Ellis");
  await expect(record).not.toContainText("set-password");
});
