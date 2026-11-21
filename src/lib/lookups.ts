// Lookup values use the display names from the RESO Data Dictionary 2.1.

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
export const OFFICE_STATUSES = ["Active", "Inactive"] as const;

export const MEDIA_CATEGORIES = ["Photo", "Document"] as const;

/*
 * Who may see a document. The stored values are Data Dictionary Media.Permission
 * values; the labels are what OSMLS shows. Ordered from most to least restrictive.
 */
export const DOCUMENT_PERMISSIONS = ["Agent Only", "Office Only", "Private"] as const;
export type DocumentPermission = (typeof DOCUMENT_PERMISSIONS)[number];
export const DOCUMENT_PERMISSION_LABELS: Record<DocumentPermission, string> = {
  "Agent Only": "Listing agent only",
  "Office Only": "Listing office only",
  Private: "All MLS members",
};
/** A new document is as restricted as it can be until someone chooses otherwise. */
export const DEFAULT_DOCUMENT_PERMISSION: DocumentPermission = "Agent Only";

export const SHOWING_REQUIREMENTS = [
  "24 Hour Notice",
  "Appointment Only",
  "Call Listing Agent",
  "Call Listing Office",
  "Call Manager",
  "Call Owner",
  "Call Tenant",
  "Combination Lock Box",
  "Do Not Show",
  "Email Listing Agent",
  "Key In Office",
  "Lockbox",
  "No Lockbox",
  "No Sign",
  "Restricted Hours",
  "See Remarks",
  "Showing Service",
  "Text Listing Agent",
] as const;
export const SHOWING_CONTACT_TYPES = ["Agent", "Occupant", "Owner", "Property Manager"] as const;
export const LOCK_BOX_TYPES = [
  "Call Listing Office",
  "Call Seller Direct",
  "Combo",
  "None",
  "Other",
  "See Remarks",
  "SentriLock",
  "Supra",
] as const;

// OSMLS roles. "Listing agent" is not a separate role: it is the agent named in
// ListAgentKey on a given listing.
export const ROLES = ["agent", "staff"] as const;
export type Role = (typeof ROLES)[number];

/**
 * What an MLS staff account may administer. Each is held by an individual
 * account, and only an active staff account's capabilities count for anything.
 * They divide administration; they do not change what staff may do to listings.
 */
export const CAPABILITIES = ["members", "offices", "settings", "compliance", "data", "imports", "staff"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABELS: Record<Capability, string> = {
  members: "Manage members",
  offices: "Manage offices",
  settings: "Manage settings",
  compliance: "Manage compliance",
  data: "Manage data access",
  imports: "Import listings",
  staff: "Manage staff",
};

/** Quote a list of values for use inside a SQL CHECK ... IN (...) clause. */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

/** What a flag on a listing is about. */
export const FLAG_CATEGORIES = [
  "Incorrect information",
  "Photos",
  "Remarks",
  "Status not updated",
  "Duplicate listing",
  "Market time or relisting link",
  "Other",
] as const;
export type FlagCategory = (typeof FLAG_CATEGORIES)[number];

/** A flag is open until compliance staff close it, one way or the other. Closed is final. */
export const FLAG_STATES = ["Open", "Resolved", "Dismissed"] as const;
export type FlagState = (typeof FLAG_STATES)[number];

/**
 * How the earlier listing a listing continues is chosen: by matching, or by
 * compliance staff saying there is none, or naming it.
 */
export const RELISTING_LINK_MODES = ["automatic", "none", "named"] as const;
export type RelistingLinkMode = (typeof RELISTING_LINK_MODES)[number];
