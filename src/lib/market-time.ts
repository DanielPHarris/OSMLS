import { AsyncLocalStorage } from "node:async_hooks";
import { desc, inArray, sql, type SQL } from "drizzle-orm";
import { cache } from "react";
import { db } from "../db";
import { marketTimeSettings, relistingLink, type MarketTimeSettingsRow } from "../db/schema";
import type { StandardStatus } from "./lookups";
import { CONTINUABLE_END_STATUSES, type MarketTimeSettings } from "./rules/market-time";

/*
 * Days on market (DOM) and cumulative days on market (CDOM).
 *
 * Nothing here is stored. DOM is worked out in the database from a listing's
 * status history, and CDOM by following the chain of earlier listings it
 * continues. Policy comes only from MarketTimeSettings, and the settings come
 * only from the database (currentSettings): nothing here falls back to the
 * values in src/lib/rules/market-time.ts, which are only what a new
 * installation starts with.
 */

/** One stored version of the settings. */
export type SettingsVersion = MarketTimeSettings & { version: number };

export const toSettings = (row: MarketTimeSettingsRow): SettingsVersion => ({
  version: row.Version,
  accumulatingStatuses: row.AccumulatingStatuses as StandardStatus[],
  relistingGapDays: row.RelistingGapDays,
  brokerageChangeResets: row.BrokerageChangeResets,
  addressFallback: row.AddressFallback,
  gapEndpoint: row.GapEndpoint as MarketTimeSettings["gapEndpoint"],
  timeZone: row.TimeZone,
});

/** The newest version, read now. Screens that change the settings use this; everything else uses currentSettings. */
export async function latestSettings(): Promise<SettingsVersion> {
  const [row] = await db.select().from(marketTimeSettings).orderBy(desc(marketTimeSettings.Version)).limit(1);
  if (!row) throw new Error("There are no market-time settings. Run the database migrations.");
  return toSettings(row);
}

const forThisRequest = cache(latestSettings);
const held = new AsyncLocalStorage<SettingsVersion>();

/**
 * The settings for the operation in progress. One version serves the whole of
 * it, however many figures and dates it works out; a change saved meanwhile
 * applies from the next operation.
 *
 * How the version is held depends on what the operation is. While a page is
 * rendered, React keeps one answer for the request. That does not reach a
 * server action, a route handler, or a script, so each of those that reads the
 * settings runs inside withOneSettingsVersion. Outside both, each call reads
 * the newest version.
 */
export const currentSettings = async (): Promise<SettingsVersion> => held.getStore() ?? forThisRequest();

/**
 * Runs an action, a route handler, or background work under one version of the
 * settings, read as it begins. Work already running under a version keeps it.
 */
export async function withOneSettingsVersion<T>(work: () => Promise<T>): Promise<T> {
  return held.getStore() ? work() : held.run(await latestSettings(), work);
}

/** What is known about one listing for the purpose of counting market time. */
export type MarketFacts = {
  listingKey: string;
  listingId: string;
  standardStatus: string;
  enteredAt: Date;
  /** Calendar dates below are YYYY-MM-DD in the MLS's time zone. */
  enteredDate: string;
  parcelNumber: string | null;
  countyOrParish: string | null;
  stateOrProvince: string | null;
  streetNumber: string | null;
  streetName: string | null;
  unitNumber: string | null;
  city: string | null;
  postalCode: string | null;
  /** The listing office's main office, or the office itself if it is one. */
  brokerageKey: string;
  daysOnMarket: number;
  firstOnMarketDate: string | null;
  /** When the count last stopped. Null while the listing is accumulating days, or if it never has. */
  offMarketDate: string | null;
  /** The date of the listing's most recent status change. */
  endedDate: string | null;
};

export type MarketTime = {
  daysOnMarket: number;
  cumulativeDaysOnMarket: number;
  firstOnMarketDate: string | null;
  offMarketDate: string | null;
  /** The listing numbers this one continues, most recent first. Empty when the count started fresh. */
  continues: string[];
};

// ---- Pure rules: no database, so each can be tested on its own ----

const text = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** A parcel number with spaces and punctuation removed, or null if there is none. */
export function normalizeParcel(v: string | null | undefined): string | null {
  const clean = (v ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return clean === "" ? null : clean;
}

type Identity = Pick<
  MarketFacts,
  "parcelNumber" | "countyOrParish" | "stateOrProvince" | "streetNumber" | "streetName" | "unitNumber" | "city" | "postalCode"
>;

/** A parcel number means something only together with the county and state that issued it. */
const hasParcelIdentity = (x: Identity) =>
  normalizeParcel(x.parcelNumber) !== null && text(x.countyOrParish) !== "" && text(x.stateOrProvince) !== "";

/**
 * Whether two listings are of the same property. Deliberately narrow: a wrong
 * match would give one property another's market time.
 */
export function sameProperty(a: Identity, b: Identity, settings: MarketTimeSettings): boolean {
  // Units in one building can share a parcel and always share a street address.
  if (text(a.unitNumber) !== text(b.unitNumber)) return false;

  if (hasParcelIdentity(a) && hasParcelIdentity(b))
    // Both are fully identified, so this is the answer. The address is not consulted.
    return (
      normalizeParcel(a.parcelNumber) === normalizeParcel(b.parcelNumber) &&
      text(a.countyOrParish) === text(b.countyOrParish) &&
      text(a.stateOrProvince) === text(b.stateOrProvince)
    );

  if (!settings.addressFallback) return false;
  const address = (x: Identity) => [x.streetNumber, x.streetName, x.city, x.stateOrProvince, x.postalCode].map(text);
  const [one, other] = [address(a), address(b)];
  return one.every((part) => part !== "") && one.every((part, i) => part === other[i]);
}

/** Whole days from one YYYY-MM-DD date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

type Linkable = Pick<
  MarketFacts,
  "standardStatus" | "enteredDate" | "firstOnMarketDate" | "endedDate" | "brokerageKey"
>;

/**
 * Whether a listing continues the count of its predecessor. The predecessor has
 * already been chosen; this only tests it.
 */
export function continuesPredecessor(
  current: Linkable,
  predecessor: Linkable,
  settings: MarketTimeSettings,
): boolean {
  // A sale always resets, as does a predecessor that is still running.
  if (!(CONTINUABLE_END_STATUSES as readonly string[]).includes(predecessor.standardStatus)) return false;
  if (!predecessor.endedDate) return false;
  if (settings.brokerageChangeResets && predecessor.brokerageKey !== current.brokerageKey) return false;
  // The gap starts on the date the predecessor reached its final status: for a
  // listing that went Pending and was later canceled, the cancellation, not the day
  // it stopped accumulating. It ends at the gap endpoint. A listing that has not yet
  // been on the market has no on-market date, so its entry date is used.
  const endpoint =
    settings.gapEndpoint === "onMarket" ? (current.firstOnMarketDate ?? current.enteredDate) : current.enteredDate;
  const gap = daysBetween(predecessor.endedDate, endpoint);
  // Overlap: the new listing was entered before the predecessor ended, so the gap
  // is negative. By rule it still continues the predecessor. Each listing keeps its
  // own days, so days when both were on the market are counted in both and appear
  // twice in the cumulative figure. Nothing is subtracted for the overlap.
  if (gap < 0) return true;
  return gap < settings.relistingGapDays;
}

/**
 * The listing that came immediately before this one for the same property: the
 * most recently entered earlier listing, whatever its status. Choosing it before
 * testing it is what stops the chain reaching past a sale to something older.
 */
export function choosePredecessor<T extends Identity & { listingKey: string; enteredAt: Date }>(
  current: T,
  candidates: readonly T[],
  settings: MarketTimeSettings,
): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (candidate.listingKey === current.listingKey) continue;
    // Strictly earlier: two listings entered at the same instant precede neither.
    if (candidate.enteredAt.getTime() >= current.enteredAt.getTime()) continue;
    if (!sameProperty(current, candidate, settings)) continue;
    if (!best || candidate.enteredAt.getTime() > best.enteredAt.getTime()) best = candidate;
  }
  return best;
}

/**
 * What compliance staff have said about which earlier listing a listing
 * continues. Absent: nothing, so it is chosen by matching. Otherwise the key of
 * the listing they named, or null for "none".
 */
export type RelistingLinkSetting = { predecessorKey: string | null };

type Chained = Identity & Pick<MarketFacts, "listingKey" | "enteredAt" | "standardStatus">;

/**
 * Whether the same property was sold between two listings: a Closed listing
 * entered after the earlier and before the later, and matched to either of
 * them. A sale always starts the count again, so a link that staff make by
 * hand may not carry a count past one.
 */
export function soldBetween<T extends Chained>(later: T, earlier: T, candidates: readonly T[], settings: MarketTimeSettings): T | null {
  return (
    candidates.find(
      (c) =>
        c.standardStatus === "Closed" &&
        c.listingKey !== later.listingKey &&
        c.listingKey !== earlier.listingKey &&
        c.enteredAt.getTime() > earlier.enteredAt.getTime() &&
        c.enteredAt.getTime() < later.enteredAt.getTime() &&
        (sameProperty(c, later, settings) || sameProperty(c, earlier, settings)),
    ) ?? null
  );
}

/**
 * The listing that came before this one. With nothing said by staff, it is
 * chosen by matching. Staff saying "none" means there is none. A listing staff
 * named is taken as the same property without consulting parcel, address, or
 * the address-fallback setting; it must still be strictly earlier, and no sale
 * of the property may lie between. Whether the count then continues is a
 * separate question, answered by continuesPredecessor for every case alike.
 */
export function resolvePredecessor<T extends Chained>(
  current: T,
  link: RelistingLinkSetting | undefined,
  named: T | null,
  candidates: readonly T[],
  settings: MarketTimeSettings,
): T | null {
  if (!link) return choosePredecessor(current, candidates, settings);
  if (link.predecessorKey === null || !named) return null;
  if (named.listingKey === current.listingKey || named.enteredAt.getTime() >= current.enteredAt.getTime()) return null;
  if (soldBetween(current, named, candidates, settings)) return null;
  return named;
}

// ---- The database side ----

/**
 * One row per listing: its days on market and the dates the count started and
 * stopped, from its status history. This query is the only place DOM is
 * calculated, so searching, sorting, and display cannot disagree.
 */
export function marketFactsSql(asOf: Date, settings: MarketTimeSettings): SQL {
  const accumulating = sql.join(
    settings.accumulatingStatuses.map((s) => sql`${s}`),
    sql`, `,
  );
  const zone = settings.timeZone;
  // A stretch runs from the date of one status change to the date of the next,
  // or to today for the latest. Dates are calendar dates in the MLS time zone.
  return sql`
    select s.key,
      coalesce(sum(greatest(s.end_d - s.start_d, 0)) filter (where s.acc), 0)::int as dom,
      min(s.start_d) filter (where s.acc) as first_on,
      case when bool_or(s.acc and s.nxt is null) then null
           else max(s.end_d) filter (where s.acc) end as off_market,
      max(s.start_d) as ended
    from (
      select h."ResourceRecordKey" as key,
        h."NewValue" in (${accumulating}) as acc,
        (h."ModificationTimestamp" at time zone ${zone})::date as start_d,
        (coalesce(lead(h."ModificationTimestamp") over w, ${asOf.toISOString()}::timestamptz) at time zone ${zone})::date as end_d,
        lead(h."ModificationTimestamp") over w as nxt
      from "HistoryTransactional" h
      where h."ResourceName" = 'Property' and h."FieldName" = 'StandardStatus'
      window w as (partition by h."ResourceRecordKey" order by h."ModificationTimestamp", h."OsmlsSequence")
    ) s
    group by s.key`;
}

async function fetchFacts(where: SQL, asOf: Date, settings: MarketTimeSettings): Promise<MarketFacts[]> {
  const result = await db.execute(sql`
    select p."ListingKey" as "listingKey", p."ListingId" as "listingId", p."StandardStatus" as "standardStatus",
      p."OriginalEntryTimestamp" as "enteredAt",
      to_char(p."OriginalEntryTimestamp" at time zone ${settings.timeZone}, 'YYYY-MM-DD') as "enteredDate",
      p."ParcelNumber" as "parcelNumber", p."CountyOrParish" as "countyOrParish",
      p."StateOrProvince" as "stateOrProvince", p."StreetNumber" as "streetNumber",
      p."StreetName" as "streetName", p."UnitNumber" as "unitNumber", p."City" as "city",
      p."PostalCode" as "postalCode",
      coalesce(o."MainOfficeKey", o."OfficeKey") as "brokerageKey",
      coalesce(mf.dom, 0) as "daysOnMarket",
      mf.first_on::text as "firstOnMarketDate", mf.off_market::text as "offMarketDate", mf.ended::text as "endedDate"
    from "Property" p
    join "Office" o on o."OfficeKey" = p."ListOfficeKey"
    left join (${marketFactsSql(asOf, settings)}) mf on mf.key = p."ListingKey"
    where ${where}`);
  return (result.rows as unknown as MarketFacts[]).map((row) => ({ ...row, enteredAt: new Date(row.enteredAt) }));
}

const inList = (values: readonly string[]) =>
  sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;

/** A wide net: listings that could be earlier listings of the same properties. Narrowed by sameProperty. */
function possiblePredecessorsOf(listings: readonly MarketFacts[]): SQL {
  const parcels = [...new Set(listings.map((l) => normalizeParcel(l.parcelNumber)).filter((p): p is string => !!p))];
  const zips = [...new Set(listings.map((l) => text(l.postalCode)).filter(Boolean))];
  const numbers = [...new Set(listings.map((l) => text(l.streetNumber)).filter(Boolean))];
  const byParcel = parcels.length
    ? sql`upper(regexp_replace(coalesce(p."ParcelNumber", ''), '[^A-Za-z0-9]', '', 'g')) in ${inList(parcels)}`
    : sql`false`;
  const byAddress =
    zips.length && numbers.length
      ? sql`(lower(trim(p."PostalCode")) in ${inList(zips)} and lower(trim(p."StreetNumber")) in ${inList(numbers)})`
      : sql`false`;
  return sql`(${byParcel} or ${byAddress})`;
}

/** What compliance staff have said about the listings given. A listing with no entry is matched automatically. */
async function linksFor(listingKeys: readonly string[]): Promise<Map<string, RelistingLinkSetting>> {
  if (listingKeys.length === 0) return new Map();
  const rows = await db.select().from(relistingLink).where(inArray(relistingLink.ListingKey, [...listingKeys]));
  return new Map(rows.map((r) => [r.ListingKey, { predecessorKey: r.PredecessorKey }]));
}

/**
 * Why staff may not name `earlierKey` as the listing `laterKey` continues, or
 * null if they may. The same tests decide whether a link already made is
 * followed, so one made before a sale is entered stops being followed after.
 */
export async function relistingLinkRefusal(laterKey: string, earlierKey: string): Promise<string | null> {
  const settings = await currentSettings();
  const asOf = new Date();
  const pair = await fetchFacts(sql`p."ListingKey" in ${inList([laterKey, earlierKey])}`, asOf, settings);
  const later = pair.find((f) => f.listingKey === laterKey);
  const earlier = pair.find((f) => f.listingKey === earlierKey);
  if (!later || !earlier || laterKey === earlierKey) return "Choose a different listing.";
  if (earlier.enteredAt.getTime() >= later.enteredAt.getTime()) return `Listing ${earlier.listingId} was not entered before this one, so this one cannot continue it.`;
  const sale = soldBetween(later, earlier, await fetchFacts(possiblePredecessorsOf(pair), asOf, settings), settings);
  if (sale) {
    return `Listing ${sale.listingId} is a sale of the same property between the two, and a sale always starts the count again. If ${sale.listingId} is a different property, correct its parcel number or address first.`;
  }
  return null;
}

// Far more relistings than any real property has; a backstop, not a rule.
const MAX_CHAIN_LENGTH = 200;

/** DOM and CDOM for the given listings, as of a moment (now, unless a test says otherwise). */
export async function getMarketTime(
  listingKeys: readonly string[],
  options: { asOf?: Date; settings?: MarketTimeSettings } = {},
): Promise<Map<string, MarketTime>> {
  const asOf = options.asOf ?? new Date();
  const settings = options.settings ?? (await currentSettings());
  const keys = [...new Set(listingKeys)].filter((k) => /^[0-9a-f-]{36}$/i.test(k));
  const out = new Map<string, MarketTime>();
  if (keys.length === 0) return out;

  const facts = new Map<string, MarketFacts>();
  const continuedFrom = new Map<string, string | null>();
  let frontier = await fetchFacts(sql`p."ListingKey" in ${inList(keys)}`, asOf, settings);
  for (const f of frontier) facts.set(f.listingKey, f);

  // Walk back one generation of listings at a time, for all of them together.
  for (let depth = 0; frontier.length > 0 && depth < MAX_CHAIN_LENGTH; depth++) {
    const links = await linksFor(frontier.map((f) => f.listingKey));
    const namedKeys = [...links.values()].map((l) => l.predecessorKey).filter((k): k is string => k !== null);
    const named = new Map((namedKeys.length ? await fetchFacts(sql`p."ListingKey" in ${inList(namedKeys)}`, asOf, settings) : []).map((f) => [f.listingKey, f]));
    // Listings that could be the same property as any of these, or as a listing staff named.
    const candidates = await fetchFacts(possiblePredecessorsOf([...frontier, ...named.values()]), asOf, settings);
    const next: MarketFacts[] = [];
    for (const current of frontier) {
      const link = links.get(current.listingKey);
      const predecessor = resolvePredecessor(current, link, link?.predecessorKey ? (named.get(link.predecessorKey) ?? null) : null, candidates, settings);
      const linked = predecessor && continuesPredecessor(current, predecessor, settings) ? predecessor : null;
      continuedFrom.set(current.listingKey, linked?.listingKey ?? null);
      if (linked && !facts.has(linked.listingKey)) {
        facts.set(linked.listingKey, linked);
        next.push(linked);
      }
    }
    frontier = next;
  }

  for (const key of keys) {
    const own = facts.get(key);
    if (!own) continue;
    let cumulative = own.daysOnMarket;
    const continues: string[] = [];
    // Each step goes to a strictly earlier listing, so this cannot loop; the set is a second guard.
    const seen = new Set([key]);
    for (let at = continuedFrom.get(key); at && !seen.has(at); at = continuedFrom.get(at)) {
      seen.add(at);
      const earlier = facts.get(at)!;
      cumulative += earlier.daysOnMarket;
      continues.push(earlier.listingId);
    }
    out.set(key, {
      daysOnMarket: own.daysOnMarket,
      cumulativeDaysOnMarket: cumulative,
      firstOnMarketDate: own.firstOnMarketDate,
      offMarketDate: own.offMarketDate,
      continues,
    });
  }
  return out;
}
