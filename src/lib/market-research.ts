import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { historyTransactional, member, office, property, type Property } from "../db/schema";
import { localDate, mlsDate, withoutShowing } from "./listings";
import type { StandardStatus } from "./lookups";
import { currentSettings, getMarketTime, type MarketTime } from "./market-time";
import { COMPARABLE_DEFAULTS } from "./rules/market-time";

/*
 * What members use to research the market: a listing's price and status
 * timeline, and comparable listings. Nothing here estimates a value.
 */

// ---- Timeline ----

export type TimelineEntry = { date: string; event: string; detail: string };

// The only kinds of change the timeline is ever built from.
const TIMELINE_FIELDS = ["StandardStatus", "ListPrice", "ClosePrice"] as const;

/**
 * Status and price changes with their dates. Members see this in place of the
 * full change history, which is for MLS staff: it carries no names, no reasons
 * for staff corrections, and nothing about documents or showing instructions,
 * because none of those are ever read here.
 */
export async function getMarketTimeline(listingKey: string): Promise<TimelineEntry[]> {
  if (!/^[0-9a-f-]{36}$/i.test(listingKey)) return [];
  const rows = await db
    .select({
      field: historyTransactional.FieldName,
      previous: historyTransactional.PreviousValue,
      next: historyTransactional.NewValue,
      changeType: historyTransactional.ChangeType,
      at: historyTransactional.ModificationTimestamp,
    })
    .from(historyTransactional)
    .where(
      and(
        eq(historyTransactional.ResourceRecordKey, listingKey),
        inArray(historyTransactional.FieldName, [...TIMELINE_FIELDS]),
      ),
    )
    .orderBy(asc(historyTransactional.ModificationTimestamp), asc(historyTransactional.OsmlsSequence));

  const { timeZone } = await currentSettings();
  const money = (v: string | null) =>
    v == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(v));
  return rows.map((row) => {
    const date = localDate(row.at, timeZone);
    if (row.field === "StandardStatus")
      return row.previous == null
        ? { date, event: "Listed", detail: row.next ?? "" }
        : { date, event: row.changeType === "Back On Market" ? "Back on market" : "Status", detail: `${row.previous} → ${row.next}` };
    if (row.field === "ListPrice") return { date, event: "Price change", detail: `${money(row.previous)} → ${money(row.next)}` };
    return row.next == null
      ? { date, event: "Close price removed", detail: money(row.previous) }
      : { date, event: "Close price", detail: money(row.next) };
  });
}

// ---- Comparables ----

export const COMPARABLE_STATUSES = ["Closed", "Pending", "Active Under Contract", "Active"] as const satisfies readonly StandardStatus[];

export type ComparableCriteria = {
  statuses: StandardStatus[];
  closedWithinDays: number;
  /** "radius" measures from the map pins; "zip" uses the subject's ZIP code. */
  area: "radius" | "zip";
  radiusMiles: number;
  samePropertyType: boolean;
  /** Null means living area is not a criterion. */
  livingAreaPercent: number | null;
  /** Null means bedrooms are not a criterion. */
  bedroomRange: number | null;
};

export function defaultComparableCriteria(subject: Pick<Property, "Latitude" | "Longitude">): ComparableCriteria {
  return {
    statuses: ["Closed"],
    closedWithinDays: COMPARABLE_DEFAULTS.closedWithinDays,
    // Distance needs a pin on the subject. Without one, the ZIP code stands in.
    area: subject.Latitude != null && subject.Longitude != null ? "radius" : "zip",
    radiusMiles: COMPARABLE_DEFAULTS.radiusMiles,
    samePropertyType: true,
    livingAreaPercent: COMPARABLE_DEFAULTS.livingAreaPercent,
    bedroomRange: COMPARABLE_DEFAULTS.bedroomRange,
  };
}

export type Comparable = {
  listing: Property;
  agentName: string;
  officeName: string;
  distanceMiles: number | null;
  pricePerSquareFoot: number | null;
  marketTime: MarketTime;
};

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Summary figures over the closed comparables. They describe those sales; none
 * is an estimate of what the subject is worth. With too few sales there are none.
 */
export function summarizeComparables(comparables: readonly Comparable[]) {
  const closed = comparables.filter((c) => c.listing.StandardStatus === "Closed" && c.listing.ClosePrice != null);
  if (closed.length < COMPARABLE_DEFAULTS.minimumForMedians) return { closedCount: closed.length, medians: null };
  return {
    closedCount: closed.length,
    medians: {
      closePrice: median(closed.map((c) => c.listing.ClosePrice!)),
      pricePerSquareFoot: median(closed.flatMap((c) => (c.pricePerSquareFoot == null ? [] : [c.pricePerSquareFoot]))),
      daysOnMarket: median(closed.map((c) => c.marketTime.daysOnMarket)),
    },
  };
}

/**
 * Great-circle distance in miles between a listing's pin and a fixed point, or
 * NULL when the listing has no pin.
 *
 * The NULL has to be explicit. least() skips NULL arguments, so without the
 * CASE a listing with no coordinates would come out at asin(1): half the
 * world away, shown as a real distance.
 */
const milesFrom = (latitude: number, longitude: number) => sql<number | null>`(
  case when ${property.Latitude} is null or ${property.Longitude} is null then null
  else 3958.8 * 2 * asin(least(1, sqrt(
    power(sin(radians(${property.Latitude} - ${latitude}) / 2), 2) +
    cos(radians(${latitude})) * cos(radians(${property.Latitude})) *
    power(sin(radians(${property.Longitude} - ${longitude}) / 2), 2)
  ))) end)`;

export async function findComparables(
  subject: Property,
  criteria: ComparableCriteria,
  options: { asOf?: Date } = {},
): Promise<Comparable[]> {
  const asOf = options.asOf ?? new Date();
  const statuses = criteria.statuses.filter((s) => (COMPARABLE_STATUSES as readonly string[]).includes(s));
  if (statuses.length === 0) return [];
  const hasPin = subject.Latitude != null && subject.Longitude != null;
  if (criteria.area === "radius" && !hasPin) return [];

  const earliestClose = await mlsDate(new Date(asOf.getTime() - criteria.closedWithinDays * 86_400_000));
  // Unknown when either end has no pin.
  const distance = hasPin ? milesFrom(subject.Latitude!, subject.Longitude!) : sql<number | null>`null`;
  const conditions = [
    // Never the subject itself.
    sql`${property.ListingKey} <> ${subject.ListingKey}`,
    inArray(property.StandardStatus, statuses),
    // The close-date window applies to sales; listings still open have no close date.
    sql`(${property.StandardStatus} <> 'Closed' or ${property.CloseDate} >= ${earliestClose})`,
    criteria.samePropertyType ? eq(property.PropertyType, subject.PropertyType) : undefined,
    criteria.area === "radius"
      ? sql`(${property.Latitude} is not null and ${property.Longitude} is not null and ${distance} <= ${criteria.radiusMiles})`
      : eq(property.PostalCode, subject.PostalCode),
    // A size or bedroom rule applies only when both listings have the figure.
    criteria.livingAreaPercent != null && subject.LivingArea != null
      ? sql`(${property.LivingArea} is null or ${property.LivingArea} between ${Math.floor(subject.LivingArea * (1 - criteria.livingAreaPercent / 100))} and ${Math.ceil(subject.LivingArea * (1 + criteria.livingAreaPercent / 100))})`
      : undefined,
    criteria.bedroomRange != null
      ? sql`${property.BedroomsTotal} between ${subject.BedroomsTotal - criteria.bedroomRange} and ${subject.BedroomsTotal + criteria.bedroomRange}`
      : undefined,
  ];

  const rows = await db
    .select({ listing: property, agentName: member.MemberFullName, officeName: office.OfficeName, distanceMiles: distance })
    .from(property)
    .innerJoin(member, eq(member.MemberKey, property.ListAgentKey))
    .innerJoin(office, eq(office.OfficeKey, property.ListOfficeKey))
    .where(and(...conditions))
    // Nearest first when there is a pin to measure from; otherwise most recent sale first.
    .orderBy(
      ...(hasPin ? [sql`${distance} asc nulls last`] : []),
      sql`${property.CloseDate} desc nulls last`,
      asc(property.ListingId),
    )
    .limit(COMPARABLE_DEFAULTS.limit);

  const marketTime = await getMarketTime(
    rows.map((r) => r.listing.ListingKey),
    { asOf },
  );
  return rows.map((row) => {
    const price = row.listing.StandardStatus === "Closed" ? row.listing.ClosePrice : row.listing.ListPrice;
    return {
      // Comparables carry no showing details, whoever is asking.
      listing: withoutShowing(row.listing),
      agentName: row.agentName,
      officeName: row.officeName,
      distanceMiles: row.distanceMiles == null ? null : Number(row.distanceMiles),
      pricePerSquareFoot: price != null && row.listing.LivingArea ? price / row.listing.LivingArea : null,
      marketTime: marketTime.get(row.listing.ListingKey)!,
    };
  });
}
