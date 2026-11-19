import type { Property } from "../../db/schema";
import type { StandardStatus } from "../lookups";

/*
 * The client boundary: what may leave the MLS on a copy made for a client.
 *
 * This file is the one definition. Anything shown to a client (a printed client
 * copy today, a shared page later) is built by toClientListing and from nothing
 * else. A field that is not named here does not reach a client.
 *
 * These are OSMLS's starting choices, for an MLS to change here. They are
 * product defaults, not access rules and not a statement of any MLS's policy.
 */

/** Listings in any other status are left off client copies. */
export const CLIENT_COPY_STATUSES: readonly StandardStatus[] = ["Active", "Active Under Contract", "Pending", "Closed"];

export const isClientCopyStatus = (status: string): boolean =>
  (CLIENT_COPY_STATUSES as readonly string[]).includes(status);

/**
 * Listing fields copied as they are. Not here, among others: days on market and
 * OriginalListPrice (a default, see above), showing and lock box fields, parcel,
 * county, coordinates, local fields, timestamps, and every key.
 */
export const CLIENT_LISTING_FIELDS = [
  "ListingId",
  "StandardStatus",
  "PropertyType",
  "ListPrice",
  "UnparsedAddress",
  "City",
  "StateOrProvince",
  "PostalCode",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "LivingArea",
  "LotSizeAcres",
  "YearBuilt",
  "PublicRemarks",
] as const satisfies readonly (keyof Property)[];

export type ClientListing = Pick<Property, (typeof CLIENT_LISTING_FIELDS)[number]> & {
  /** Set only for a closed listing. */
  ClosePrice: number | null;
  CloseDate: string | null;
  /** Attribution: names only, no phone, email, or ID. */
  ListOfficeName: string;
  ListAgentFullName: string;
  /**
   * The application's address for each photo shown. It carries that photo's key
   * and nothing else about the file: no storage path, size, or hash.
   */
  photoUrls: string[];
};

export type ClientListingSource = {
  listing: Property;
  agentName: string;
  officeName: string;
  /** Keys of photos only, in the order to show them. */
  photoKeys: readonly string[];
};

/** Builds a new object holding only what a client may be given. */
export function toClientListing({ listing, agentName, officeName, photoKeys }: ClientListingSource): ClientListing {
  const copied = Object.fromEntries(CLIENT_LISTING_FIELDS.map((field) => [field, listing[field]])) as Pick<
    Property,
    (typeof CLIENT_LISTING_FIELDS)[number]
  >;
  const closed = listing.StandardStatus === "Closed";
  return {
    ...copied,
    ClosePrice: closed ? listing.ClosePrice : null,
    CloseDate: closed ? listing.CloseDate : null,
    ListOfficeName: officeName,
    ListAgentFullName: agentName,
    photoUrls: photoKeys.map((key) => `/media/${key}`),
  };
}
