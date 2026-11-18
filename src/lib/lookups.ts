// Lookup values use the display names from the RESO Data Dictionary 2.0.

export const STANDARD_STATUSES = [
  "Active",
  "Active Under Contract",
  "Canceled",
  "Closed",
  "Coming Soon",
  "Expired",
  "Hold",
  "Pending",
  "Withdrawn",
] as const;
export type StandardStatus = (typeof STANDARD_STATUSES)[number];

export const PROPERTY_TYPES = [
  "Residential",
  "Residential Lease",
  "Residential Income",
  "Land",
  "Farm",
  "Manufactured In Park",
  "Commercial Sale",
  "Commercial Lease",
  "Business Opportunity",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const MEMBER_STATUSES = ["Active", "Inactive"] as const;

// OSMLS roles. "Listing agent" is not a separate role: it is the agent named in
// ListAgentKey on a given listing.
export const ROLES = ["agent", "staff"] as const;
export type Role = (typeof ROLES)[number];

/** Quote a list of values for use inside a SQL CHECK ... IN (...) clause. */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}
