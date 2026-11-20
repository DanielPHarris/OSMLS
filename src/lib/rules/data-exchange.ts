import { MEMBER_STATUSES, OFFICE_STATUSES, PROPERTY_TYPES, STANDARD_STATUSES } from "../lookups";

/*
 * The export allowlist: every resource and field the data exchange feed may
 * carry, written out by hand. It is the only source for the feed's metadata,
 * its Field and Lookup resources, its responses, and what a query may name.
 *
 * A column added to the database is NOT served until it is added here. Nothing
 * about the feed is worked out from the database schema, so nothing internal
 * can reach it by accident.
 *
 * This is a distribution policy, and it is the maintainer's to set. It is wider
 * than a client copy (every status, parcel and coordinates, member and office
 * records) and narrower than what a member sees: there are no documents, no
 * showing instructions, no lock box details, no contact details for members,
 * and no MLS staff accounts.
 */

export type EdmType = "Edm.String" | "Edm.Int32" | "Edm.Decimal" | "Edm.Date" | "Edm.DateTimeOffset";

export type ServedField = {
  name: string;
  type: EdmType;
  /** The name of the lookup whose values this field holds, for fields that hold one of a fixed list. */
  lookup?: string;
  /**
   * Worked out when the response is made, not stored. A derived field can be
   * read but not filtered or sorted on, and a change to it does not move the
   * record's ModificationTimestamp.
   */
  derived?: true;
};

export type ServedResource = {
  name: string;
  /** The table the records come from. */
  table: string;
  key: string;
  /** A fixed condition on which records are served at all. Written here, never taken from a request. */
  only?: string;
  fields: readonly ServedField[];
};

const text = (name: string): ServedField => ({ name, type: "Edm.String" });
const whole = (name: string): ServedField => ({ name, type: "Edm.Int32" });
const decimal = (name: string): ServedField => ({ name, type: "Edm.Decimal" });
const day = (name: string): ServedField => ({ name, type: "Edm.Date" });
const moment = (name: string): ServedField => ({ name, type: "Edm.DateTimeOffset" });
const oneOf = (name: string, lookup: string): ServedField => ({ name, type: "Edm.String", lookup });

export const SERVED_RESOURCES: readonly ServedResource[] = [
  {
    name: "Property",
    table: "Property",
    key: "ListingKey",
    fields: [
      text("ListingKey"), text("ListingId"), oneOf("StandardStatus", "StandardStatus"), oneOf("PropertyType", "PropertyType"),
      decimal("ListPrice"), decimal("OriginalListPrice"), decimal("ClosePrice"), day("CloseDate"), day("ListingContractDate"), day("OnMarketDate"),
      text("StreetNumber"), text("StreetName"), text("UnitNumber"), text("City"), text("StateOrProvince"), text("PostalCode"), text("UnparsedAddress"),
      text("CountyOrParish"), text("ParcelNumber"), decimal("Latitude"), decimal("Longitude"),
      whole("BedroomsTotal"), whole("BathroomsTotalInteger"), whole("LivingArea"), decimal("LotSizeAcres"), whole("YearBuilt"), text("PublicRemarks"),
      text("ListAgentKey"), text("ListOfficeKey"),
      moment("OriginalEntryTimestamp"), moment("ModificationTimestamp"), moment("StatusChangeTimestamp"), moment("PriceChangeTimestamp"),
      { ...whole("DaysOnMarket"), derived: true }, { ...whole("CumulativeDaysOnMarket"), derived: true },
    ],
  },
  {
    name: "Member",
    table: "Member",
    key: "MemberKey",
    // Agents. MLS staff accounts are not part of the feed.
    only: `"OsmlsRole" = 'agent'`,
    fields: [
      text("MemberKey"), text("MemberMlsId"), text("MemberFirstName"), text("MemberLastName"), text("MemberFullName"),
      oneOf("MemberStatus", "MemberStatus"), text("OfficeKey"), moment("ModificationTimestamp"),
    ],
  },
  {
    name: "Office",
    table: "Office",
    key: "OfficeKey",
    fields: [
      text("OfficeKey"), text("OfficeMlsId"), text("OfficeName"), text("MainOfficeKey"), oneOf("OfficeStatus", "OfficeStatus"),
      text("OfficePhone"), text("OfficeCity"), text("OfficeStateOrProvince"), moment("ModificationTimestamp"),
    ],
  },
  {
    name: "Media",
    table: "Media",
    key: "MediaKey",
    // Photos of listings. A document's record is never served.
    only: `"MediaCategory" = 'Photo' and "ResourceName" = 'Property'`,
    fields: [
      text("MediaKey"), text("ResourceName"), text("ResourceRecordKey"), text("MediaCategory"), text("MediaType"), whole("Order"),
      text("ShortDescription"), { ...text("MediaURL"), derived: true }, moment("ModificationTimestamp"),
    ],
  },
];

/** The values of each lookup a served field holds. */
export const SERVED_LOOKUPS: Readonly<Record<string, readonly string[]>> = {
  StandardStatus: STANDARD_STATUSES,
  PropertyType: PROPERTY_TYPES,
  MemberStatus: MEMBER_STATUSES,
  OfficeStatus: OFFICE_STATUSES,
};

export const servedResource = (name: string): ServedResource | undefined => SERVED_RESOURCES.find((r) => r.name === name);

/** Records in a page when a request does not say, and the most it may ask for. */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
