/*
 * Office administration against the test database: who may administer, adding
 * and changing offices, the one-level brokerage rules, deactivation and what
 * blocks it, the rule that an active agent is always in an active office
 * (including when reinstated), the races between those, and the record.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { member, office, type Member, type Office } from "../src/db/schema";
import { createMember, moveMember, setMemberStatus, updateMember } from "../src/lib/members";
import { createOffice, getOfficeForAdmin, listOfficesForAdmin, setMainOffice, setOfficeStatus, updateOffice } from "../src/lib/offices";

const run = Date.now();
const NO_SUCH_KEY = "00000000-0000-4000-8000-000000000000";
let staff: Member;
let agent: Member;
let suspendedStaff: Member;
let serial = 0;
const smtp = process.env.SMTP_URL;

// Named to sort after the seeded offices, which other tests pick by position.
const officeInput = (changes: Record<string, string> = {}) => {
  const n = ++serial;
  return { name: `Zz Office ${run} ${n}`, officeId: `ZZ${run}-${n}`, phone: "", city: "", state: "", ...changes };
};
const addOffice = (changes: Record<string, string> = {}) => createOffice(staff, officeInput(changes));
const freshOffice = async (o: Office) => (await db.select().from(office).where(eq(office.OfficeKey, o.OfficeKey)))[0];
const freshMember = async (m: Member) => (await db.select().from(member).where(eq(member.MemberKey, m.MemberKey)))[0];
const addAgent = async (in_: Office) => {
  const n = ++serial;
  return (
    await createMember(staff, {
      firstName: "Office", lastName: `Agent${n}`, email: `office-agent-${run}-${n}@osmls.example`, memberId: `ZA${run}-${n}`,
      role: "agent", officeKey: in_.OfficeKey, phone: "",
    })
  ).member;
};
const details = (m: Member) => ({ firstName: m.MemberFirstName, lastName: m.MemberLastName, memberId: m.MemberMlsId, phone: "" });
const recordOf = async (o: Office) =>
  (await getOfficeForAdmin(staff, o.OfficeKey))!.history
    .map(({ entry: e }) => `${e.ChangeType} ${e.FieldName}: ${e.PreviousValue ?? ""} → ${e.NewValue ?? ""}${e.OsmlsCorrectionReason ? ` (${e.OsmlsCorrectionReason})` : ""}`)
    .reverse();
/** The rule every test here protects: no active agent is in an inactive office. */
const strandedAgents = async () =>
  (
    await db.execute(sql`select count(*)::int as n from "Member" m join "Office" o on o."OfficeKey" = m."OfficeKey"
      where m."OsmlsRole" = 'agent' and m."MemberStatus" = 'Active' and o."OfficeStatus" <> 'Active'`)
  ).rows[0].n;
/** And its twin: no active branch is under an inactive main office. */
const strandedBranches = async () =>
  (
    await db.execute(sql`select count(*)::int as n from "Office" b join "Office" m on m."OfficeKey" = b."MainOfficeKey"
      where b."OfficeStatus" = 'Active' and m."OfficeStatus" <> 'Active'`)
  ).rows[0].n;

beforeAll(async () => {
  delete process.env.SMTP_URL;
  const members = await db.select().from(member);
  staff = members.find((m) => m.MemberMlsId === "ST0001")!;
  agent = members.find((m) => m.MemberMlsId === "AG1001")!;
  suspendedStaff = members.find((m) => m.MemberMlsId === "ST0099")!;
});
afterAll(async () => {
  process.env.SMTP_URL = smtp;
  expect(await strandedAgents()).toBe(0);
  expect(await strandedBranches()).toBe(0);
  // Everyone these tests added is left suspended.
  await db.execute(sql`update "Member" set "MemberStatus" = 'Inactive' where "MemberMlsId" like ${`ZA${run}-%`}`);
  await pool.end();
});

describe("who may administer offices", () => {
  it("refuses everyone but active MLS staff, exactly as if nothing were there", async () => {
    const target = await addOffice();
    const other = await addOffice();
    const mover = await addAgent(target);
    const before = await freshOffice(target);
    for (const viewer of [agent, suspendedStaff, { ...agent, MemberStatus: "Inactive" }, null]) {
      await expect(createOffice(viewer, officeInput())).rejects.toThrow("Not found.");
      await expect(updateOffice(viewer, target.OfficeKey, officeInput())).rejects.toThrow("Not found.");
      await expect(setMainOffice(viewer, target.OfficeKey, other.OfficeKey)).rejects.toThrow("Not found.");
      await expect(setOfficeStatus(viewer, other.OfficeKey, "Inactive", "because")).rejects.toThrow("Not found.");
      await expect(moveMember(viewer, mover.MemberKey, other.OfficeKey, "because")).rejects.toThrow("Not found.");
      expect(await listOfficesForAdmin(viewer)).toBeNull();
      expect(await getOfficeForAdmin(viewer, target.OfficeKey)).toBeNull();
    }
    expect(await freshOffice(target)).toEqual(before);
    expect((await freshMember(mover)).OfficeKey).toBe(target.OfficeKey);
    await expect(updateOffice(staff, NO_SUCH_KEY, officeInput())).rejects.toThrow("Not found.");
    await expect(setOfficeStatus(staff, "nonsense", "Inactive", "because")).rejects.toThrow("Not found.");
    expect(await getOfficeForAdmin(staff, NO_SUCH_KEY)).toBeNull();
  });
});

describe("adding and changing an office", () => {
  it("adds an active main office and records it", async () => {
    const values = officeInput({ phone: " 555-0120 ", city: "Port Alder", state: "WA" });
    const made = await createOffice(staff, values);
    expect(made).toMatchObject({
      OfficeName: values.name, OfficeMlsId: values.officeId, OfficePhone: "555-0120", OfficeCity: "Port Alder",
      OfficeStateOrProvince: "WA", OfficeStatus: "Active", MainOfficeKey: null,
    });
    expect(await recordOf(made)).toEqual(["New Office OfficeStatus:  → Active"]);
  });

  it("changes details and records each, and refuses a duplicate office ID", async () => {
    const made = await addOffice();
    const other = await addOffice();
    await updateOffice(staff, made.OfficeKey, { name: `Zz Renamed ${run}`, officeId: made.OfficeMlsId, phone: "555-0121", city: "Cedar Hollow", state: "" });
    expect(await freshOffice(made)).toMatchObject({ OfficeName: `Zz Renamed ${run}`, OfficePhone: "555-0121", OfficeCity: "Cedar Hollow" });
    expect((await recordOf(made)).slice(1)).toEqual([
      `Office Change OfficeName: ${made.OfficeName} → Zz Renamed ${run}`,
      "Office Change OfficePhone:  → 555-0121",
      "Office Change OfficeCity:  → Cedar Hollow",
    ]);
    // Saving the same again records nothing.
    await updateOffice(staff, made.OfficeKey, { name: `Zz Renamed ${run}`, officeId: made.OfficeMlsId, phone: "555-0121", city: "Cedar Hollow", state: "" });
    expect(await recordOf(made)).toHaveLength(4);
    for (const attempt of [() => updateOffice(staff, made.OfficeKey, officeInput({ officeId: other.OfficeMlsId })), () => createOffice(staff, officeInput({ officeId: other.OfficeMlsId }))]) {
      await expect(attempt()).rejects.toMatchObject({ fieldErrors: { officeId: "Another office already has that office ID." } });
    }
    await expect(createOffice(staff, { ...officeInput(), name: " ", officeId: "" })).rejects.toMatchObject({
      fieldErrors: { name: "A name is required.", officeId: "An office ID is required." },
    });
  });
});

describe("brokerages", () => {
  it("lets a main office have branches, one level deep", async () => {
    const main = await addOffice();
    const branch = await addOffice({ mainOfficeKey: main.OfficeKey });
    const loose = await addOffice();
    expect(branch.MainOfficeKey).toBe(main.OfficeKey);
    await setMainOffice(staff, loose.OfficeKey, main.OfficeKey);
    expect((await freshOffice(loose)).MainOfficeKey).toBe(main.OfficeKey);
    const page = (await getOfficeForAdmin(staff, main.OfficeKey))!;
    expect(page.branches.map((b) => b.OfficeKey).sort()).toEqual([branch.OfficeKey, loose.OfficeKey].sort());
    // Made a main office again.
    await setMainOffice(staff, loose.OfficeKey, "");
    expect((await freshOffice(loose)).MainOfficeKey).toBeNull();
    expect((await recordOf(loose)).slice(1)).toEqual([
      `Brokerage Change MainOfficeKey:  → ${main.OfficeKey}`,
      `Brokerage Change MainOfficeKey: ${main.OfficeKey} → `,
    ]);
    expect(await recordOf(branch)).toEqual(["New Office OfficeStatus:  → Active", `New Office MainOfficeKey:  → ${main.OfficeKey}`]);
  });

  it("refuses a second level, an office as its own main office, and a cycle", async () => {
    const main = await addOffice();
    const branch = await addOffice({ mainOfficeKey: main.OfficeKey });
    const third = await addOffice();
    // Under a branch.
    await expect(setMainOffice(staff, third.OfficeKey, branch.OfficeKey)).rejects.toThrow("is itself a branch, so it cannot be a main office.");
    await expect(createOffice(staff, officeInput({ mainOfficeKey: branch.OfficeKey }))).rejects.toThrow("is itself a branch");
    // An office with branches becoming a branch.
    await expect(setMainOffice(staff, main.OfficeKey, third.OfficeKey)).rejects.toThrow("has branches of its own");
    // Itself.
    await expect(setMainOffice(staff, third.OfficeKey, third.OfficeKey)).rejects.toThrow("An office cannot be its own main office.");
    // A cycle: the main office under its own branch.
    await expect(setMainOffice(staff, main.OfficeKey, branch.OfficeKey)).rejects.toThrow("is itself a branch");
    // Something that is not an office.
    await expect(setMainOffice(staff, third.OfficeKey, NO_SUCH_KEY)).rejects.toThrow("Choose a main office from the list.");
    expect((await freshOffice(main)).MainOfficeKey).toBeNull();
    expect((await freshOffice(third)).MainOfficeKey).toBeNull();
    // The database itself refuses an office as its own main office, and an unknown status.
    await expect(db.update(office).set({ MainOfficeKey: third.OfficeKey }).where(eq(office.OfficeKey, third.OfficeKey))).rejects.toThrow();
    await expect(db.update(office).set({ OfficeStatus: "Closed" }).where(eq(office.OfficeKey, third.OfficeKey))).rejects.toThrow();
  });

  it("refuses an active branch under an inactive main office, by each route", async () => {
    const main = await addOffice();
    const branch = await addOffice({ mainOfficeKey: main.OfficeKey });
    const loose = await addOffice();
    await setOfficeStatus(staff, branch.OfficeKey, "Inactive", "closing");
    await setOfficeStatus(staff, main.OfficeKey, "Inactive", "closing");
    // Adding one.
    await expect(createOffice(staff, officeInput({ mainOfficeKey: main.OfficeKey }))).rejects.toThrow("is inactive, so an active office cannot be put under it.");
    // Moving one under it.
    await expect(setMainOffice(staff, loose.OfficeKey, main.OfficeKey)).rejects.toThrow("is inactive, so an active office cannot be put under it.");
    // Reactivating one that is already under it.
    await expect(setOfficeStatus(staff, branch.OfficeKey, "Active", "reopening")).rejects.toThrow("Its main office");
    expect((await freshOffice(branch)).OfficeStatus).toBe("Inactive");
    // An inactive office may be put under an inactive main office: nothing active depends on it.
    await setOfficeStatus(staff, loose.OfficeKey, "Inactive", "closing");
    await setMainOffice(staff, loose.OfficeKey, main.OfficeKey);
    // Reactivating the main office first, or leaving the brokerage, opens the way.
    await setMainOffice(staff, loose.OfficeKey, "");
    await setOfficeStatus(staff, loose.OfficeKey, "Active", "reopening alone");
    await setOfficeStatus(staff, main.OfficeKey, "Active", "reopening");
    await setOfficeStatus(staff, branch.OfficeKey, "Active", "reopening");
    expect((await freshOffice(branch)).OfficeStatus).toBe("Active");
    expect(await strandedBranches()).toBe(0);
  });
});

describe("deactivating an office", () => {
  it("needs a reason, and is refused while the office has active agents", async () => {
    const target = await addOffice();
    const elsewhere = await addOffice();
    const one = await addAgent(target);
    const two = await addAgent(target);
    for (const reason of ["", "  ", null]) {
      await expect(setOfficeStatus(staff, target.OfficeKey, "Inactive", reason)).rejects.toMatchObject({ fieldErrors: { reason: "A reason is required." } });
    }
    await expect(setOfficeStatus(staff, target.OfficeKey, "Inactive", "closing")).rejects.toThrow(
      `This office has 2 active agents (${one.MemberFullName}, ${two.MemberFullName}). Move or suspend them first.`,
    );
    // One moved, one suspended: nothing is in the way.
    await moveMember(staff, one.MemberKey, elsewhere.OfficeKey, "moving");
    await expect(setOfficeStatus(staff, target.OfficeKey, "Inactive", "closing")).rejects.toThrow("This office has 1 active agent");
    await setMemberStatus(staff, two.MemberKey, "Inactive", "leaving");
    await setOfficeStatus(staff, target.OfficeKey, "Inactive", " Closing the branch ");
    expect((await freshOffice(target)).OfficeStatus).toBe("Inactive");
    // Deactivating again records nothing more.
    await setOfficeStatus(staff, target.OfficeKey, "Inactive", "again");
    await setOfficeStatus(staff, target.OfficeKey, "Active", "Reopened");
    expect((await recordOf(target)).slice(1)).toEqual([
      "Deactivated OfficeStatus: Active → Inactive (Closing the branch)",
      "Reactivated OfficeStatus: Inactive → Active (Reopened)",
    ]);
  });

  it("is refused for a main office with active branches, until they are deactivated or regrouped", async () => {
    const main = await addOffice();
    const first = await addOffice({ mainOfficeKey: main.OfficeKey });
    const second = await addOffice({ mainOfficeKey: main.OfficeKey });
    await expect(setOfficeStatus(staff, main.OfficeKey, "Inactive", "closing")).rejects.toThrow("This main office has 2 active branches");
    await setOfficeStatus(staff, first.OfficeKey, "Inactive", "closing");
    await expect(setOfficeStatus(staff, main.OfficeKey, "Inactive", "closing")).rejects.toThrow(`This main office has 1 active branch (${second.OfficeName})`);
    await setMainOffice(staff, second.OfficeKey, "");
    await setOfficeStatus(staff, main.OfficeKey, "Inactive", "closing");
    expect((await freshOffice(main)).OfficeStatus).toBe("Inactive");
    expect((await freshOffice(second)).OfficeStatus).toBe("Active");
  });

  it("leaves an inactive office unable to be given an agent by any route", async () => {
    const closed = await addOffice();
    const open = await addOffice();
    await setOfficeStatus(staff, closed.OfficeKey, "Inactive", "closed");
    const n = ++serial;
    // Adding a member.
    await expect(
      createMember(staff, { firstName: "No", lastName: "Office", email: `none-${run}-${n}@osmls.example`, memberId: `ZA${run}-${n}`, role: "agent", officeKey: closed.OfficeKey, phone: "" }),
    ).rejects.toMatchObject({ fieldErrors: { officeKey: `${closed.OfficeName} is inactive. Choose an active office.` } });
    // Moving an agent.
    const mover = await addAgent(open);
    await expect(moveMember(staff, mover.MemberKey, closed.OfficeKey, "moving")).rejects.toThrow(`${closed.OfficeName} is inactive. Choose an active office.`);
    // Making MLS staff an agent.
    const official = (await createMember(staff, { firstName: "Staff", lastName: `Person${n}`, email: `staff-${run}-${n}@osmls.example`, memberId: `ZA${run}-s${n}`, role: "staff", officeKey: "", phone: "" })).member;
    await expect(updateMember(staff, official.MemberKey, { ...details(official), role: "agent", officeKey: closed.OfficeKey })).rejects.toMatchObject({
      fieldErrors: { officeKey: `${closed.OfficeName} is inactive. Choose an active office.` },
    });
    expect((await freshMember(official)).OsmlsRole).toBe("staff");
    expect((await freshMember(mover)).OfficeKey).toBe(open.OfficeKey);
    expect(await strandedAgents()).toBe(0);
  });
});

describe("moving an agent", () => {
  it("needs a reason and an agent, and records the move", async () => {
    const from = await addOffice();
    const to = await addOffice();
    const mover = await addAgent(from);
    await expect(moveMember(staff, mover.MemberKey, to.OfficeKey, " ")).rejects.toMatchObject({ fieldErrors: { reason: "A reason is required." } });
    await expect(moveMember(staff, mover.MemberKey, NO_SUCH_KEY, "moving")).rejects.toThrow("Choose an office from the list.");
    await expect(moveMember(staff, staff.MemberKey, to.OfficeKey, "moving")).rejects.toThrow("Only an agent has an office.");
    await expect(moveMember(staff, NO_SUCH_KEY, to.OfficeKey, "moving")).rejects.toThrow("Not found.");
    await moveMember(staff, mover.MemberKey, to.OfficeKey, "Changed brokerage");
    expect((await freshMember(mover)).OfficeKey).toBe(to.OfficeKey);
    // Moving to where they already are records nothing.
    await moveMember(staff, mover.MemberKey, to.OfficeKey, "again");
    const moves = (await db.execute(sql`select "PreviousValue", "NewValue", "OsmlsCorrectionReason" from "HistoryTransactional"
      where "ResourceName" = 'Member' and "ResourceRecordKey" = ${mover.MemberKey} and "ChangeType" = 'Office Move'`)).rows;
    expect(moves).toEqual([{ PreviousValue: from.OfficeKey, NewValue: to.OfficeKey, OsmlsCorrectionReason: "Changed brokerage" }]);
    // The office pages show who is where now.
    expect((await getOfficeForAdmin(staff, to.OfficeKey))!.members.map((m) => m.MemberKey)).toEqual([mover.MemberKey]);
    expect((await getOfficeForAdmin(staff, from.OfficeKey))!.members).toEqual([]);
  });
});

describe("an active agent needs an active office", () => {
  it("refuses to reinstate an agent into an inactive office, until they are moved or it is reactivated", async () => {
    const closing = await addOffice();
    const open = await addOffice();
    const first = await addAgent(closing);
    const second = await addAgent(closing);
    await setMemberStatus(staff, first.MemberKey, "Inactive", "leave");
    await setMemberStatus(staff, second.MemberKey, "Inactive", "leave");
    await setOfficeStatus(staff, closing.OfficeKey, "Inactive", "closed");
    for (const m of [first, second]) {
      await expect(setMemberStatus(staff, m.MemberKey, "Active", "back")).rejects.toThrow(
        `${closing.OfficeName} is inactive, so this agent cannot be reinstated there. Move them to an active office first, or reactivate that office.`,
      );
      expect((await freshMember(m)).MemberStatus).toBe("Inactive");
    }
    // A suspended agent can be moved, and then reinstated.
    await moveMember(staff, first.MemberKey, open.OfficeKey, "to an open office");
    await setMemberStatus(staff, first.MemberKey, "Active", "back");
    expect(await freshMember(first)).toMatchObject({ MemberStatus: "Active", OfficeKey: open.OfficeKey });
    // Or the office is reactivated.
    await setOfficeStatus(staff, closing.OfficeKey, "Active", "reopened");
    await setMemberStatus(staff, second.MemberKey, "Active", "back");
    expect((await freshMember(second)).MemberStatus).toBe("Active");
    expect(await strandedAgents()).toBe(0);
  });

  it("never leaves an active agent in an inactive office when a reinstatement races a deactivation", async () => {
    for (let round = 0; round < 5; round++) {
      const target = await addOffice();
      const returning = await addAgent(target);
      await setMemberStatus(staff, returning.MemberKey, "Inactive", "leave");
      const results = await Promise.allSettled([
        setMemberStatus(staff, returning.MemberKey, "Active", "back"),
        setOfficeStatus(staff, target.OfficeKey, "Inactive", "closing"),
      ]);
      // Whichever went first, the other was refused.
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await strandedAgents()).toBe(0);
    }
  });

  it("never leaves an active agent in an inactive office when a move races a deactivation of the destination", async () => {
    for (let round = 0; round < 5; round++) {
      const from = await addOffice();
      const to = await addOffice();
      const mover = await addAgent(from);
      const results = await Promise.allSettled([
        moveMember(staff, mover.MemberKey, to.OfficeKey, "moving"),
        setOfficeStatus(staff, to.OfficeKey, "Inactive", "closing"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await strandedAgents()).toBe(0);
      const [now, destination] = [await freshMember(mover), await freshOffice(to)];
      // Either they moved and the office stayed open, or it closed and they stayed put.
      expect(now.OfficeKey === to.OfficeKey ? destination.OfficeStatus : "Active").toBe("Active");
    }
  });

  it("never leaves an active branch under an inactive main office when a regrouping races a deactivation", async () => {
    for (let round = 0; round < 5; round++) {
      const main = await addOffice();
      const loose = await addOffice();
      const results = await Promise.allSettled([
        setMainOffice(staff, loose.OfficeKey, main.OfficeKey),
        setOfficeStatus(staff, main.OfficeKey, "Inactive", "closing"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await strandedBranches()).toBe(0);
    }
  });
});

describe("finding offices", () => {
  it("finds offices by name, office ID, city, status, and brokerage, with their active agents counted", async () => {
    const main = await addOffice({ city: `Findville${run}` });
    const branch = await addOffice({ mainOfficeKey: main.OfficeKey });
    const other = await addOffice();
    const working = await addAgent(main);
    const suspended = await addAgent(main);
    await setMemberStatus(staff, suspended.MemberKey, "Inactive", "leave");
    await addAgent(other);
    const found = async (filters: Parameters<typeof listOfficesForAdmin>[1]) =>
      (await listOfficesForAdmin(staff, filters))!.map((r) => `${r.office.OfficeMlsId}:${r.activeAgents}:${r.mainOfficeName ?? "main"}`);
    expect(await found({ q: main.OfficeMlsId })).toEqual([`${main.OfficeMlsId}:1:main`]);
    expect(await found({ q: `findville${run}` })).toEqual([`${main.OfficeMlsId}:1:main`]);
    expect(await found({ q: main.OfficeName.toUpperCase() })).toEqual([`${main.OfficeMlsId}:1:main`]);
    expect(await found({ brokerage: main.OfficeKey })).toEqual([`${main.OfficeMlsId}:1:main`, `${branch.OfficeMlsId}:0:${main.OfficeName}`]);
    expect(await found({ brokerage: main.OfficeKey, status: "Inactive" })).toEqual([]);
    expect(await found({ q: other.OfficeMlsId, status: "Active" })).toEqual([`${other.OfficeMlsId}:1:main`]);
    expect(await found({ q: "%" })).toEqual([]);
    expect((await found({ status: "Open", brokerage: "nonsense" })).length).toBeGreaterThan(3);
    void working;
  });
});
