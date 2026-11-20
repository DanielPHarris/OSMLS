import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "../db";
import { historyTransactional, member, office, user, verification, type Member } from "../db/schema";
import { canAdminister } from "./access";
import { auth } from "./auth";
import { ListingError } from "./listings";
import { MEMBER_STATUSES, ROLES } from "./lookups";
import { MailError, appUrl, mailEnabled, sendMail } from "./mail";
import { MIN_PASSWORD_LENGTH, PASSWORD_LINK_HOURS } from "./rules/local";

/*
 * Member administration: adding members, and suspending or reinstating their
 * access. Only MLS staff may (canAdminister in src/lib/access.ts); anyone else
 * is answered as if the thing did not exist.
 *
 * Staff never type a member's password. A member sets their own through a
 * one-time link. The sign-in library keeps the link (as a hash) and spends it;
 * this file makes it, delivers it, and ends any earlier one.
 *
 * Suspension denies access through any session the member has; it does not
 * delete the session, so reinstating restores access without a new sign-in.
 *
 * A change to anyone's status or role is taken in turn across the whole MLS,
 * and the acting staff member's own authority is read again inside that turn,
 * so two staff acting on each other at once cannot both succeed.
 */

const notFound = () => new ListingError("Not found.");
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

/** Held to the end of the transaction: one status or role change at a time. */
export const takeAuthorityTurn = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('osmls:member:authority'))`);

/** The acting member as they are now, inside the turn. Throws unless they may administer. */
export async function actingStaff(tx: Tx, actor: Member | null): Promise<Member> {
  if (!actor) throw notFound();
  const [now] = await tx.select().from(member).where(eq(member.MemberKey, actor.MemberKey));
  if (!now || !canAdminister(now)) throw notFound();
  return now;
}

export type Change = { field: string; previous: string | null; next: string | null; type: string; reason?: string };

/** Writes administrative changes to a member or an office into the change history. */
export const recordChanges = (tx: Tx, actor: Member, resource: "Member" | "Office", target: { key: string; id: string }, changes: Change[]) =>
  tx.insert(historyTransactional).values(
    changes.map((c) => ({
      ResourceName: resource,
      ResourceRecordKey: target.key,
      ResourceRecordID: target.id,
      ClassName: resource,
      FieldName: c.field,
      PreviousValue: c.previous,
      NewValue: c.next,
      ChangeType: c.type,
      ChangedByMemberKey: actor.MemberKey,
      ChangedByMemberID: actor.MemberMlsId,
      OsmlsCorrectionReason: c.reason ?? null,
    })),
  );
const record = (tx: Tx, actor: Member, target: Pick<Member, "MemberKey" | "MemberMlsId">, changes: Change[]) =>
  recordChanges(tx, actor, "Member", { key: target.MemberKey, id: target.MemberMlsId }, changes);

export function checkedReason(reason: unknown): string {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new ListingError("Give a reason.", { reason: "A reason is required." });
  if (why.length > 500) throw new ListingError("Keep the reason to 500 characters.", { reason: "Use 500 characters or fewer." });
  return why;
}

const emailInput = z.email("Enter one email address.").max(254).transform((v) => v.toLowerCase());
const detailsInput = z.object({
  firstName: z.string().trim().min(1, "A first name is required.").max(80),
  lastName: z.string().trim().min(1, "A last name is required.").max(80),
  memberId: z.string().trim().min(1, "A member ID is required.").max(40),
  role: z.enum(ROLES, "Choose a role."),
  officeKey: z.string().trim().default(""),
  phone: z.string().trim().max(40).default(""),
});
const memberInput = detailsInput.extend({ email: emailInput });

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const errors = Object.fromEntries(result.error.issues.map((i) => [String(i.path[0] ?? "email"), i.message]));
  throw new ListingError("Check the fields marked below.", errors);
}

/** The office an agent is being put in. It must exist and be active: an active agent is never in an inactive office. */
async function officeFor(tx: Tx, officeKey: string): Promise<string> {
  const [found] = isKey(officeKey) ? await tx.select().from(office).where(eq(office.OfficeKey, officeKey)) : [];
  if (!found) throw new ListingError("Check the fields marked below.", { officeKey: "An agent needs an office." });
  if (found.OfficeStatus !== "Active") {
    throw new ListingError("Check the fields marked below.", { officeKey: `${found.OfficeName} is inactive. Choose an active office.` });
  }
  return found.OfficeKey;
}

/** The last active staff account may not be suspended or made an agent. */
async function keepOneStaff(tx: Tx, target: Member, doing: string) {
  if (target.OsmlsRole !== "staff" || target.MemberStatus !== "Active") return;
  const [{ others }] = await tx
    .select({ others: sql<number>`count(*)::int` })
    .from(member)
    .where(sql`${member.OsmlsRole} = 'staff' and ${member.MemberStatus} = 'Active' and ${member.MemberKey} <> ${target.MemberKey}`);
  if (others === 0) throw new ListingError(`This is the last active MLS staff account, so it cannot be ${doing}.`);
}

function translateDuplicate(err: unknown): never {
  const duplicate = duplicateOf(err);
  if (duplicate === "email") throw new ListingError("Check the fields marked below.", { email: "Another member already has that email address." });
  if (duplicate === "memberId") throw new ListingError("Check the fields marked below.", { memberId: "Another member already has that member ID." });
  throw err;
}

/** For a database refusal of a duplicate, which field it was. */
function duplicateOf(err: unknown): "email" | "memberId" | null {
  const cause = (err as { cause?: { code?: string; constraint?: string } }).cause ?? (err as { code?: string; constraint?: string });
  if (cause?.code !== "23505") return null;
  return /MlsId/i.test(cause.constraint ?? "") ? "memberId" : "email";
}

export type PasswordLink = {
  /** Where the link was emailed, or null if email is off and it must be passed on by hand. */
  emailedTo: string | null;
  /** Set only when it was not emailed: shown once to the staff member. */
  link: string | null;
};

/**
 * Makes a one-time link for a member to set their password, ending any earlier
 * one, and emails it. With email off, the link comes back to be passed on.
 *
 * Making the link is one protected step per member: the member's row is locked,
 * their identity is read as it is at that moment, the earlier link is ended, and
 * the new one is stored, before anything else may issue a link for them or
 * change their email. So a link is always for the address the member has when
 * it is made, and only the newest link works. The email is sent after that
 * step, to the address read inside it.
 *
 * `inside` runs within the step, for a check or a record that must go with it.
 */
async function issuePasswordLink(
  memberKey: string,
  why: "welcome" | "reset",
  inside?: (tx: Tx, target: Member) => Promise<void>,
): Promise<PasswordLink> {
  const token = randomBytes(32).toString("base64url");
  const target = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(member).where(eq(member.MemberKey, memberKey)).for("update");
    if (!row) throw notFound();
    await inside?.(tx, row);
    // The sign-in library stores the link on a connection of its own, so both
    // writes are made outside this transaction while it holds the member's lock.
    // If the step fails between them, the member is left with no link, never two.
    await db.delete(verification).where(eq(verification.value, row.OsmlsUserId));
    await (await auth.$context).internalAdapter.createVerificationValue({
      value: row.OsmlsUserId,
      identifier: `reset-password:${token}`,
      expiresAt: new Date(Date.now() + PASSWORD_LINK_HOURS * 60 * 60 * 1000),
    });
    return row;
  });
  const link = `${appUrl()}/set-password/${token}`;
  if (!mailEnabled()) return { emailedTo: null, link };
  try {
    await sendMail({
      to: target.MemberEmail,
      subject: why === "welcome" ? "Set your OSMLS password" : "Reset your OSMLS password",
      text: [
        why === "welcome"
          ? `${target.MemberFullName}, an OSMLS account has been made for you. Choose your password here:`
          : `${target.MemberFullName}, MLS staff sent you this link to choose a new OSMLS password:`,
        "",
        link,
        "",
        `The link works once, for ${PASSWORD_LINK_HOURS} hours. If you were not expecting it, ignore this email and tell MLS staff.`,
      ].join("\n"),
    });
  } catch (err) {
    if (!(err instanceof MailError)) throw err;
    // Whether or not it was delivered, staff are handed the link to pass on.
    return { emailedTo: null, link };
  }
  return { emailedTo: target.MemberEmail, link: null };
}

/** Adds a member and sends them a link to set their password. */
export async function createMember(actor: Member | null, input: unknown): Promise<{ member: Member; passwordLink: PasswordLink }> {
  if (!canAdminister(actor)) throw notFound();
  const v = parsed(memberInput, input);
  const name = `${v.firstName} ${v.lastName}`;
  let created: Member;
  try {
    created = await db.transaction(async (tx) => {
      await takeAuthorityTurn(tx);
      const by = await actingStaff(tx, actor);
      const officeKey = v.role === "agent" ? await officeFor(tx, v.officeKey) : null;
      // The sign-in identity and the member record are made together or not at all.
      const [account] = await tx.insert(user).values({ id: randomUUID(), name, email: v.email }).returning();
      const [row] = await tx
        .insert(member)
        .values({
          MemberMlsId: v.memberId,
          MemberFirstName: v.firstName,
          MemberLastName: v.lastName,
          MemberFullName: name,
          MemberEmail: v.email,
          MemberDirectPhone: v.phone || null,
          OfficeKey: officeKey,
          OsmlsRole: v.role,
          OsmlsUserId: account.id,
        })
        .returning();
      await record(tx, by, row, [{ field: "MemberStatus", previous: null, next: "Active", type: "New Member" }]);
      return row;
    });
  } catch (err) {
    translateDuplicate(err);
  }
  return { member: created, passwordLink: await issuePasswordLink(created.MemberKey, "welcome") };
}

export type MemberFilters = { q?: string; role?: string; status?: string; office?: string };

/** Members for the administration list, narrowed by whatever was asked for. Null for anyone who may not administer. */
export async function listMembers(actor: Member | null, filters: MemberFilters = {}) {
  if (!canAdminister(actor)) return null;
  const q = filters.q?.trim();
  const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  return db
    .select({ member, officeName: office.OfficeName })
    .from(member)
    .leftJoin(office, eq(office.OfficeKey, member.OfficeKey))
    .where(
      and(
        like ? or(ilike(member.MemberFullName, like), ilike(member.MemberEmail, like), ilike(member.MemberMlsId, like)) : undefined,
        (ROLES as readonly string[]).includes(filters.role ?? "") ? eq(member.OsmlsRole, filters.role!) : undefined,
        (MEMBER_STATUSES as readonly string[]).includes(filters.status ?? "") ? eq(member.MemberStatus, filters.status!) : undefined,
        isKey(filters.office) ? eq(member.OfficeKey, filters.office) : undefined,
      ),
    )
    .orderBy(asc(member.MemberLastName), asc(member.MemberFirstName));
}

/** A member's administrative change record, newest first. Null for anyone who may not administer. */
export async function getMemberHistory(actor: Member | null, key: unknown) {
  if (!canAdminister(actor) || !isKey(key)) return null;
  const by = member;
  return db
    .select({ entry: historyTransactional, changedByName: by.MemberFullName })
    .from(historyTransactional)
    .innerJoin(by, eq(by.MemberKey, historyTransactional.ChangedByMemberKey))
    .where(and(eq(historyTransactional.ResourceName, "Member"), eq(historyTransactional.ResourceRecordKey, key)))
    .orderBy(desc(historyTransactional.OsmlsSequence));
}

const DETAIL_FIELDS = {
  MemberFirstName: "firstName",
  MemberLastName: "lastName",
  MemberMlsId: "memberId",
  MemberDirectPhone: "phone",
} as const;

/**
 * Changes a member's name, member ID, phone, and role. A role change sets the
 * office with it: an agent needs one, and MLS staff have none. An agent's
 * office is otherwise left alone here, and listings keep the office recorded
 * on them whatever happens to their agent.
 */
export async function updateMember(actor: Member | null, key: unknown, input: unknown): Promise<void> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  const v = parsed(detailsInput, input);
  try {
    await db.transaction(async (tx) => {
      await takeAuthorityTurn(tx);
      const by = await actingStaff(tx, actor);
      const [target] = await tx.select().from(member).where(eq(member.MemberKey, key)).for("update");
      if (!target) throw notFound();
      const changes: Change[] = [];
      const values: Partial<typeof member.$inferInsert> = {};
      for (const column of Object.keys(DETAIL_FIELDS) as (keyof typeof DETAIL_FIELDS)[]) {
        const next = v[DETAIL_FIELDS[column]] || null;
        if (next === target[column]) continue;
        changes.push({ field: column, previous: target[column], next, type: "Member Change" });
        Object.assign(values, { [column]: next });
      }
      if (values.MemberFirstName !== undefined || values.MemberLastName !== undefined) {
        values.MemberFullName = `${v.firstName} ${v.lastName}`;
      }
      if (v.role !== target.OsmlsRole) {
        if (target.MemberKey === by.MemberKey) throw new ListingError("You cannot change your own role.", { role: "You cannot change your own role." });
        if (v.role === "agent") await keepOneStaff(tx, target, "made an agent");
        const officeKey = v.role === "agent" ? await officeFor(tx, v.officeKey) : null;
        changes.push({ field: "OsmlsRole", previous: target.OsmlsRole, next: v.role, type: "Role Change" });
        if (officeKey !== target.OfficeKey) changes.push({ field: "OfficeKey", previous: target.OfficeKey, next: officeKey, type: "Role Change" });
        Object.assign(values, { OsmlsRole: v.role, OfficeKey: officeKey });
      }
      if (changes.length === 0) return;
      await tx.update(member).set({ ...values, ModificationTimestamp: new Date() }).where(eq(member.MemberKey, key));
      if (values.MemberFullName) await tx.update(user).set({ name: values.MemberFullName, updatedAt: new Date() }).where(eq(user.id, target.OsmlsUserId));
      await record(tx, by, target, changes);
    });
  } catch (err) {
    translateDuplicate(err);
  }
}

/**
 * Changes the address a member signs in with. The member record and the
 * sign-in identity change together or not at all, and any password link
 * already sent stops working: it went to the old address.
 */
export async function changeMemberEmail(actor: Member | null, key: unknown, input: unknown): Promise<void> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  const email = parsed(emailInput, typeof input === "string" ? input.trim() : input);
  try {
    await db.transaction(async (tx) => {
      await takeAuthorityTurn(tx);
      const by = await actingStaff(tx, actor);
      const [target] = await tx.select().from(member).where(eq(member.MemberKey, key)).for("update");
      if (!target) throw notFound();
      if (target.MemberEmail === email) return;
      await tx.update(user).set({ email, updatedAt: new Date() }).where(eq(user.id, target.OsmlsUserId));
      await tx.update(member).set({ MemberEmail: email, ModificationTimestamp: new Date() }).where(eq(member.MemberKey, key));
      await tx.delete(verification).where(eq(verification.value, target.OsmlsUserId));
      await record(tx, by, target, [{ field: "MemberEmail", previous: target.MemberEmail, next: email, type: "Email Change" }]);
    });
  } catch (err) {
    translateDuplicate(err);
  }
}

/**
 * Sends a member a new link to set their password. It is always a new link,
 * and it ends any earlier one. The link itself is never recorded.
 */
export async function sendPasswordLink(actor: Member | null, key: unknown): Promise<PasswordLink> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  return issuePasswordLink(key, "reset", async (tx, target) => {
    const by = await actingStaff(tx, actor);
    await record(tx, by, target, [{ field: "Password", previous: null, next: null, type: "Password Link Sent" }]);
  });
}

export async function getMemberForAdmin(actor: Member | null, key: unknown) {
  if (!canAdminister(actor) || !isKey(key)) return null;
  const [row] = await db
    .select({ member, officeName: office.OfficeName })
    .from(member)
    .leftJoin(office, eq(office.OfficeKey, member.OfficeKey))
    .where(eq(member.MemberKey, key));
  return row ?? null;
}

export const listOffices = () => db.select().from(office).orderBy(asc(office.OfficeName));

/**
 * Suspends or reinstates a member, with a reason. Taken in turn with every
 * other status or role change, and checked again inside that turn: the acting
 * member must still be active staff, may not act on themself, and may not
 * leave the MLS without an active staff account.
 */
export async function setMemberStatus(actor: Member | null, key: unknown, status: "Active" | "Inactive", reason: unknown): Promise<void> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  const why = checkedReason(reason);
  await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor);
    const [target] = await tx.select().from(member).where(eq(member.MemberKey, key)).for("update");
    if (!target) throw notFound();
    if (target.MemberKey === by.MemberKey) throw new ListingError("You cannot suspend or reinstate your own account.");
    if (target.MemberStatus === status) return;
    if (status === "Inactive") await keepOneStaff(tx, target, "suspended");
    if (status === "Active" && target.OsmlsRole === "agent") {
      // Read inside the turn, which a deactivation of the office also takes.
      const [theirs] = target.OfficeKey ? await tx.select().from(office).where(eq(office.OfficeKey, target.OfficeKey)) : [];
      if (!theirs || theirs.OfficeStatus !== "Active") {
        throw new ListingError(
          `${theirs?.OfficeName ?? "This agent's office"} is inactive, so this agent cannot be reinstated there. Move them to an active office first, or reactivate that office.`,
        );
      }
    }
    await tx.update(member).set({ MemberStatus: status, ModificationTimestamp: new Date() }).where(eq(member.MemberKey, key));
    await record(tx, by, target, [
      { field: "MemberStatus", previous: target.MemberStatus, next: status, type: status === "Inactive" ? "Suspended" : "Reinstated", reason: why },
    ]);
  });
}

/**
 * Moves an agent to another office, with a reason. A suspended agent can be
 * moved too, so that they can then be reinstated. Their listings keep the
 * office recorded on them, and the agent stays their listing agent. What the
 * old office's membership let them see of colleagues' listings goes at once,
 * and the new office's comes, because every request reads the member afresh.
 */
export async function moveMember(actor: Member | null, key: unknown, officeKey: unknown, reason: unknown): Promise<void> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  const why = checkedReason(reason);
  await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor);
    const [target] = await tx.select().from(member).where(eq(member.MemberKey, key)).for("update");
    if (!target) throw notFound();
    if (target.OsmlsRole !== "agent") throw new ListingError("Only an agent has an office.");
    const [destination] = isKey(officeKey) ? await tx.select().from(office).where(eq(office.OfficeKey, officeKey)) : [];
    if (!destination) throw new ListingError("Choose an office from the list.", { officeKey: "Choose an office from the list." });
    if (destination.OfficeStatus !== "Active") {
      const message = `${destination.OfficeName} is inactive. Choose an active office.`;
      throw new ListingError(message, { officeKey: message });
    }
    if (destination.OfficeKey === target.OfficeKey) return;
    await tx.update(member).set({ OfficeKey: destination.OfficeKey, ModificationTimestamp: new Date() }).where(eq(member.MemberKey, key));
    await record(tx, by, target, [{ field: "OfficeKey", previous: target.OfficeKey, next: destination.OfficeKey, type: "Office Move", reason: why }]);
  });
}

/**
 * Sets a password with a link staff sent. The sign-in library checks the link,
 * spends it, and ends the member's other sessions. Every refusal reads alike.
 */
export async function setPasswordWithLink(token: unknown, password: unknown): Promise<void> {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new ListingError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, { password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (password.length > 128) throw new ListingError("Use 128 characters or fewer.", { password: "Use 128 characters or fewer." });
  const refused = new ListingError("This link does not work. It may have been used, replaced, or expired. Ask MLS staff for a new one.");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw refused;
  try {
    await auth.api.resetPassword({ body: { newPassword: password, token } });
  } catch {
    throw refused;
  }
}
