import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "../db";
import { historyTransactional, member, office, type Member, type Office } from "../db/schema";
import { canAdminister } from "./access";
import { ListingError } from "./listings";
import { OFFICE_STATUSES } from "./lookups";
import { actingStaff, checkedReason, recordChanges, takeAuthorityTurn, type Change } from "./members";

/*
 * Office administration. Only MLS staff may (canAdminister in
 * src/lib/access.ts); anyone else is answered as if nothing were there.
 *
 * A brokerage is a main office and its branches, one level deep: a branch names
 * its main office, and a main office names none.
 *
 * Two rules tie an office's status to what depends on it:
 *   - an active agent is always in an active office;
 *   - an active branch always has an active main office.
 * Each is checked wherever it could be broken: here when an office is added,
 * regrouped, deactivated, or reactivated, and in src/lib/members.ts when an
 * agent is added, moved, reinstated, or made from MLS staff.
 *
 * Every one of those changes takes the same MLS-wide turn, so each check reads
 * a state that nothing else is changing.
 */

const notFound = () => new ListingError("Not found.");
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

const officeInput = z.object({
  name: z.string().trim().min(1, "A name is required.").max(120),
  officeId: z.string().trim().min(1, "An office ID is required.").max(40),
  phone: z.string().trim().max(40).default(""),
  city: z.string().trim().max(80).default(""),
  state: z.string().trim().max(40).default(""),
});

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ListingError("Check the fields marked below.", Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message])));
}

function translateDuplicate(err: unknown): never {
  const cause = (err as { cause?: { code?: string } }).cause ?? (err as { code?: string });
  if (cause?.code === "23505") throw new ListingError("Check the fields marked below.", { officeId: "Another office already has that office ID." });
  throw err;
}

const record = (tx: Tx, by: Member, target: Pick<Office, "OfficeKey" | "OfficeMlsId">, changes: Change[]) =>
  recordChanges(tx, by, "Office", { key: target.OfficeKey, id: target.OfficeMlsId }, changes);

const refuse = (message: string, field: string): never => {
  throw new ListingError(message, { [field]: message });
};

/**
 * The main office a branch may be put under, or null for "none". It must exist,
 * be a main office itself, and be active if the branch is.
 */
async function mainOfficeFor(tx: Tx, branch: { key: string | null; active: boolean }, mainKey: string): Promise<Office | null> {
  if (mainKey === "") return null;
  if (mainKey === branch.key) refuse("An office cannot be its own main office.", "mainOfficeKey");
  const [main] = isKey(mainKey) ? await tx.select().from(office).where(eq(office.OfficeKey, mainKey)) : [];
  if (!main) return refuse("Choose a main office from the list.", "mainOfficeKey");
  if (main.MainOfficeKey) refuse(`${main.OfficeName} is itself a branch, so it cannot be a main office.`, "mainOfficeKey");
  if (branch.active && main.OfficeStatus !== "Active") {
    refuse(`${main.OfficeName} is inactive, so an active office cannot be put under it.`, "mainOfficeKey");
  }
  return main;
}

/** Adds an office. It starts active: a main office, or a branch of the main office given. */
export async function createOffice(actor: Member | null, input: unknown): Promise<Office> {
  if (!canAdminister(actor)) throw notFound();
  const v = parsed(officeInput, input);
  const mainKey = typeof (input as { mainOfficeKey?: unknown })?.mainOfficeKey === "string" ? (input as { mainOfficeKey: string }).mainOfficeKey.trim() : "";
  try {
    return await db.transaction(async (tx) => {
      await takeAuthorityTurn(tx);
      const by = await actingStaff(tx, actor);
      const main = await mainOfficeFor(tx, { key: null, active: true }, mainKey);
      const [row] = await tx
        .insert(office)
        .values({
          OfficeName: v.name,
          OfficeMlsId: v.officeId,
          OfficePhone: v.phone || null,
          OfficeCity: v.city || null,
          OfficeStateOrProvince: v.state || null,
          MainOfficeKey: main?.OfficeKey ?? null,
        })
        .returning();
      await record(tx, by, row, [
        { field: "OfficeStatus", previous: null, next: "Active", type: "New Office" },
        ...(main ? [{ field: "MainOfficeKey", previous: null, next: main.OfficeKey, type: "New Office" }] : []),
      ]);
      return row;
    });
  } catch (err) {
    translateDuplicate(err);
  }
}

const DETAIL_FIELDS = { OfficeName: "name", OfficeMlsId: "officeId", OfficePhone: "phone", OfficeCity: "city", OfficeStateOrProvince: "state" } as const;

/** Changes an office's name, office ID, phone, city, and state. */
export async function updateOffice(actor: Member | null, key: unknown, input: unknown): Promise<void> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  const v = parsed(officeInput, input);
  try {
    await db.transaction(async (tx) => {
      await takeAuthorityTurn(tx);
      const by = await actingStaff(tx, actor);
      const [target] = await tx.select().from(office).where(eq(office.OfficeKey, key)).for("update");
      if (!target) throw notFound();
      const changes: Change[] = [];
      const values: Partial<typeof office.$inferInsert> = {};
      for (const column of Object.keys(DETAIL_FIELDS) as (keyof typeof DETAIL_FIELDS)[]) {
        const next = v[DETAIL_FIELDS[column]] || null;
        if (next === target[column]) continue;
        changes.push({ field: column, previous: target[column], next, type: "Office Change" });
        Object.assign(values, { [column]: next });
      }
      if (changes.length === 0) return;
      await tx.update(office).set({ ...values, ModificationTimestamp: new Date() }).where(eq(office.OfficeKey, key));
      await record(tx, by, target, changes);
    });
  } catch (err) {
    translateDuplicate(err);
  }
}

/**
 * Puts an office under a main office, or makes it a main office again (""). An
 * office that has branches of its own cannot become a branch, so a brokerage
 * stays one level deep and no chain or cycle can form.
 */
export async function setMainOffice(actor: Member | null, key: unknown, mainOfficeKey: unknown): Promise<void> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  const mainKey = typeof mainOfficeKey === "string" ? mainOfficeKey.trim() : "";
  await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor);
    const [target] = await tx.select().from(office).where(eq(office.OfficeKey, key)).for("update");
    if (!target) throw notFound();
    const main = await mainOfficeFor(tx, { key: target.OfficeKey, active: target.OfficeStatus === "Active" }, mainKey);
    const next = main?.OfficeKey ?? null;
    if (next === target.MainOfficeKey) return;
    if (next) {
      const branches = await tx.select({ name: office.OfficeName }).from(office).where(eq(office.MainOfficeKey, target.OfficeKey));
      if (branches.length > 0) {
        refuse(`${target.OfficeName} has branches of its own (${branches.map((b) => b.name).join(", ")}), so it cannot become a branch.`, "mainOfficeKey");
      }
    }
    await tx.update(office).set({ MainOfficeKey: next, ModificationTimestamp: new Date() }).where(eq(office.OfficeKey, key));
    await record(tx, by, target, [{ field: "MainOfficeKey", previous: target.MainOfficeKey, next, type: "Brokerage Change" }]);
  });
}

/**
 * Deactivates or reactivates an office, with a reason. An office with active
 * agents, or a main office with active branches, cannot be deactivated; a
 * branch cannot be reactivated under an inactive main office.
 */
export async function setOfficeStatus(actor: Member | null, key: unknown, status: "Active" | "Inactive", reason: unknown): Promise<void> {
  if (!canAdminister(actor) || !isKey(key)) throw notFound();
  const why = checkedReason(reason);
  await db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor);
    const [target] = await tx.select().from(office).where(eq(office.OfficeKey, key)).for("update");
    if (!target) throw notFound();
    if (target.OfficeStatus === status) return;
    if (status === "Inactive") {
      const agents = await tx
        .select({ name: member.MemberFullName })
        .from(member)
        .where(and(eq(member.OfficeKey, key), eq(member.MemberStatus, "Active"), eq(member.OsmlsRole, "agent")))
        .orderBy(asc(member.MemberLastName));
      if (agents.length > 0) {
        throw new ListingError(
          `This office has ${agents.length} active ${agents.length === 1 ? "agent" : "agents"} (${agents.map((a) => a.name).join(", ")}). Move or suspend them first.`,
        );
      }
      const branches = await tx
        .select({ name: office.OfficeName })
        .from(office)
        .where(and(eq(office.MainOfficeKey, key), eq(office.OfficeStatus, "Active")))
        .orderBy(asc(office.OfficeName));
      if (branches.length > 0) {
        throw new ListingError(
          `This main office has ${branches.length} active ${branches.length === 1 ? "branch" : "branches"} (${branches.map((b) => b.name).join(", ")}). Deactivate or regroup them first.`,
        );
      }
    } else if (target.MainOfficeKey) {
      const [main] = await tx.select().from(office).where(eq(office.OfficeKey, target.MainOfficeKey));
      if (main.OfficeStatus !== "Active") {
        throw new ListingError(`Its main office, ${main.OfficeName}, is inactive. Reactivate that first, or make this a main office.`);
      }
    }
    await tx.update(office).set({ OfficeStatus: status, ModificationTimestamp: new Date() }).where(eq(office.OfficeKey, key));
    await record(tx, by, target, [
      { field: "OfficeStatus", previous: target.OfficeStatus, next: status, type: status === "Inactive" ? "Deactivated" : "Reactivated", reason: why },
    ]);
  });
}

export type OfficeFilters = { q?: string; status?: string; brokerage?: string };

/**
 * Offices for the administration list, each with its main office's name and how
 * many active agents it has. `brokerage` is a main office's key: that office and
 * its branches. Null for anyone who may not administer.
 */
export async function listOfficesForAdmin(actor: Member | null, filters: OfficeFilters = {}) {
  if (!canAdminister(actor)) return null;
  const q = filters.q?.trim();
  const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  return db
    .select({
      office,
      // The outer table is named in full: inside a subquery a bare column would be read as the inner table's.
      mainOfficeName: sql<string | null>`(select m."OfficeName" from "Office" m where m."OfficeKey" = "Office"."MainOfficeKey")`,
      activeAgents: sql<number>`(select count(*)::int from "Member" m where m."OfficeKey" = "Office"."OfficeKey" and m."MemberStatus" = 'Active' and m."OsmlsRole" = 'agent')`,
    })
    .from(office)
    .where(
      and(
        like ? or(ilike(office.OfficeName, like), ilike(office.OfficeMlsId, like), ilike(office.OfficeCity, like)) : undefined,
        (OFFICE_STATUSES as readonly string[]).includes(filters.status ?? "") ? eq(office.OfficeStatus, filters.status!) : undefined,
        isKey(filters.brokerage) ? or(eq(office.OfficeKey, filters.brokerage), eq(office.MainOfficeKey, filters.brokerage)) : undefined,
      ),
    )
    .orderBy(asc(office.OfficeName));
}

/** Main offices, for choosing a brokerage. */
export const listMainOffices = () => db.select().from(office).where(isNull(office.MainOfficeKey)).orderBy(asc(office.OfficeName));

/** One office with its main office, its branches, its members, and its change record. Null for anyone who may not administer. */
export async function getOfficeForAdmin(actor: Member | null, key: unknown) {
  if (!canAdminister(actor) || !isKey(key)) return null;
  const [row] = await db.select().from(office).where(eq(office.OfficeKey, key));
  if (!row) return null;
  const [main] = row.MainOfficeKey ? await db.select().from(office).where(eq(office.OfficeKey, row.MainOfficeKey)) : [];
  const branches = await db.select().from(office).where(eq(office.MainOfficeKey, key)).orderBy(asc(office.OfficeName));
  const members = await db.select().from(member).where(eq(member.OfficeKey, key)).orderBy(asc(member.MemberLastName), asc(member.MemberFirstName));
  const history = await db
    .select({ entry: historyTransactional, changedByName: member.MemberFullName })
    .from(historyTransactional)
    .innerJoin(member, eq(member.MemberKey, historyTransactional.ChangedByMemberKey))
    .where(and(eq(historyTransactional.ResourceName, "Office"), eq(historyTransactional.ResourceRecordKey, key)))
    .orderBy(desc(historyTransactional.OsmlsSequence));
  return { office: row, main: main ?? null, branches, members, history };
}
