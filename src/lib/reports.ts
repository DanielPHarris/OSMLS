import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { office, property, type Member, type Property } from "../db/schema";
import { canViewShowing, isActive } from "./access";
import { getListing, localDate, searchListings } from "./listings";
import { getMarketTime } from "./market-time";
import {
  CLIENT_COPY_STATUSES,
  isClientCopyStatus,
  toClientListing,
  type ClientListing,
  type ClientListingSource,
} from "./rules/client-copy";
import { MAX_LISTINGS_PER_REPORT, MAX_PHOTOS_PER_REPORT, MAX_SEARCH_RESULTS } from "./rules/local";
import { getCollection } from "./saved-work";
import { criteriaToFilters, describeCriteria, type SearchCriteria } from "./search-criteria";
import { isOwnKey } from "./validation";

/*
 * Printable reports: one listing, a collection, or the current search, as an
 * agent copy or a client copy. Nothing is stored; each report is read fresh and
 * shows listings as they are now.
 *
 * A client copy is built only by toClientListing (src/lib/rules/client-copy.ts).
 * An agent copy starts from the same data and adds what the requesting member
 * may see under src/lib/access.ts. No printout carries change history or
 * documents.
 */

export const REPORT_COPIES = { agent: "Agent copy", client: "Client copy" } as const;
export type ReportCopy = keyof typeof REPORT_COPIES;

/** The copy asked for, or null. There is no default: an unknown value is refused. */
export const parseCopy = (value: unknown): ReportCopy | null => (isOwnKey(REPORT_COPIES, value) ? value : null);

export type ShowingDetails = Pick<
  Property,
  | "ShowingInstructions"
  | "ShowingRequirements"
  | "ShowingContactName"
  | "ShowingContactPhone"
  | "ShowingContactType"
  | "LockBoxType"
  | "LockBoxLocation"
>;

export type AgentListing = ClientListing &
  Pick<Property, "OriginalListPrice" | "CountyOrParish" | "ParcelNumber"> & {
    daysOnMarket: number;
    cumulativeDaysOnMarket: number;
    /** Null when this member may not see how the listing is shown. */
    showing: ShowingDetails | null;
  };

export type Disclosure = {
  /** How many could have been shown: listings, or photos for a single listing. */
  eligible: number;
  shown: number;
  /** False for a search that was itself cut off: its matches were not all read. */
  totalIsExact: boolean;
  /** Left off a client copy because of their status. Counted among what was read. */
  omittedForStatus: number;
};

type ReportBase = {
  kind: "listing" | "collection" | "search";
  disclosure: Disclosure;
  /** The requesting member's own details. */
  preparedBy: { name: string; officeName: string | null; phone: string | null; email: string };
  preparedOn: string;
};
export type ClientReport = ReportBase & { copy: "client"; listings: ClientListing[] };
export type AgentReport = ReportBase & {
  copy: "agent";
  listings: AgentListing[];
  /** The collection's name or the search in words. Never on a client copy. */
  title: string | null;
};
export type Report = ClientReport | AgentReport;

/** A client copy was asked for, and this listing's status is not one given to clients. */
export type Refused = { refused: "status"; status: string };

type Source = ClientListingSource & { marketTime: { daysOnMarket: number; cumulativeDaysOnMarket: number } };

const showingOf = (p: Property): ShowingDetails => ({
  ShowingInstructions: p.ShowingInstructions,
  ShowingRequirements: p.ShowingRequirements,
  ShowingContactName: p.ShowingContactName,
  ShowingContactPhone: p.ShowingContactPhone,
  ShowingContactType: p.ShowingContactType,
  LockBoxType: p.LockBoxType,
  LockBoxLocation: p.LockBoxLocation,
});

const toAgentListing = (source: Source, showing: ShowingDetails | null): AgentListing => ({
  ...toClientListing(source),
  OriginalListPrice: source.listing.OriginalListPrice,
  CountyOrParish: source.listing.CountyOrParish,
  ParcelNumber: source.listing.ParcelNumber,
  daysOnMarket: source.marketTime.daysOnMarket,
  cumulativeDaysOnMarket: source.marketTime.cumulativeDaysOnMarket,
  showing,
});

async function base(viewer: Member, kind: ReportBase["kind"], disclosure: Disclosure): Promise<ReportBase> {
  const [own] = viewer.OfficeKey
    ? await db.select({ name: office.OfficeName }).from(office).where(eq(office.OfficeKey, viewer.OfficeKey))
    : [];
  return {
    kind,
    disclosure,
    preparedBy: {
      name: viewer.MemberFullName,
      officeName: own?.name ?? null,
      phone: viewer.MemberDirectPhone,
      email: viewer.MemberEmail,
    },
    preparedOn: localDate(new Date()),
  };
}

/**
 * Showing details for each listing this member may see them for. Lists of
 * listings arrive without them, so they are read here, one rule for every row.
 */
async function showingFor(viewer: Member, keys: string[]): Promise<Map<string, ShowingDetails>> {
  const out = new Map<string, ShowingDetails>();
  if (keys.length === 0) return out;
  const rows = await db.select().from(property).where(inArray(property.ListingKey, keys));
  for (const row of rows) if (canViewShowing(viewer, row)) out.set(row.ListingKey, showingOf(row));
  return out;
}

/** Eligibility first, then the limit, so a client copy is filled with listings a client may have. */
async function listReport(
  viewer: Member,
  copy: ReportCopy,
  kind: "collection" | "search",
  sources: Source[],
  title: string,
  totalIsExact: boolean,
): Promise<Report> {
  const eligible = copy === "client" ? sources.filter((s) => isClientCopyStatus(s.listing.StandardStatus)) : sources;
  const shown = eligible.slice(0, MAX_LISTINGS_PER_REPORT);
  const common = await base(viewer, kind, {
    eligible: eligible.length,
    shown: shown.length,
    totalIsExact,
    omittedForStatus: sources.length - eligible.length,
  });
  if (copy === "client") return { ...common, copy, listings: shown.map(toClientListing) };
  const showing = await showingFor(
    viewer,
    shown.map((s) => s.listing.ListingKey),
  );
  return {
    ...common,
    copy,
    title,
    listings: shown.map((s) => toAgentListing(s, showing.get(s.listing.ListingKey) ?? null)),
  };
}

type ListRow = Omit<Source, "photoKeys"> & { firstPhotoKey: string | null };
const withFirstPhoto = (rows: ListRow[]): Source[] =>
  rows.map((row) => ({ ...row, photoKeys: row.firstPhotoKey ? [row.firstPhotoKey] : [] }));

export async function listingReport(viewer: Member | null, key: string, copy: ReportCopy): Promise<Report | Refused | null> {
  if (!isActive(viewer)) return null;
  const found = await getListing(key, viewer);
  if (!found) return null;
  const { listing } = found;
  if (copy === "client" && !isClientCopyStatus(listing.StandardStatus)) {
    return { refused: "status", status: listing.StandardStatus };
  }
  const photoKeys = found.photos.slice(0, MAX_PHOTOS_PER_REPORT).map((p) => p.MediaKey);
  const marketTime = (await getMarketTime([listing.ListingKey])).get(listing.ListingKey) ?? {
    daysOnMarket: 0,
    cumulativeDaysOnMarket: 0,
  };
  const source: Source = {
    listing,
    agentName: found.agent.MemberFullName,
    officeName: found.office.OfficeName,
    photoKeys,
    marketTime,
  };
  const common = await base(viewer, "listing", {
    eligible: found.photos.length,
    shown: photoKeys.length,
    totalIsExact: true,
    omittedForStatus: 0,
  });
  if (copy === "client") return { ...common, copy, listings: [toClientListing(source)] };
  // getListing has already blanked the showing details for a member who may not see them.
  return { ...common, copy, title: null, listings: [toAgentListing(source, found.showingVisible ? showingOf(listing) : null)] };
}

/** Null for someone else's collection and for one that does not exist alike. */
export async function collectionReport(viewer: Member | null, key: unknown, copy: ReportCopy): Promise<Report | null> {
  if (!isActive(viewer)) return null;
  const found = await getCollection(viewer, key);
  if (!found) return null;
  return listReport(viewer, copy, "collection", withFirstPhoto(found.rows), found.collection.CollectionName, true);
}

/** The search as this member would run it now. */
export async function searchReport(viewer: Member | null, criteria: SearchCriteria, copy: ReportCopy): Promise<Report | null> {
  if (!isActive(viewer)) return null;
  const { rows, truncated } = await searchListings(criteriaToFilters(criteria, viewer));
  return listReport(viewer, copy, "search", withFirstPhoto(rows), describeCriteria(criteria), !truncated);
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What a reader must be told about anything left out. Empty when the report is
 * whole. A total is stated only when it was counted.
 */
export function disclosureLines(report: Report): string[] {
  const { eligible, shown, totalIsExact, omittedForStatus } = report.disclosure;
  const lines: string[] = [];
  if (report.kind === "listing") {
    if (shown < eligible) lines.push(`${shown} of ${count(eligible, "photo")} shown.`);
    return lines;
  }
  if (!totalIsExact) {
    lines.push(
      `Showing ${shown < eligible ? "the first " : ""}${count(shown, "listing")}. More listings match this search than the ${MAX_SEARCH_RESULTS} it read, so this report is incomplete and the total is not known.`,
    );
  } else if (shown < eligible) {
    lines.push(`Showing the first ${shown} of ${count(eligible, "listing")}.`);
  }
  if (omittedForStatus > 0) {
    const where = report.kind === "collection" ? "in this collection" : totalIsExact ? "matching this search" : `among the ${MAX_SEARCH_RESULTS} read`;
    lines.push(
      `${count(omittedForStatus, "listing")} ${where} ${omittedForStatus === 1 ? "is" : "are"} not included: client copies include only ${CLIENT_COPY_STATUSES.join(", ")} listings.`,
    );
  }
  return lines;
}
