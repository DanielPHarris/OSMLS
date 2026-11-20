/*
 * Staff capabilities against the test database: what each one allows and
 * nothing more, that they count only on an active staff account, that managing
 * members cannot become managing staff, that someone can always manage staff,
 * and that all of it is decided inside the protected operation, not from what
 * the request saw when it arrived.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { member, office, property, verification, type Member } from "../src/db/schema";
import { closeFlag, getRelistingLink, listFlags, raiseFlag, setRelistingLink } from "../src/lib/compliance";
import { createDataConsumer, listDataConsumers, revokeDataConsumer } from "../src/lib/data-exchange";
import { CAPABILITIES, type Capability } from "../src/lib/lookups";
import {
  changeMemberEmail,
  createMember,
  getMemberForAdmin,
  getMemberHistory,
  listMembers,
  moveMember,
  sendPasswordLink,
  setCapabilities,
  setMemberStatus,
  updateMember,
} from "../src/lib/members";
import { createOffice, getOfficeForAdmin, listOfficesForAdmin, setMainOffice, setOfficeStatus, updateOffice } from "../src/lib/offices";
import { getSettingsForAdmin, getSettingsHistory, saveMarketTimeSettings } from "../src/lib/settings";
import { latestSettings } from "../src/lib/market-time";
import { AUTHORITY_TURN, overlapping } from "./overlap";

const run = Date.now();
let admin: Member;
let offices: { OfficeKey: string; OfficeName: string }[];
let listingKey: string;
let serial = 0;
const smtp = process.env.SMTP_URL;

const fresh = async (m: Member) => (await db.select().from(member).where(eq(member.MemberKey, m.MemberKey)))[0];
const input = (changes: Record<string, string> = {}) => {
  const n = ++serial;
  return {
    firstName: "Perm", lastName: `Member${n}`, email: `perm-${run}-${n}@osmls.example`, memberId: `P${run}-${n}`,
    role: "agent", officeKey: offices[0].OfficeKey, phone: "", ...changes,
  };
};
const details = (m: Member, changes: Record<string, string> = {}) => ({
  firstName: m.MemberFirstName, lastName: m.MemberLastName, memberId: m.MemberMlsId, phone: m.MemberDirectPhone ?? "",
  role: m.OsmlsRole, officeKey: m.OfficeKey ?? "", ...changes,
});
const anAgent = async () => (await createMember(admin, input())).member;
/** A staff account holding exactly these capabilities. */
async function staffWith(...held: Capability[]) {
  const made = (await createMember(admin, input({ role: "staff", officeKey: "" }))).member;
  if (held.length > 0) await setCapabilities(admin, made.MemberKey, held, "test");
  return fresh(made);
}
const anOffice = () => createOffice(admin, { name: `Perm Office ${run}-${++serial}`, officeId: `PO${run}-${serial}`, phone: "", mainOfficeKey: "" });
const settingsInput = async (changes: Record<string, unknown> = {}) => {
  const { version, ...now } = await latestSettings();
  return { version, values: { ...now, ...changes } };
};
const refused = (work: Promise<unknown>) => expect(work).rejects.toThrow("Not found.");

beforeAll(async () => {
  delete process.env.SMTP_URL;
  const members = await db.select().from(member);
  admin = members.find((m) => m.MemberMlsId === "ST0001")!;
  offices = await db.select().from(office).where(eq(office.OfficeStatus, "Active")).orderBy(office.OfficeName);
  [{ listingKey }] = await db.select({ listingKey: property.ListingKey }).from(property).where(eq(property.StreetName, "Comparable Ct")).limit(1);
});
afterAll(async () => {
  process.env.SMTP_URL = smtp;
  // Everyone these tests added is left suspended and holding nothing.
  await db.update(member).set({ MemberStatus: "Inactive", OsmlsCapabilities: [] }).where(sql`${member.MemberMlsId} like ${`P${run}-%`}`);
  await pool.end();
});

/*
 * One probe per administrative operation: the capability it takes, and a way
 * to try it as a given member. A probe resolves if it was allowed and rejects
 * with "Not found." (or answers null) if it was not.
 */
type Probe = { name: string; needs: Capability | "members-or-staff"; attempt: (as: Member | null) => Promise<unknown> };
const found = async (answer: Promise<unknown>) => {
  if ((await answer) == null) throw new Error("Not found.");
};
const probes: Probe[] = [
  { name: "list members", needs: "members-or-staff", attempt: (as) => found(listMembers(as)) },
  { name: "open a member", needs: "members-or-staff", attempt: async (as) => found(getMemberForAdmin(as, (await anAgent()).MemberKey)) },
  { name: "read a member's change record", needs: "members-or-staff", attempt: async (as) => found(getMemberHistory(as, (await anAgent()).MemberKey)) },
  { name: "add an agent", needs: "members", attempt: (as) => createMember(as, input()) },
  { name: "edit an agent", needs: "members", attempt: async (as) => { const t = await anAgent(); await updateMember(as, t.MemberKey, details(t, { phone: "555-0100" })); } },
  { name: "change an agent's email", needs: "members", attempt: async (as) => changeMemberEmail(as, (await anAgent()).MemberKey, `moved-${run}-${++serial}@osmls.example`) },
  { name: "send an agent a password link", needs: "members", attempt: async (as) => sendPasswordLink(as, (await anAgent()).MemberKey) },
  { name: "suspend an agent", needs: "members", attempt: async (as) => setMemberStatus(as, (await anAgent()).MemberKey, "Inactive", "probe") },
  { name: "move an agent", needs: "members", attempt: async (as) => moveMember(as, (await anAgent()).MemberKey, offices[1].OfficeKey, "probe") },
  { name: "add a staff account", needs: "staff", attempt: (as) => createMember(as, input({ role: "staff", officeKey: "" })) },
  { name: "make an agent staff", needs: "staff", attempt: async (as) => { const t = await anAgent(); await updateMember(as, t.MemberKey, details(t, { role: "staff", officeKey: "" })); } },
  { name: "make staff an agent", needs: "staff", attempt: async (as) => { const t = await staffWith(); await updateMember(as, t.MemberKey, details(t, { role: "agent", officeKey: offices[0].OfficeKey })); } },
  { name: "edit a staff account", needs: "staff", attempt: async (as) => { const t = await staffWith(); await updateMember(as, t.MemberKey, details(t, { phone: "555-0100" })); } },
  { name: "change a staff account's email", needs: "staff", attempt: async (as) => changeMemberEmail(as, (await staffWith()).MemberKey, `moved-${run}-${++serial}@osmls.example`) },
  { name: "send a staff account a password link", needs: "staff", attempt: async (as) => sendPasswordLink(as, (await staffWith()).MemberKey) },
  { name: "suspend a staff account", needs: "staff", attempt: async (as) => setMemberStatus(as, (await staffWith()).MemberKey, "Inactive", "probe") },
  { name: "grant a capability", needs: "staff", attempt: async (as) => setCapabilities(as, (await staffWith()).MemberKey, ["offices"], "probe") },
  { name: "list offices", needs: "offices", attempt: (as) => found(listOfficesForAdmin(as)) },
  { name: "open an office", needs: "offices", attempt: (as) => found(getOfficeForAdmin(as, offices[0].OfficeKey)) },
  { name: "add an office", needs: "offices", attempt: (as) => createOffice(as, { name: `Probe ${run}-${++serial}`, officeId: `PR${run}-${serial}`, phone: "", mainOfficeKey: "" }) },
  { name: "edit an office", needs: "offices", attempt: async (as) => { const o = await anOffice(); await updateOffice(as, o.OfficeKey, { name: `${o.OfficeName} edited`, officeId: o.OfficeMlsId, phone: "" }); } },
  { name: "put an office under a main office", needs: "offices", attempt: async (as) => setMainOffice(as, (await anOffice()).OfficeKey, (await anOffice()).OfficeKey) },
  { name: "deactivate an office", needs: "offices", attempt: async (as) => setOfficeStatus(as, (await anOffice()).OfficeKey, "Inactive", "probe") },
  { name: "open the flag queue", needs: "compliance", attempt: (as) => found(listFlags(as)) },
  { name: "read a listing's relisting link", needs: "compliance", attempt: (as) => found(getRelistingLink(as, listingKey)) },
  { name: "close a flag", needs: "compliance", attempt: async (as) => closeFlag(as, (await raiseFlag(await anAgent(), listingKey, { category: "Other", description: "probe" })).FlagKey, "Dismissed", "probe") },
  // Saying again what is already so stores nothing, but is refused all the same without the capability.
  { name: "change a relisting link", needs: "compliance", attempt: (as) => setRelistingLink(as, listingKey, { mode: "automatic" }, "probe") },
  { name: "list data consumers", needs: "data", attempt: (as) => found(listDataConsumers(as)) },
  { name: "add a data consumer", needs: "data", attempt: (as) => createDataConsumer(as, { name: `Probe ${run}-${++serial}` }) },
  { name: "revoke a data consumer", needs: "data", attempt: async (as) => revokeDataConsumer(as, (await createDataConsumer(admin, { name: `Probe ${run}-${++serial}` })).consumer.ConsumerKey) },
  { name: "open the settings", needs: "settings", attempt: (as) => found(getSettingsForAdmin(as)) },
  { name: "read the settings record", needs: "settings", attempt: (as) => found(getSettingsHistory(as)) },
  // Saving the values already in force stores nothing, but is refused all the same without the capability.
  { name: "save the settings", needs: "settings", attempt: async (as) => { const s = await settingsInput(); await saveMarketTimeSettings(as, s.values, s.version, "probe"); } },
];
const allows = (held: readonly Capability[], needs: Probe["needs"]) =>
  needs === "members-or-staff" ? held.includes("members") || held.includes("staff") : held.includes(needs);

describe("what each capability allows", () => {
  for (const capability of CAPABILITIES) {
    it(`"${capability}" alone allows its own operations and no others`, async () => {
      const holder = await staffWith(capability);
      for (const probe of probes) {
        const attempt = probe.attempt(holder);
        if (allows([capability], probe.needs)) await expect(attempt, probe.name).resolves.not.toThrow();
        else await expect(attempt, probe.name).rejects.toThrow("Not found.");
      }
    });
  }

  it("a staff account holding none is refused everything", async () => {
    const holder = await staffWith();
    for (const probe of probes) await expect(probe.attempt(holder), probe.name).rejects.toThrow("Not found.");
  });

  it("capabilities recorded on an agent or on a suspended account allow nothing", async () => {
    const agent = await anAgent();
    await db.update(member).set({ OsmlsCapabilities: [...CAPABILITIES] }).where(eq(member.MemberKey, agent.MemberKey));
    const suspended = await staffWith(...CAPABILITIES);
    await setMemberStatus(admin, suspended.MemberKey, "Inactive", "test");
    for (const viewer of [await fresh(agent), await fresh(suspended), null]) {
      expect(viewer?.OsmlsCapabilities ?? CAPABILITIES).toEqual([...CAPABILITIES]);
      for (const probe of probes) await expect(probe.attempt(viewer), probe.name).rejects.toThrow("Not found.");
    }
  });

  it("is read from the account as it is now, not from what the session held", async () => {
    const holder = await staffWith(...CAPABILITIES);
    await setCapabilities(admin, holder.MemberKey, [], "revoked");
    // `holder` still says it holds everything, as a page loaded before the revocation would.
    expect(holder.OsmlsCapabilities).toEqual([...CAPABILITIES]);
    for (const probe of probes.filter((p) => p.name.match(/^(add|edit|change|close|revoke|send|suspend|move|make|grant|put|deactivate|save)/)))
      await expect(probe.attempt(holder), probe.name).rejects.toThrow("Not found.");
  });
});

describe("granting and holding capabilities", () => {
  it("starts a new staff account with none, and records each change with its reason", async () => {
    const made = (await createMember(admin, input({ role: "staff", officeKey: "" }))).member;
    expect(made.OsmlsCapabilities).toEqual([]);
    await setCapabilities(admin, made.MemberKey, ["settings", "members"], "covering the desk");
    expect((await fresh(made)).OsmlsCapabilities).toEqual(["members", "settings"]);
    await setCapabilities(admin, made.MemberKey, ["members"], "desk covered");
    // Saving what is already held records nothing.
    await setCapabilities(admin, made.MemberKey, ["members"], "again");
    const record = (await getMemberHistory(admin, made.MemberKey))!
      .filter(({ entry }) => entry.FieldName === "OsmlsCapabilities")
      .map(({ entry: e, changedByName }) => `${e.ChangeType}: ${e.PreviousValue ?? ""} → ${e.NewValue ?? ""} (${e.OsmlsCorrectionReason}) by ${changedByName}`)
      .reverse();
    expect(record).toEqual([
      `Capabilities Change:  → members, settings (covering the desk) by ${admin.MemberFullName}`,
      `Capabilities Change: members, settings → members (desk covered) by ${admin.MemberFullName}`,
    ]);
  });

  it("needs a reason, a real capability, and a staff account", async () => {
    const target = await staffWith();
    await expect(setCapabilities(admin, target.MemberKey, ["members"], "  ")).rejects.toThrow("Give a reason.");
    await expect(setCapabilities(admin, target.MemberKey, ["everything"], "why")).rejects.toThrow("Choose from the capabilities listed.");
    await expect(setCapabilities(admin, (await anAgent()).MemberKey, ["members"], "why")).rejects.toThrow("Only MLS staff hold capabilities.");
    expect((await fresh(target)).OsmlsCapabilities).toEqual([]);
  });

  it("takes every capability away when staff are made an agent, so none wait for them", async () => {
    const target = await staffWith("members", "offices");
    await updateMember(admin, target.MemberKey, details(target, { role: "agent", officeKey: offices[0].OfficeKey }));
    expect(await fresh(target)).toMatchObject({ OsmlsRole: "agent", OsmlsCapabilities: [] });
    await updateMember(admin, target.MemberKey, details(await fresh(target), { role: "staff", officeKey: "" }));
    expect(await fresh(target)).toMatchObject({ OsmlsRole: "staff", OsmlsCapabilities: [] });
  });

  it("lets an administrator give up managing staff while another administrator remains", async () => {
    const me = await staffWith("staff", "members");
    await setCapabilities(me, me.MemberKey, ["members"], "stepping back");
    expect((await fresh(me)).OsmlsCapabilities).toEqual(["members"]);
    // Having given it up, they cannot take it back.
    await refused(setCapabilities(me, me.MemberKey, ["members", "staff"], "changed my mind"));
  });
});

describe("someone can always manage staff", () => {
  /** Runs with `keep` as the only accounts that can manage staff, then puts everyone else's capabilities back. */
  async function asTheOnlyAdministrators<T>(keep: Member[], work: () => Promise<T>): Promise<T> {
    const keys = keep.map((m) => m.MemberKey);
    const others = (await db.select().from(member)).filter((m) => m.OsmlsCapabilities.includes("staff") && !keys.includes(m.MemberKey));
    await db
      .update(member)
      .set({ OsmlsCapabilities: sql`array_remove(${member.OsmlsCapabilities}, 'staff')` })
      .where(inArray(member.MemberKey, others.map((m) => m.MemberKey)));
    try {
      return await work();
    } finally {
      for (const m of others) await db.update(member).set({ OsmlsCapabilities: m.OsmlsCapabilities }).where(eq(member.MemberKey, m.MemberKey));
    }
  }
  const administrators = async (among: Member[]) => {
    const now = await db.select().from(member).where(inArray(member.MemberKey, among.map((m) => m.MemberKey)));
    return now.filter((m) => m.OsmlsRole === "staff" && m.MemberStatus === "Active" && m.OsmlsCapabilities.includes("staff")).length;
  };

  it("refuses to revoke, suspend, or demote the last account that can manage staff", async () => {
    const last = await staffWith("staff", "members");
    const helper = await staffWith("members");
    const dormant = await staffWith();
    await asTheOnlyAdministrators([last], async () => {
      const message = /last active account that can manage staff/;
      await expect(setCapabilities(last, last.MemberKey, ["members"], "leaving")).rejects.toThrow(message);
      // A suspended administrator does not count as one who remains.
      await db.update(member).set({ OsmlsCapabilities: ["staff"], MemberStatus: "Inactive" }).where(eq(member.MemberKey, dormant.MemberKey));
      await expect(setCapabilities(last, last.MemberKey, ["members"], "leaving")).rejects.toThrow(message);
      // No one else can reach them either: acting on staff takes the capability only they hold.
      await refused(setMemberStatus(helper, last.MemberKey, "Inactive", "no"));
      await refused(updateMember(helper, last.MemberKey, details(last, { role: "agent", officeKey: offices[0].OfficeKey })));
      expect(await administrators([last])).toBe(1);
    });
  });

  it("leaves one administrator when two each revoke the other at the same moment", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await staffWith("staff");
      const b = await staffWith("staff");
      await asTheOnlyAdministrators([a, b], async () => {
        const results = await Promise.allSettled([
          setCapabilities(a, b.MemberKey, [], "race"),
          setCapabilities(b, a.MemberKey, [], "race"),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(await administrators([a, b])).toBe(1);
      });
    }
  });

  it("leaves one administrator when one gives it up while the other is being suspended or demoted", async () => {
    for (let round = 0; round < 6; round++) {
      const a = await staffWith("staff");
      const b = await staffWith("staff");
      await asTheOnlyAdministrators([a, b], async () => {
        const other =
          round % 2 === 0
            ? setMemberStatus(a, b.MemberKey, "Inactive", "race")
            : updateMember(a, b.MemberKey, details(b, { role: "agent", officeKey: offices[0].OfficeKey }));
        const results = await Promise.allSettled([setCapabilities(a, a.MemberKey, [], "race"), other]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(await administrators([a, b])).toBe(1);
      });
    }
  });
});

/*
 * Overlaps made certain rather than likely. A second connection takes the lock
 * the operation needs, the operation is started and left waiting on it, the
 * second connection makes its change and commits, and only then does the
 * operation go on. What the operation then does shows what it read, and when.
 */
describe("authority and the target are read inside the protected operation", () => {
  const rowOf = (m: Member) => `select 1 from "Member" where "MemberKey" = '${m.MemberKey}' for update`;
  const becomesStaff = (m: Member) => `update "Member" set "OsmlsRole" = 'staff', "OfficeKey" = null where "MemberKey" = '${m.MemberKey}'`;
  const losesEverything = (m: Member) => `update "Member" set "OsmlsCapabilities" = '{}' where "MemberKey" = '${m.MemberKey}'`;

  it("refuses an email change that was waiting when its target became staff", async () => {
    const holder = await staffWith("members");
    const target = await anAgent();
    const result = await overlapping(AUTHORITY_TURN, becomesStaff(target), () =>
      changeMemberEmail(holder, target.MemberKey, `takeover-${run}@osmls.example`),
    );
    expect(result).toMatchObject({ status: "rejected", reason: { message: "Not found." } });
    expect(await fresh(target)).toMatchObject({ OsmlsRole: "staff", MemberEmail: target.MemberEmail });
  });

  it("refuses a password link that was waiting when its target became staff", async () => {
    const holder = await staffWith("members");
    const target = await anAgent();
    const result = await overlapping(rowOf(target), becomesStaff(target), () => sendPasswordLink(holder, target.MemberKey));
    expect(result).toMatchObject({ status: "rejected", reason: { message: "Not found." } });
    const record = (await getMemberHistory(admin, target.MemberKey))!.map(({ entry }) => entry.ChangeType);
    expect(record).not.toContain("Password Link Sent");
  });

  it("refuses a suspension, an edit, and a role change that were waiting when their target became staff", async () => {
    const holder = await staffWith("members");
    for (const operation of [
      (t: Member) => setMemberStatus(holder, t.MemberKey, "Inactive", "takeover"),
      (t: Member) => updateMember(holder, t.MemberKey, details(t, { phone: "555-0111" })),
    ]) {
      const target = await anAgent();
      const result = await overlapping(AUTHORITY_TURN, becomesStaff(target), () => operation(target));
      expect(result).toMatchObject({ status: "rejected", reason: { message: "Not found." } });
      expect(await fresh(target)).toMatchObject({ MemberStatus: "Active", MemberDirectPhone: target.MemberDirectPhone });
    }
  });

  it("refuses each kind of action that was waiting when the acting member's capability was revoked", async () => {
    const waitingActions: [Capability, string, (holder: Member) => Promise<{ lock: string; act: () => Promise<unknown>; unchanged: () => Promise<void> }>][] = [
      ["members", "a suspension", async (holder) => {
        const t = await anAgent();
        return { lock: AUTHORITY_TURN, act: () => setMemberStatus(holder, t.MemberKey, "Inactive", "late"), unchanged: async () => expect((await fresh(t)).MemberStatus).toBe("Active") };
      }],
      ["members", "an email change", async (holder) => {
        const t = await anAgent();
        return { lock: AUTHORITY_TURN, act: () => changeMemberEmail(holder, t.MemberKey, `late-${run}-${++serial}@osmls.example`), unchanged: async () => expect((await fresh(t)).MemberEmail).toBe(t.MemberEmail) };
      }],
      ["members", "a password link", async (holder) => {
        const t = await anAgent();
        return {
          lock: rowOf(t),
          act: () => sendPasswordLink(holder, t.MemberKey),
          unchanged: async () => expect((await getMemberHistory(admin, t.MemberKey))!.map(({ entry }) => entry.ChangeType)).not.toContain("Password Link Sent"),
        };
      }],
      // The revocation holds the turn, as the real one does, and not the target's row.
      ["members", "a password link, with the revocation holding the authority turn", async (holder) => {
        const t = await anAgent();
        const links = async () => (await db.select().from(verification).where(eq(verification.value, t.OsmlsUserId))).map((l) => l.id);
        const welcomeLink = await links();
        return {
          lock: AUTHORITY_TURN,
          act: () => sendPasswordLink(holder, t.MemberKey),
          unchanged: async () => {
            expect((await getMemberHistory(admin, t.MemberKey))!.map(({ entry }) => entry.ChangeType)).not.toContain("Password Link Sent");
            // Still only the link made with the account: no new one was issued.
            expect(await links()).toEqual(welcomeLink);
          },
        };
      }],
      ["staff", "a grant", async (holder) => {
        const t = await staffWith();
        return { lock: AUTHORITY_TURN, act: () => setCapabilities(holder, t.MemberKey, [...CAPABILITIES], "late"), unchanged: async () => expect((await fresh(t)).OsmlsCapabilities).toEqual([]) };
      }],
      ["offices", "an office deactivation", async (holder) => {
        const o = await anOffice();
        return {
          lock: AUTHORITY_TURN,
          act: () => setOfficeStatus(holder, o.OfficeKey, "Inactive", "late"),
          unchanged: async () => expect((await db.select().from(office).where(eq(office.OfficeKey, o.OfficeKey)))[0].OfficeStatus).toBe("Active"),
        };
      }],
      ["settings", "a settings change", async (holder) => {
        const before = await latestSettings();
        const s = await settingsInput({ relistingGapDays: before.relistingGapDays + 1 });
        return { lock: AUTHORITY_TURN, act: () => saveMarketTimeSettings(holder, s.values, s.version, "late"), unchanged: async () => expect(await latestSettings()).toEqual(before) };
      }],
    ];
    for (const [capability, name, prepare] of waitingActions) {
      const holder = await staffWith(capability);
      const { lock, act, unchanged } = await prepare(holder);
      const result = await overlapping(lock, losesEverything(holder), act);
      expect(result, name).toMatchObject({ status: "rejected", reason: { message: "Not found." } });
      await unchanged();
    }
  });
});
