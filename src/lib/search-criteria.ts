import { SEARCH_SORTS, parseBounds, type SearchFilters, type SearchSort } from "./listings";
import { STANDARD_STATUSES, type StandardStatus } from "./lookups";
import { isCalendarDate, isOwnKey } from "./validation";

/*
 * The one definition of what a listing search can be asked for. The search page
 * reads its address through it, and saved searches store exactly this and
 * nothing else, so a saved search can only ever replay an ordinary search.
 */
export type SearchCriteria = {
  listingId?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  minBaths?: number;
  /** Always explicit. An empty list means every status. */
  statuses: StandardStatus[];
  closedFrom?: string;
  closedTo?: string;
  minClosePrice?: number;
  maxClosePrice?: number;
  sort: SearchSort;
  /** A map area as "west,south,east,north". */
  bounds?: string;
  /**
   * "Only my listings". Stored as this choice, never as a member's key, so it
   * always means whoever is running the search.
   */
  mine: boolean;
};

export const DEFAULT_STATUSES: StandardStatus[] = ["Active", "Coming Soon"];
export const DEFAULT_CRITERIA: SearchCriteria = { statuses: DEFAULT_STATUSES, sort: "changed", mine: false };

type Params = Record<string, string | string[] | undefined>;

const TEXT_FIELDS = ["listingId", "address", "city", "postalCode"] as const;
const NUMBER_FIELDS = ["minPrice", "maxPrice", "minBeds", "minBaths", "minClosePrice", "maxClosePrice"] as const;
const DATE_FIELDS = ["closedFrom", "closedTo"] as const;

const LABELS: Record<string, string> = {
  listingId: "listing number",
  address: "address",
  city: "city",
  postalCode: "ZIP code",
  minPrice: "minimum price",
  maxPrice: "maximum price",
  minBeds: "minimum bedrooms",
  minBaths: "minimum bathrooms",
  closedFrom: "closed on or after",
  closedTo: "closed on or before",
  minClosePrice: "minimum close price",
  maxClosePrice: "maximum close price",
  sort: "sort order",
  bounds: "map area",
  statuses: "status",
  mine: "only my listings",
};

const isStatus = (v: unknown): v is StandardStatus => (STANDARD_STATUSES as readonly unknown[]).includes(v);
const isDate = isCalendarDate;
const isSort = (v: unknown): v is SearchSort => isOwnKey(SEARCH_SORTS, v);
const cleanText = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim().slice(0, 200) : "";
  return s === "" ? undefined : s;
};
const cleanNumber = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Criteria from a search page address. Anything it does not recognise is left out. */
export function criteriaFromParams(p: Params): SearchCriteria {
  const out: SearchCriteria = { ...DEFAULT_CRITERIA };
  for (const f of TEXT_FIELDS) out[f] = cleanText(first(p[f]));
  for (const f of NUMBER_FIELDS) out[f] = cleanNumber(first(p[f]));
  for (const f of DATE_FIELDS) out[f] = isDate(first(p[f])) ? first(p[f]) : undefined;
  // "s" marks a submitted search, where no ticked status means every status.
  out.statuses = p.s !== undefined ? ([] as string[]).concat(p.status ?? []).filter(isStatus) : DEFAULT_STATUSES;
  const sort = first(p.sort);
  out.sort = isSort(sort) ? sort : "changed";
  const bounds = first(p.bounds);
  out.bounds = parseBounds(bounds) ? bounds : undefined;
  out.mine = first(p.mine) === "1";
  return out;
}

/** The search page address that asks for these criteria. */
export function criteriaToParams(c: SearchCriteria): URLSearchParams {
  const params = new URLSearchParams({ s: "1" });
  for (const f of [...TEXT_FIELDS, ...DATE_FIELDS]) if (c[f]) params.set(f, c[f]!);
  for (const f of NUMBER_FIELDS) if (c[f] != null) params.set(f, String(c[f]));
  for (const status of c.statuses) params.append("status", status);
  if (c.sort !== "changed") params.set("sort", c.sort);
  if (c.bounds) params.set("bounds", c.bounds);
  if (c.mine) params.set("mine", "1");
  return params;
}

/**
 * Criteria read back from storage, checked again as though they had just been
 * typed. Whatever the application no longer accepts is dropped and named, so the
 * member can be told their search was widened.
 */
export function criteriaFromStored(stored: unknown): { criteria: SearchCriteria; ignored: string[] } {
  const raw = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  const criteria: SearchCriteria = { ...DEFAULT_CRITERIA, statuses: [] };
  const ignored: string[] = [];
  const known = new Set<string>([...TEXT_FIELDS, ...NUMBER_FIELDS, ...DATE_FIELDS, "statuses", "sort", "bounds", "mine"]);

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (!known.has(key)) {
      // Never echo an unrecognised name back to the page.
      ignored.push("a criterion this version does not recognise");
      continue;
    }
    if ((TEXT_FIELDS as readonly string[]).includes(key)) {
      const v = cleanText(value);
      if (v === undefined) ignored.push(LABELS[key]);
      else criteria[key as (typeof TEXT_FIELDS)[number]] = v;
    } else if ((NUMBER_FIELDS as readonly string[]).includes(key)) {
      const v = cleanNumber(value);
      if (v === undefined) ignored.push(LABELS[key]);
      else criteria[key as (typeof NUMBER_FIELDS)[number]] = v;
    } else if ((DATE_FIELDS as readonly string[]).includes(key)) {
      if (isDate(value)) criteria[key as (typeof DATE_FIELDS)[number]] = value;
      else ignored.push(LABELS[key]);
    } else if (key === "statuses") {
      const list = Array.isArray(value) ? value : [];
      criteria.statuses = list.filter(isStatus);
      const dropped = list.filter((s) => !isStatus(s)).length;
      if (!Array.isArray(value)) ignored.push(LABELS.statuses);
      else if (dropped > 0) ignored.push(dropped === 1 ? "one status" : `${dropped} statuses`);
    } else if (key === "sort") {
      if (isSort(value)) criteria.sort = value;
      else ignored.push(LABELS.sort);
    } else if (key === "bounds") {
      if (typeof value === "string" && parseBounds(value)) criteria.bounds = value;
      else ignored.push(LABELS.bounds);
    } else if (key === "mine") {
      if (typeof value === "boolean") criteria.mine = value;
      else ignored.push(LABELS.mine);
    }
  }
  return { criteria, ignored: [...new Set(ignored)] };
}

/** The filters the search itself takes, for a particular member. */
export function criteriaToFilters(c: SearchCriteria, member: { MemberKey: string; OsmlsRole: string }): SearchFilters {
  return {
    listingId: c.listingId,
    address: c.address,
    city: c.city,
    postalCode: c.postalCode,
    minPrice: c.minPrice,
    maxPrice: c.maxPrice,
    minBeds: c.minBeds,
    minBaths: c.minBaths,
    statuses: c.statuses,
    closedFrom: c.closedFrom,
    closedTo: c.closedTo,
    minClosePrice: c.minClosePrice,
    maxClosePrice: c.maxClosePrice,
    sort: c.sort,
    bounds: parseBounds(c.bounds),
    // Always the member who is searching now.
    listAgentKey: c.mine && member.OsmlsRole === "agent" ? member.MemberKey : undefined,
  };
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

/** The criteria in words, for lists of saved searches. */
export function describeCriteria(c: SearchCriteria): string {
  const parts: string[] = [];
  if (c.mine) parts.push("My listings");
  parts.push(c.statuses.length ? c.statuses.join(", ") : "Every status");
  if (c.listingId) parts.push(`listing ${c.listingId}`);
  if (c.address) parts.push(`address contains "${c.address}"`);
  if (c.city) parts.push(`in ${c.city}`);
  if (c.postalCode) parts.push(`ZIP ${c.postalCode}`);
  if (c.minPrice != null || c.maxPrice != null)
    parts.push(`price ${c.minPrice != null ? money(c.minPrice) : "any"} to ${c.maxPrice != null ? money(c.maxPrice) : "any"}`);
  if (c.minBeds != null) parts.push(`${c.minBeds}+ beds`);
  if (c.minBaths != null) parts.push(`${c.minBaths}+ baths`);
  if (c.closedFrom || c.closedTo) parts.push(`closed ${c.closedFrom ?? "any time"} to ${c.closedTo ?? "now"}`);
  if (c.minClosePrice != null || c.maxClosePrice != null)
    parts.push(`close price ${c.minClosePrice != null ? money(c.minClosePrice) : "any"} to ${c.maxClosePrice != null ? money(c.maxClosePrice) : "any"}`);
  if (c.bounds) parts.push("within a map area");
  if (c.sort !== "changed" && isSort(c.sort)) parts.push(`sorted by ${SEARCH_SORTS[c.sort].toLowerCase()}`);
  return parts.join(" · ");
}
