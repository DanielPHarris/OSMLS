import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { marketTimeSettings, member, type Member } from "../db/schema";
import { can } from "./access";
import { ListingError } from "./listings";
import { STANDARD_STATUSES } from "./lookups";
import { latestSettings, toSettings, type SettingsVersion } from "./market-time";
import { actingStaff, checkedReason, takeAuthorityTurn } from "./members";
import type { MarketTimeSettings } from "./rules/market-time";

/*
 * Changing the market-time settings. Only staff who hold "Manage settings"
 * may; anyone else is answered as if the screen did not exist.
 *
 * A change never alters a stored version: it adds the next one, with who made
 * it and why. Nothing about a listing is stored from these settings, so the
 * new version applies to every listing, past and present, from the next page
 * or run that reads it. There is one policy at a time.
 */

const notFound = () => new ListingError("Not found.");

/** Statuses in which a listing has ended. A listing that has ended cannot be gaining days on market. */
export const NEVER_ACCUMULATING: readonly string[] = ["Closed", "Canceled", "Expired", "Withdrawn"];
export const ACCUMULATING_CHOICES = STANDARD_STATUSES.filter((s) => !NEVER_ACCUMULATING.includes(s));
export const MAX_RELISTING_GAP_DAYS = 365;

const isTimeZone = (v: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return v.includes("/") || v === "UTC";
  } catch {
    return false;
  }
};

const input = z.object({
  accumulatingStatuses: z
    .array(z.enum(ACCUMULATING_CHOICES as [string, ...string[]], "Choose from the statuses listed."))
    .min(1, "Choose at least one status in which a listing gains days on market."),
  relistingGapDays: z.coerce
    .number("Enter a whole number of days.")
    .int("Enter a whole number of days.")
    .min(0, "Enter 0 or more days.")
    .max(MAX_RELISTING_GAP_DAYS, `Enter ${MAX_RELISTING_GAP_DAYS} days or fewer.`),
  brokerageChangeResets: z.boolean(),
  addressFallback: z.boolean(),
  gapEndpoint: z.enum(["entered", "onMarket"], "Choose where the gap ends."),
  timeZone: z.string().trim().refine(isTimeZone, "Enter a time zone by its IANA name, such as America/Los_Angeles."),
});

export const SETTING_LABELS: Record<keyof MarketTimeSettings, string> = {
  accumulatingStatuses: "Statuses that gain days on market",
  relistingGapDays: "Relisting gap (days)",
  brokerageChangeResets: "A different brokerage starts from zero",
  addressFallback: "Match by address when there is no parcel match",
  gapEndpoint: "Where the gap ends",
  timeZone: "Time zone",
};
const SETTINGS = Object.keys(SETTING_LABELS) as (keyof MarketTimeSettings)[];

export const settingText = (settings: MarketTimeSettings, name: keyof MarketTimeSettings): string => {
  const value = settings[name];
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (name === "gapEndpoint") return value === "onMarket" ? "When the new listing first went on the market" : "When the new listing was entered";
  return String(value);
};

/** The settings in force, for the screen that changes them. Null for anyone who may not. */
export async function getSettingsForAdmin(actor: Member | null): Promise<SettingsVersion | null> {
  return can(actor, "settings") ? latestSettings() : null;
}

export type SettingsChange = {
  version: number;
  at: Date;
  by: string | null;
  reason: string | null;
  /** What this version changed from the one before. Empty for the first version. */
  changes: { label: string; previous: string; next: string }[];
};

/** Every change to the settings, newest first. Null for anyone who may not see the settings screen. */
export async function getSettingsHistory(actor: Member | null): Promise<SettingsChange[] | null> {
  if (!can(actor, "settings")) return null;
  const rows = await db
    .select({ row: marketTimeSettings, by: member.MemberFullName })
    .from(marketTimeSettings)
    .leftJoin(member, eq(member.MemberKey, marketTimeSettings.ChangedByMemberKey))
    .orderBy(desc(marketTimeSettings.Version));
  return rows.map(({ row, by }, i) => {
    const now = toSettings(row);
    const before = rows[i + 1] ? toSettings(rows[i + 1].row) : null;
    return {
      version: row.Version,
      at: row.ModificationTimestamp,
      by,
      reason: row.Reason,
      changes: before
        ? SETTINGS.filter((name) => settingText(before, name) !== settingText(now, name)).map((name) => ({
            label: SETTING_LABELS[name],
            previous: settingText(before, name),
            next: settingText(now, name),
          }))
        : [],
    };
  });
}

/**
 * Saves a new version of the settings, with a reason. `basedOn` is the version
 * the person was looking at: if another has been saved since, this one is
 * refused rather than silently undoing it. Taken in the same turn as every
 * capability change, with the acting member read again inside it, so a
 * capability revoked first refuses the save.
 */
export async function saveMarketTimeSettings(actor: Member | null, raw: unknown, basedOn: unknown, reason: unknown): Promise<SettingsVersion> {
  if (!can(actor, "settings")) throw notFound();
  const result = input.safeParse(raw);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
    throw new ListingError("Check the settings marked below.", errors);
  }
  const next = result.data as MarketTimeSettings;
  const why = checkedReason(reason);
  return db.transaction(async (tx) => {
    await takeAuthorityTurn(tx);
    const by = await actingStaff(tx, actor, "settings");
    const [row] = await tx.select().from(marketTimeSettings).orderBy(desc(marketTimeSettings.Version)).limit(1);
    const current = toSettings(row);
    if (Number(basedOn) !== current.version) {
      throw new ListingError("Someone else changed the settings while you were editing. The current values are shown; make your change again.");
    }
    if (SETTINGS.every((name) => settingText(current, name) === settingText(next, name))) return current;
    const [saved] = await tx
      .insert(marketTimeSettings)
      .values({
        Version: current.version + 1,
        // Kept in the standard order, whatever order they were ticked in.
        AccumulatingStatuses: STANDARD_STATUSES.filter((s) => next.accumulatingStatuses.includes(s)),
        RelistingGapDays: next.relistingGapDays,
        BrokerageChangeResets: next.brokerageChangeResets,
        AddressFallback: next.addressFallback,
        GapEndpoint: next.gapEndpoint,
        TimeZone: next.timeZone,
        ChangedByMemberKey: by.MemberKey,
        Reason: why,
      })
      .returning();
    return toSettings(saved);
  });
}
