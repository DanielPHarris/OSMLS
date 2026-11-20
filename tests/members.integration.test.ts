/*
 * Member administration against the test database: who may administer, adding
 * and changing members, password links, changing a sign-in address, suspension
 * and what it ends, the guards on staff acting on each other, and the record
 * of it all.
 *
 * Email is switched off for most of these tests, so a password link comes back
 * to the caller as it would to staff on a system without email.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "../src/db";
import { account, historyTransactional, member, office, property, savedSearch, session, share, user, verification, type Member } from "../src/db/schema";
import { resumeAlert, sendDueAlerts, setAlertFrequency } from "../src/lib/alerts";
import { auth } from "../src/lib/auth";
import { addPhoto, createListing, updateListing } from "../src/lib/listings";
import { CAPABILITIES } from "../src/lib/lookups";
import type { Mail } from "../src/lib/mail";
import {
  changeMemberEmail,
  createMember,
  getMemberForAdmin,
  getMemberHistory,
  listMembers,
  sendPasswordLink,
  setCapabilities,
  setMemberStatus,
  setPasswordWithLink,
  updateMember,
} from "../src/lib/members";
import { createSavedSearch } from "../src/lib/saved-work";
import { DEFAULT_CRITERIA } from "../src/lib/search-criteria";
import { createShare, getSharedPage, getSharedPhoto } from "../src/lib/shares";

const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
const REFUSED_LINK = "This link does not work. It may have been used, replaced, or expired. Ask MLS staff for a new one.";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let staff: Member;
let agent: Member;
let suspendedStaff: Member;
let offices: { OfficeKey: string; OfficeName: string }[];
let serial = 0;
const smtp = process.env.SMTP_URL;

const fresh = async (m: Member) => (await db.select().from(member).where(eq(member.MemberKey, m.MemberKey)))[0];
const input = (changes: Record<string, string> = {}) => {
  const n = ++serial;
  return {
    firstName: "Test", lastName: `Member${n}`, email: `member-${run}-${n}@osmls.example`, memberId: `T${run}-${n}`,
    role: "agent", officeKey: offices[0].OfficeKey, phone: "", ...changes,
  };
};
/** A new member, with the link they were given to set a password. */
async function add(changes: Record<string, string> = {}, by: Member = staff) {
  const made = await createMember(by, input(changes));
  return { member: made.member, token: made.passwordLink.link!.split("/").pop()! };
}
const tokenOf = (link: { link: string | null }) => link.link!.split("/").pop()!;
const passwordHash = async (m: Member) =>
  (await db.select().from(account).where(eq(account.userId, m.OsmlsUserId)))[0]?.password ?? null;
const verifies = async (m: Member, password: string) => {
  const hash = await passwordHash(m);
  return hash ? (await auth.$context).password.verify({ hash, password }) : false;
};
const recordOf = async (m: Member) =>
  (await getMemberHistory(staff, m.MemberKey))!
    .map(({ entry: e }) => `${e.ChangeType} ${e.FieldName}: ${e.PreviousValue ?? ""} → ${e.NewValue ?? ""}${e.OsmlsCorrectionReason ? ` (${e.OsmlsCorrectionReason})` : ""}`)
    .reverse();

beforeAll(async () => {
  delete process.env.SMTP_URL;
  const members = await db.select().from(member);
  staff = members.find((m) => m.MemberMlsId === "ST0001")!;
  agent = members.find((m) => m.MemberMlsId === "AG1001")!;
  suspendedStaff = members.find((m) => m.MemberMlsId === "ST0099")!;
  offices = await db.select().from(office).orderBy(office.OfficeName);
});
afterAll(async () => {
  process.env.SMTP_URL = smtp;
  // Everyone these tests added is left suspended, and the seeded staff account active.
  await db.update(member).set({ MemberStatus: "Inactive" }).where(like(member.MemberMlsId, `T${run}-%`));
  await db.update(member).set({ MemberStatus: "Active" }).where(eq(member.MemberKey, staff.MemberKey));
  await db.delete(savedSearch).where(like(savedSearch.SavedSearchName, `Admin ${run}%`));
  await pool.end();
});

describe("who may administer", () => {
  it("refuses everyone but active MLS staff, exactly as if nothing were there", async () => {
    const { member: target } = await add();
    const before = await fresh(target);
    const suspendedAgent = { ...agent, MemberStatus: "Inactive" };
    for (const viewer of [agent, suspendedStaff, suspendedAgent, null]) {
      await expect(createMember(viewer, input())).rejects.toThrow("Not found.");
      await expect(updateMember(viewer, target.MemberKey, input())).rejects.toThrow("Not found.");
      await expect(changeMemberEmail(viewer, target.MemberKey, `x-${run}@osmls.example`)).rejects.toThrow("Not found.");
      await expect(sendPasswordLink(viewer, target.MemberKey)).rejects.toThrow("Not found.");
      await expect(setMemberStatus(viewer, target.MemberKey, "Inactive", "because")).rejects.toThrow("Not found.");
      expect(await listMembers(viewer)).toBeNull();
      expect(await getMemberForAdmin(viewer, target.MemberKey)).toBeNull();
      expect(await getMemberHistory(viewer, target.MemberKey)).toBeNull();
    }
    expect(await fresh(target)).toEqual(before);
    // Staff asking for a member that does not exist get the same answer.
    await expect(updateMember(staff, NO_SUCH_KEY, input())).rejects.toThrow("Not found.");
    await expect(setMemberStatus(staff, NO_SUCH_KEY, "Inactive", "because")).rejects.toThrow("Not found.");
    await expect(sendPasswordLink(staff, "nonsense")).rejects.toThrow("Not found.");
    expect(await getMemberForAdmin(staff, NO_SUCH_KEY)).toBeNull();
  });

  it("refuses a staff member whose account was suspended after they opened the page", async () => {
    const { member: other } = await add({ role: "staff", officeKey: "" });
    const { member: target } = await add();
    await setMemberStatus(staff, other.MemberKey, "Inactive", "left");
    // `other` is still the active-looking record their page was built from.
    await expect(setMemberStatus(other, target.MemberKey, "Inactive", "late")).rejects.toThrow("Not found.");
    await expect(updateMember(other, target.MemberKey, input())).rejects.toThrow("Not found.");
    await expect(createMember(other, input())).rejects.toThrow("Not found.");
    expect((await fresh(target)).MemberStatus).toBe("Active");
  });
});

describe("adding a member", () => {
  it("makes the member and the sign-in identity together, with no password", async () => {
    const values = input({ email: `Mixed.Case-${run}@OSMLS.example`, phone: " 555-0100 " });
    const { member: made } = await createMember(staff, values);
    expect(made).toMatchObject({
      MemberFullName: `Test ${values.lastName}`, MemberEmail: values.email.toLowerCase(), MemberMlsId: values.memberId,
      OsmlsRole: "agent", OfficeKey: offices[0].OfficeKey, MemberStatus: "Active", MemberDirectPhone: "555-0100",
    });
    const [identity] = await db.select().from(user).where(eq(user.id, made.OsmlsUserId));
    expect(identity).toMatchObject({ email: values.email.toLowerCase(), name: made.MemberFullName });
    expect(await passwordHash(made)).toBeNull();
    expect(await recordOf(made)).toEqual(["New Member MemberStatus:  → Active"]);
  });

  it("gives an agent an office and MLS staff none", async () => {
    await expect(createMember(staff, input({ officeKey: "" }))).rejects.toMatchObject({ fieldErrors: { officeKey: "An agent needs an office." } });
    await expect(createMember(staff, input({ officeKey: NO_SUCH_KEY }))).rejects.toMatchObject({ fieldErrors: { officeKey: "An agent needs an office." } });
    const { member: made } = await add({ role: "staff" });
    expect(made).toMatchObject({ OsmlsRole: "staff", OfficeKey: null });
  });

  it("refuses a second member with the same email or member ID, leaving nothing behind", async () => {
    const { member: first } = await add();
    const identities = async () => (await db.select().from(user)).length;
    const before = await identities();
    await expect(createMember(staff, input({ email: first.MemberEmail.toUpperCase() }))).rejects.toMatchObject({
      fieldErrors: { email: "Another member already has that email address." },
    });
    await expect(createMember(staff, input({ memberId: first.MemberMlsId }))).rejects.toMatchObject({
      fieldErrors: { memberId: "Another member already has that member ID." },
    });
    // The refused member ID did not leave a sign-in identity without a member.
    expect(await identities()).toBe(before);
  });

  it("says which fields are wrong", async () => {
    await expect(createMember(staff, { ...input(), firstName: " ", email: "nope", role: "owner", memberId: "" })).rejects.toMatchObject({
      fieldErrors: { firstName: "A first name is required.", email: "Enter one email address.", role: "Choose a role.", memberId: "A member ID is required." },
    });
  });
});

describe("password links", () => {
  it("lets the member set their own password once, and ends their other sessions", async () => {
    const { member: made, token } = await add();
    // Only a hash of the link is kept.
    const kept = await db.select().from(verification).where(eq(verification.value, made.OsmlsUserId));
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept).includes(token)).toBe(false);
    await expect(setPasswordWithLink(token, "short")).rejects.toThrow("Use at least 12 characters.");
    await db.insert(session).values({ id: `s-${run}-${serial}`, token: `t-${run}-${serial}`, userId: made.OsmlsUserId, expiresAt: new Date(Date.now() + 60_000) });

    await setPasswordWithLink(token, "a-first-password");
    expect(await verifies(made, "a-first-password")).toBe(true);
    expect((await passwordHash(made))!.includes("a-first-password")).toBe(false);
    expect(await db.select().from(session).where(eq(session.userId, made.OsmlsUserId))).toEqual([]);
    // Used once: it does not work again.
    await expect(setPasswordWithLink(token, "a-second-password")).rejects.toThrow(REFUSED_LINK);
    expect(await verifies(made, "a-first-password")).toBe(true);
  });

  it("issues a new link on a reset, which ends the earlier one", async () => {
    const { member: made, token: first } = await add();
    const second = tokenOf(await sendPasswordLink(staff, made.MemberKey));
    expect(second).not.toBe(first);
    expect(await db.select().from(verification).where(eq(verification.value, made.OsmlsUserId))).toHaveLength(1);
    await expect(setPasswordWithLink(first, "the-old-link-pw")).rejects.toThrow(REFUSED_LINK);
    expect(await passwordHash(made)).toBeNull();
    await setPasswordWithLink(second, "the-new-link-pw");
    expect(await verifies(made, "the-new-link-pw")).toBe(true);
    // A reset for someone who already has a password replaces it.
    const third = tokenOf(await sendPasswordLink(staff, made.MemberKey));
    await setPasswordWithLink(third, "a-replacement-pw");
    expect(await verifies(made, "the-new-link-pw")).toBe(false);
    expect(await verifies(made, "a-replacement-pw")).toBe(true);
  });

  it("refuses an expired link and anything that is not a link, each with the same words", async () => {
    const { member: made, token } = await add();
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.value, made.OsmlsUserId));
    for (const bad of [token, "A".repeat(43), "", "short", null, 7]) {
      await expect(setPasswordWithLink(bad, "a-long-enough-password")).rejects.toThrow(REFUSED_LINK);
    }
    expect(await passwordHash(made)).toBeNull();
  });

  it("emails the link when email is on, and then does not hand it to staff", async () => {
    process.env.SMTP_URL = smtp;
    try {
      const values = input();
      const made = await createMember(staff, values);
      expect(made.passwordLink).toEqual({ emailedTo: values.email, link: null });
      const found = await (await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${values.email}`)}`)).json();
      expect(found.messages).toHaveLength(1);
      expect(found.messages[0].Subject).toBe("Set your OSMLS password");
    } finally {
      delete process.env.SMTP_URL;
    }
  });
});

describe("password links made while something else is changing the account", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Holds the next link at the moment it is about to be stored, until released. */
  async function pauseNextLink() {
    const adapter = (await auth.$context).internalAdapter;
    const store = adapter.createVerificationValue.bind(adapter);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const paused = new Promise<void>((resolve) => (reached = resolve));
    vi.spyOn(adapter, "createVerificationValue").mockImplementationOnce(async (...args: Parameters<typeof store>) => {
      reached();
      await gate;
      return store(...args);
    });
    return { paused, release };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const links = async (m: Member) => (await db.select().from(verification).where(eq(verification.value, m.OsmlsUserId))).length;
  const works = async (token: string, password: string) =>
    setPasswordWithLink(token, password).then(() => true, () => false);

  it("does not leave a working link for the old address when a reset overlaps an email change", async () => {
    const { member: made } = await add();
    const next = `overlap-${run}-${++serial}@osmls.example`;
    const hold = await pauseNextLink();
    const reset = sendPasswordLink(staff, made.MemberKey);
    await hold.paused;
    // The email change is asked for while the reset's link is still being made.
    const change = changeMemberEmail(staff, made.MemberKey, next);
    await settle();
    hold.release();
    const [link] = await Promise.all([reset, change]);
    expect((await fresh(made)).MemberEmail).toBe(next);
    // The reset's link belonged to the old address: it must not set the password.
    expect(await works(tokenOf(link), "made-for-old-address")).toBe(false);
    expect(await passwordHash(made)).toBeNull();
    expect(await links(made)).toBe(0);
  });

  it("leaves only the newer link working when two resets overlap", async () => {
    const { member: made } = await add();
    const hold = await pauseNextLink();
    const first = sendPasswordLink(staff, made.MemberKey);
    await hold.paused;
    const second = sendPasswordLink(staff, made.MemberKey);
    await settle();
    hold.release();
    const [one, two] = await Promise.all([first, second]);
    expect(await links(made)).toBe(1);
    expect(tokenOf(one)).not.toBe(tokenOf(two));
    // The second was issued after the first, so it is the one that remains.
    expect(await works(tokenOf(one), "the-first-of-two-pw")).toBe(false);
    expect(await works(tokenOf(two), "the-second-of-two-pw")).toBe(true);
  });

  it("leaves only the newer link working when a reset overlaps a new member's welcome link", async () => {
    const values = input();
    const hold = await pauseNextLink();
    const adding = createMember(staff, values);
    await hold.paused;
    // The member exists by now; their welcome link is still being made.
    const [made] = await db.select().from(member).where(eq(member.MemberMlsId, values.memberId));
    const reset = sendPasswordLink(staff, made.MemberKey);
    await settle();
    hold.release();
    const [welcome, later] = await Promise.all([adding, reset]);
    expect(await links(made)).toBe(1);
    expect(await works(tokenOf(welcome.passwordLink), "the-welcome-link-pw")).toBe(false);
    expect(await works(tokenOf(later), "the-reset-link-pw")).toBe(true);
  });
});

describe("changing a member's email", () => {
  it("changes the member and the sign-in identity together, and ends links sent to the old address", async () => {
    const { member: made, token } = await add();
    const next = `Renamed-${run}-${++serial}@osmls.example`;
    await changeMemberEmail(staff, made.MemberKey, ` ${next} `);
    expect((await fresh(made)).MemberEmail).toBe(next.toLowerCase());
    expect((await db.select().from(user).where(eq(user.id, made.OsmlsUserId)))[0].email).toBe(next.toLowerCase());
    expect(await db.select().from(user).where(eq(user.email, made.MemberEmail))).toEqual([]);
    // The link that went to the old address no longer controls the account.
    await expect(setPasswordWithLink(token, "sent-to-old-address")).rejects.toThrow(REFUSED_LINK);
    expect(await passwordHash(made)).toBeNull();
    expect((await recordOf(made)).at(-1)).toBe(`Email Change MemberEmail: ${made.MemberEmail} → ${next.toLowerCase()}`);
    // A link sent afterwards goes to the new address and works.
    await setPasswordWithLink(tokenOf(await sendPasswordLink(staff, made.MemberKey)), "sent-to-new-address");
    expect(await verifies(made, "sent-to-new-address")).toBe(true);
  });

  it("refuses an address another member has, changing neither record nor ending any link", async () => {
    const { member: made, token } = await add();
    await expect(changeMemberEmail(staff, made.MemberKey, agent.MemberEmail.toUpperCase())).rejects.toMatchObject({
      fieldErrors: { email: "Another member already has that email address." },
    });
    await expect(changeMemberEmail(staff, made.MemberKey, "not an address")).rejects.toMatchObject({ fieldErrors: { email: "Enter one email address." } });
    expect((await fresh(made)).MemberEmail).toBe(made.MemberEmail);
    expect((await db.select().from(user).where(eq(user.id, made.OsmlsUserId)))[0].email).toBe(made.MemberEmail);
    await setPasswordWithLink(token, "the-link-still-works");
    expect(await verifies(made, "the-link-still-works")).toBe(true);
  });
});

describe("details and role", () => {
  it("changes name, member ID, and phone, and records each", async () => {
    const { member: made } = await add();
    await updateMember(staff, made.MemberKey, { firstName: "Renamed", lastName: "Person", memberId: `${made.MemberMlsId}-B`, phone: "555-0101", role: "agent", officeKey: "" });
    const now = await fresh(made);
    expect(now).toMatchObject({ MemberFullName: "Renamed Person", MemberMlsId: `${made.MemberMlsId}-B`, MemberDirectPhone: "555-0101", OfficeKey: made.OfficeKey });
    expect((await db.select().from(user).where(eq(user.id, made.OsmlsUserId)))[0].name).toBe("Renamed Person");
    expect((await recordOf(made)).slice(1)).toEqual([
      "Member Change MemberFirstName: Test → Renamed",
      `Member Change MemberLastName: ${made.MemberLastName} → Person`,
      `Member Change MemberMlsId: ${made.MemberMlsId} → ${made.MemberMlsId}-B`,
      "Member Change MemberDirectPhone:  → 555-0101",
    ]);
    // Saving the same again records nothing.
    await updateMember(staff, made.MemberKey, { firstName: "Renamed", lastName: "Person", memberId: `${made.MemberMlsId}-B`, phone: "555-0101", role: "agent", officeKey: offices[1].OfficeKey });
    expect(await recordOf(made)).toHaveLength(5);
    // An agent's office is not moved here, whatever office is sent.
    expect((await fresh(made)).OfficeKey).toBe(made.OfficeKey);
    await expect(updateMember(staff, made.MemberKey, { ...input(), memberId: agent.MemberMlsId })).rejects.toMatchObject({
      fieldErrors: { memberId: "Another member already has that member ID." },
    });
  });

  it("sets the office with the role, and leaves the member's listings with the office recorded on them", async () => {
    const { member: made } = await add();
    const listing = await createListing(await fresh(made), {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: String(++serial), StreetName: "Admin Ave", City: `Admin${run}`, StateOrProvince: "WA", PostalCode: "96564",
      BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const details = { firstName: made.MemberFirstName, lastName: made.MemberLastName, memberId: made.MemberMlsId, phone: "" };
    const listingOffice = async () => (await db.select().from(property).where(eq(property.ListingKey, listing.ListingKey)))[0].ListOfficeKey;

    // Agent to MLS staff: the office goes, even if one is sent.
    await updateMember(staff, made.MemberKey, { ...details, role: "staff", officeKey: offices[1].OfficeKey });
    expect(await fresh(made)).toMatchObject({ OsmlsRole: "staff", OfficeKey: null });
    expect(await listingOffice()).toBe(offices[0].OfficeKey);
    // MLS staff to agent: an office is required.
    await expect(updateMember(staff, made.MemberKey, { ...details, role: "agent", officeKey: "" })).rejects.toMatchObject({
      fieldErrors: { officeKey: "An agent needs an office." },
    });
    expect((await fresh(made)).OsmlsRole).toBe("staff");
    await updateMember(staff, made.MemberKey, { ...details, role: "agent", officeKey: offices[1].OfficeKey });
    expect(await fresh(made)).toMatchObject({ OsmlsRole: "agent", OfficeKey: offices[1].OfficeKey });
    // The listing still names the office it was listed under.
    expect(await listingOffice()).toBe(offices[0].OfficeKey);
    expect((await recordOf(made)).slice(1)).toEqual([
      "Role Change OsmlsRole: agent → staff",
      `Role Change OfficeKey: ${offices[0].OfficeKey} → `,
      "Role Change OsmlsRole: staff → agent",
      `Role Change OfficeKey:  → ${offices[1].OfficeKey}`,
    ]);
  });
});

describe("suspension", () => {
  it("needs a reason, records it, and is undone by reinstating", async () => {
    const { member: made } = await add();
    for (const reason of ["", "   ", null, undefined]) {
      await expect(setMemberStatus(staff, made.MemberKey, "Inactive", reason)).rejects.toMatchObject({ fieldErrors: { reason: "A reason is required." } });
    }
    await expect(setMemberStatus(staff, made.MemberKey, "Inactive", "x".repeat(501))).rejects.toThrow("Keep the reason to 500 characters.");
    expect((await fresh(made)).MemberStatus).toBe("Active");
    await setMemberStatus(staff, made.MemberKey, "Inactive", " Dues unpaid ");
    expect((await fresh(made)).MemberStatus).toBe("Inactive");
    // Suspending someone already suspended records nothing more.
    await setMemberStatus(staff, made.MemberKey, "Inactive", "again");
    await setMemberStatus(staff, made.MemberKey, "Active", "Dues paid");
    expect((await fresh(made)).MemberStatus).toBe("Active");
    expect((await recordOf(made)).slice(1)).toEqual([
      "Suspended MemberStatus: Active → Inactive (Dues unpaid)",
      "Reinstated MemberStatus: Inactive → Active (Dues paid)",
    ]);
  });

  it("ends the member's client links, their photos, and their alerts, and reinstating restores them unchanged", async () => {
    const made = await fresh((await add()).member);
    const city = `Suspended${run}`;
    const listing = await createListing(made, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: String(++serial), StreetName: "Admin Ave", City: city, StateOrProvince: "WA", PostalCode: "96564",
      BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const photo = (await addPhoto(made, listing.ListingKey, png)).MediaKey;
    const token = (await createShare(made, { listing: listing.ListingKey }, {})).link.split("/").pop()!;
    const { SavedSearchKey: key } = await createSavedSearch(made, `Admin ${run} ${city}`, { ...DEFAULT_CRITERIA, city, statuses: [] });
    process.env.SMTP_URL = smtp;
    await setAlertFrequency(made, key, "daily");
    delete process.env.SMTP_URL;
    await updateListing(made, listing.ListingKey, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "480000", ListingContractDate: "2026-01-01",
      StreetNumber: listing.StreetNumber, StreetName: "Admin Ave", City: city, StateOrProvince: "WA", PostalCode: "96564",
      BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const alert = async () => (await db.select().from(savedSearch).where(eq(savedSearch.SavedSearchKey, key)))[0];
    const before = await alert();
    const sent: Mail[] = [];
    const send = async (mail: Mail) => void sent.push(mail);
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await getSharedPage(token)).not.toBeNull();

    await setMemberStatus(staff, made.MemberKey, "Inactive", "Under review");
    expect(await getSharedPage(token)).toBeNull();
    expect(await getSharedPhoto(token, photo)).toBeNull();
    await sendDueAlerts({ send, now: later });
    expect(sent.filter((m) => m.to === made.MemberEmail)).toEqual([]);
    expect(await alert()).toEqual(before);
    // A suspended member can change nothing of their own either.
    await expect(resumeAlert(await fresh(made), key)).rejects.toThrow("Not found.");
    // Nothing of theirs was deleted.
    expect(await db.select().from(share).where(eq(share.MemberKey, made.MemberKey))).toHaveLength(1);

    await setMemberStatus(staff, made.MemberKey, "Active", "Review closed");
    expect(await getSharedPage(token)).not.toBeNull();
    expect(await getSharedPhoto(token, photo)).not.toBeNull();
    await sendDueAlerts({ send, now: later });
    expect(sent.filter((m) => m.to === made.MemberEmail)).toHaveLength(1);
    await db.delete(savedSearch).where(eq(savedSearch.SavedSearchKey, key));
  });
});

describe("staff acting on themselves and on each other", () => {
  // A new staff account holds nothing; these tests are about staff who administer.
  const staffMember = async () => {
    const made = (await add({ role: "staff", officeKey: "" })).member;
    await setCapabilities(staff, made.MemberKey, [...CAPABILITIES], "test");
    return fresh(made);
  };
  const activeStaff = async (among: Member[]) =>
    (await db.select().from(member).where(and(inArray(member.MemberKey, among.map((m) => m.MemberKey)), eq(member.MemberStatus, "Active"), eq(member.OsmlsRole, "staff")))).length;
  const details = (m: Member) => ({ firstName: m.MemberFirstName, lastName: m.MemberLastName, memberId: m.MemberMlsId, phone: "" });

  it("does not let a staff member suspend themself or change their own role", async () => {
    const me = await staffMember();
    await expect(setMemberStatus(me, me.MemberKey, "Inactive", "leaving")).rejects.toThrow("You cannot suspend or reinstate your own account.");
    await expect(updateMember(me, me.MemberKey, { ...details(me), role: "agent", officeKey: offices[0].OfficeKey })).rejects.toThrow("You cannot change your own role.");
    expect(await fresh(me)).toMatchObject({ MemberStatus: "Active", OsmlsRole: "staff" });
    // Their own name and phone they may change.
    await updateMember(me, me.MemberKey, { ...details(me), phone: "555-0102", role: "staff", officeKey: "" });
    expect((await fresh(me)).MemberDirectPhone).toBe("555-0102");
  });

  it("leaves one of two staff active when each suspends the other at the same moment", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await staffMember();
      const b = await staffMember();
      const results = await Promise.allSettled([
        setMemberStatus(a, b.MemberKey, "Inactive", "race"),
        setMemberStatus(b, a.MemberKey, "Inactive", "race"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await activeStaff([a, b])).toBe(1);
    }
  });

  it("leaves one of two staff in place when one suspends while the other demotes", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await staffMember();
      const b = await staffMember();
      const results = await Promise.allSettled([
        setMemberStatus(a, b.MemberKey, "Inactive", "race"),
        updateMember(b, a.MemberKey, { ...details(a), role: "agent", officeKey: offices[0].OfficeKey }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await activeStaff([a, b])).toBe(1);
    }
  });

  it("does not let demoted staff go on administering", async () => {
    const a = await staffMember();
    const b = await staffMember();
    await updateMember(a, b.MemberKey, { ...details(b), role: "agent", officeKey: offices[0].OfficeKey });
    await expect(setMemberStatus(b, a.MemberKey, "Inactive", "after demotion")).rejects.toThrow("Not found.");
    expect((await fresh(a)).MemberStatus).toBe("Active");
  });
});

describe("finding members and reading the record", () => {
  it("finds members by name, email, member ID, role, access, and office", async () => {
    const { member: made } = await add({ lastName: `Findable${run}`, officeKey: offices[1].OfficeKey });
    const ids = async (filters: Parameters<typeof listMembers>[1]) => (await listMembers(staff, filters))!.map((r) => r.member.MemberMlsId);
    expect(await ids({ q: `findable${run}` })).toEqual([made.MemberMlsId]);
    expect(await ids({ q: made.MemberEmail.toUpperCase() })).toEqual([made.MemberMlsId]);
    expect(await ids({ q: made.MemberMlsId })).toEqual([made.MemberMlsId]);
    expect(await ids({ q: `Findable${run}`, role: "staff" })).toEqual([]);
    expect(await ids({ q: `Findable${run}`, status: "Inactive" })).toEqual([]);
    expect(await ids({ q: `Findable${run}`, office: offices[0].OfficeKey })).toEqual([]);
    expect(await ids({ q: `Findable${run}`, role: "agent", status: "Active", office: offices[1].OfficeKey })).toEqual([made.MemberMlsId]);
    // A search character is matched as itself.
    expect(await ids({ q: "%" })).toEqual([]);
    // Unknown values for a filter are ignored, not errors.
    expect((await ids({ role: "owner", status: "Deleted", office: "nonsense" })).length).toBeGreaterThan(10);
    expect((await ids({})).includes("ST0001")).toBe(true);
  });

  it("never records a password or a password link", async () => {
    const { member: made, token } = await add();
    const second = tokenOf(await sendPasswordLink(staff, made.MemberKey));
    await setPasswordWithLink(second, "never-recorded-pw");
    const rows = await db.select().from(historyTransactional).where(eq(historyTransactional.ResourceRecordKey, made.MemberKey));
    const text = JSON.stringify(rows);
    for (const secret of [token, second, "never-recorded-pw", (await passwordHash(made))!]) expect(text.includes(secret)).toBe(false);
    expect(await recordOf(made)).toEqual(["New Member MemberStatus:  → Active", "Password Link Sent Password:  → "]);
  });
});

/*
 * The first proof of staff capabilities, by direct call rather than by screen.
 * The fuller set of capability, escalation, and race tests comes with the rest
 * of the slice.
 */
describe("a staff member who holds only Manage settings", () => {
  it("is refused every member action, and holds nothing once revoked", async () => {
    const made = (await add({ role: "staff", officeKey: "" })).member;
    expect((await fresh(made)).OsmlsCapabilities).toEqual([]);
    await setCapabilities(staff, made.MemberKey, ["settings"], "settings only");
    const holder = await fresh(made);
    const { member: target } = await add();

    expect(await listMembers(holder)).toBeNull();
    expect(await getMemberForAdmin(holder, target.MemberKey)).toBeNull();
    await expect(setMemberStatus(holder, target.MemberKey, "Inactive", "no")).rejects.toThrow("Not found.");
    await expect(changeMemberEmail(holder, target.MemberKey, `taken-${run}@osmls.example`)).rejects.toThrow("Not found.");
    await expect(sendPasswordLink(holder, target.MemberKey)).rejects.toThrow("Not found.");
    await expect(createMember(holder, input())).rejects.toThrow("Not found.");
    // They cannot grant themselves, or anyone, anything.
    await expect(setCapabilities(holder, holder.MemberKey, [...CAPABILITIES], "more")).rejects.toThrow("Not found.");
    expect(await fresh(target)).toMatchObject({ MemberStatus: "Active", MemberEmail: target.MemberEmail });

    expect(await recordOf(made)).toContain("Capabilities Change OsmlsCapabilities:  → settings (settings only)");
  });
});
