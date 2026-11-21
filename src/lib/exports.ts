import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { exportLog, type Member } from "../db/schema";
import { isActive } from "./access";
import { mlsDate, searchListings } from "./listings";
import { withOneSettingsVersion } from "./market-time";
import { isClientCopyStatus, toClientListing } from "./rules/client-copy";
import { criteriaToFilters, type SearchCriteria } from "./search-criteria";

/*
 * Exporting the listings a search found to a file. A file travels further than
 * a page, so it carries less than a printed copy: never showing instructions,
 * lock box details, documents, history, flags, keys, or photo addresses, in
 * either kind.
 *
 * The client export is built by the client-copy rule (src/lib/rules/client-copy.ts)
 * and by nothing else. The agent export is the same columns for listings in
 * every status, with the five further columns a printed agent copy has.
 */

export const EXPORT_KINDS = ["agent", "client"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const parseExportKind = (v: unknown): ExportKind | null => (v === "agent" || v === "client" ? v : null);

/** The columns of each kind of file, in order. This is the whole of what a file can hold. */
export const CLIENT_EXPORT_COLUMNS = [
  "ListingId", "StandardStatus", "PropertyType", "ListPrice", "ClosePrice", "CloseDate", "UnparsedAddress", "City", "StateOrProvince", "PostalCode",
  "BedroomsTotal", "BathroomsTotalInteger", "LivingArea", "LotSizeAcres", "YearBuilt", "PublicRemarks", "ListAgentFullName", "ListOfficeName",
] as const;
export const AGENT_EXPORT_COLUMNS = [...CLIENT_EXPORT_COLUMNS, "OriginalListPrice", "CountyOrParish", "ParcelNumber", "DaysOnMarket", "CumulativeDaysOnMarket"] as const;
export const exportColumns = (kind: ExportKind): readonly string[] => (kind === "client" ? CLIENT_EXPORT_COLUMNS : AGENT_EXPORT_COLUMNS);

type Cell = string | number | null;

export type SearchExport = {
  kind: ExportKind;
  columns: readonly string[];
  rows: Cell[][];
  /** Listings in the file. */
  listings: number;
  /** Read by the search and left out of a client export because of their status. Always 0 for an agent export. */
  omittedForStatus: number;
  /**
   * The search found more listings than it reads. Those beyond were never
   * considered, and how many there are is not known: a search does not count them.
   */
  searchCutOff: boolean;
  fileName: string;
};

/**
 * The listings a search finds for this member now, as the rows of a file. A
 * search reads at most its limit of listings, in its order; the export is made
 * from those and no others. For a client export, listings in other statuses are
 * then left out, so it can hold fewer than the limit while more eligible
 * listings lie beyond what the search read. Null for anyone who is not an
 * active member.
 */
export async function searchExport(viewer: Member | null, criteria: SearchCriteria, kind: ExportKind): Promise<SearchExport | null> {
  if (!isActive(viewer)) return null;
  return withOneSettingsVersion(async () => {
    const { rows: found, truncated } = await searchListings(criteriaToFilters(criteria, viewer));
    const eligible = kind === "client" ? found.filter((row) => isClientCopyStatus(row.listing.StandardStatus)) : found;
    const rows = eligible.map((row): Cell[] => {
      // The client-copy rule builds the shared columns for both kinds: among them, a sale price only for a sale.
      const shared = toClientListing({ listing: row.listing, agentName: row.agentName, officeName: row.officeName, photoKeys: [] }) as unknown as Record<string, Cell>;
      const further: Record<string, Cell> = {
        OriginalListPrice: row.listing.OriginalListPrice,
        CountyOrParish: row.listing.CountyOrParish,
        ParcelNumber: row.listing.ParcelNumber,
        DaysOnMarket: row.marketTime.daysOnMarket,
        CumulativeDaysOnMarket: row.marketTime.cumulativeDaysOnMarket,
      };
      // Each cell is taken by column name from one of those two, so nothing else about the listing can reach the file.
      return exportColumns(kind).map((column) => (CLIENT_EXPORT_COLUMNS as readonly string[]).includes(column) ? (shared[column] ?? null) : (further[column] ?? null));
    });
    const date = await mlsDate(new Date());
    return {
      kind,
      columns: exportColumns(kind),
      rows,
      listings: rows.length,
      omittedForStatus: found.length - eligible.length,
      searchCutOff: truncated,
      fileName: `osmls-${kind}-export-${rows.length}-listing${rows.length === 1 ? "" : "s"}-${date}.csv`,
    };
  });
}

/**
 * A cell of text made safe for a spreadsheet. Text that begins with a
 * character a spreadsheet takes as the start of a formula is given a leading
 * apostrophe, so it is shown and not run. Numbers are written as they are.
 */
function cell(value: Cell): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const inert = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(inert) ? `"${inert.replace(/"/g, '""')}"` : inert;
}

/** The file: a header row, then one row per listing, and nothing else. UTF-8, marked as such for spreadsheets. */
export function toCsv(file: Pick<SearchExport, "columns" | "rows">): string {
  return `﻿${[file.columns.map(cell), ...file.rows.map((row) => row.map(cell))].map((row) => row.join(",")).join("\r\n")}\r\n`;
}

/** Records that a member took a file: who, when, which kind, the search, and what the file held. */
export const recordExport = (viewer: Member, criteria: SearchCriteria, file: SearchExport) =>
  db.insert(exportLog).values({
    MemberKey: viewer.MemberKey,
    Kind: file.kind,
    Criteria: criteria,
    ListingCount: file.listings,
    OmittedForStatus: file.omittedForStatus,
    SearchCutOff: file.searchCutOff,
  });

/** A member's own exports, newest first. */
export const exportsBy = (viewer: Member) => db.select().from(exportLog).where(eq(exportLog.MemberKey, viewer.MemberKey)).orderBy(desc(exportLog.ExportTimestamp));

/** What a member is told before taking the file, and what a reader of it should know. */
export function exportDisclosure(file: Pick<SearchExport, "kind" | "listings" | "omittedForStatus" | "searchCutOff">, searchLimit: number): string[] {
  const lines = [`The file holds ${file.listings} listing${file.listings === 1 ? "" : "s"}.`];
  if (file.omittedForStatus > 0) {
    lines.push(`${file.omittedForStatus} of the listings the search read ${file.omittedForStatus === 1 ? "was" : "were"} left out because a client export holds only Active, Active Under Contract, Pending and Closed listings.`);
  }
  if (file.searchCutOff) {
    lines.push(
      `The search found more than ${searchLimit} listings and read only the first ${searchLimit} in its order. The rest were not considered, and how many there are is not known.${file.kind === "client" ? " Some of them may be listings a client export would hold." : ""}`,
    );
  }
  return lines;
}
