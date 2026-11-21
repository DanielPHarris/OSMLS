import { MEMBER_STATUSES, OFFICE_STATUSES, PROPERTY_TYPES, STANDARD_STATUSES, sqlList } from "../lookups";
import { CLIENT_COPY_STATUSES } from "./client-copy";

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
   * Worked out when the response is made, not stored. A change to a derived
   * field does not move the record's ModificationTimestamp.
   */
  derived?: true;
  /**
   * For a derived field: it can be filtered and sorted on all the same. The
   * days-on-market figures can, at the cost of working them out for every
   * listing before the query is answered. A photo's address cannot.
   */
  queryable?: true;
  /**
   * Set only by a feed (below): what the feed gives in place of the stored
   * column. It is what is returned and also what is filtered and sorted on, so
   * a value the feed does not give cannot be found out by querying for it.
   */
  given?: string;
};

export type ServedResource = {
  name: string;
  /**
   * Where the records come from: a table, or for the two resources that
   * describe the feed itself, the allowlist ("described").
   */
  table: string;
  described?: "fields" | "lookups";
  key: string;
  /** Another served resource that can be read along with each record, by $expand. */
  expand?: { name: string; resource: string; on: string; orderBy: string };
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
      text("StreetNumber"), text("StreetName"), text("UnitNumber"), oneOf("City", "City"), oneOf("StateOrProvince", "StateOrProvince"), text("PostalCode"), text("UnparsedAddress"),
      oneOf("CountyOrParish", "CountyOrParish"), text("ParcelNumber"), decimal("Latitude"), decimal("Longitude"),
      // LivingArea is a decimal in the Data Dictionary, though OSMLS stores whole numbers.
      whole("BedroomsTotal"), whole("BathroomsTotalInteger"), decimal("LivingArea"), decimal("LotSizeAcres"), whole("YearBuilt"), text("PublicRemarks"),
      text("ListAgentKey"), text("ListOfficeKey"),
      moment("OriginalEntryTimestamp"), moment("ModificationTimestamp"), moment("StatusChangeTimestamp"), moment("PriceChangeTimestamp"),
      { ...whole("DaysOnMarket"), derived: true, queryable: true }, { ...whole("CumulativeDaysOnMarket"), derived: true, queryable: true },
    ],
    expand: { name: "Media", resource: "Media", on: "ResourceRecordKey", orderBy: "Order" },
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
      text("OfficePhone"), text("OfficeCity"), oneOf("OfficeStateOrProvince", "StateOrProvince"), moment("ModificationTimestamp"),
    ],
  },
  {
    name: "Media",
    table: "Media",
    key: "MediaKey",
    // Photos of listings. A document's record is never served.
    only: `"MediaCategory" = 'Photo' and "ResourceName" = 'Property'`,
    fields: [
      text("MediaKey"), oneOf("ResourceName", "ResourceName"), text("ResourceRecordKey"), oneOf("MediaCategory", "MediaCategory"), oneOf("MediaType", "MediaType"), whole("Order"),
      text("ShortDescription"), { ...text("MediaURL"), derived: true }, moment("ModificationTimestamp"),
    ],
  },
  // The two resources that describe the feed itself. Their records are made from this file.
  {
    name: "Field",
    table: "Field",
    described: "fields",
    key: "FieldKey",
    fields: [text("FieldKey"), text("ResourceName"), text("FieldName"), text("DisplayName"), moment("ModificationTimestamp")],
  },
  {
    name: "Lookup",
    table: "Lookup",
    described: "lookups",
    key: "LookupKey",
    fields: [text("LookupKey"), text("LookupName"), text("LookupValue"), text("StandardLookupValue"), text("LegacyODataValue"), moment("ModificationTimestamp")],
  },
];

/**
 * Lookups whose values are a fixed list in OSMLS. Every one of these values is
 * a Data Dictionary standard value, and the Lookup resource says so.
 */
export const FIXED_LOOKUPS: Readonly<Record<string, readonly string[]>> = {
  StandardStatus: STANDARD_STATUSES,
  PropertyType: PROPERTY_TYPES,
  MemberStatus: MEMBER_STATUSES,
  OfficeStatus: OFFICE_STATUSES,
  // The feed's Media records are photos of listings and nothing else, so each of these has one value.
  ResourceName: ["Property"],
  MediaCategory: ["Photo"],
};

/** Postal abbreviations of the United States' states, district and territories, and Canada's provinces and territories. */
const STATES_AND_PROVINCES = (
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY " +
  "AS GU MP PR VI AB BC MB NB NL NS NT NU ON PE QC SK YT"
).split(" ");

/**
 * Lookups whose values OSMLS does not fix: whatever served records hold. The
 * Lookup resource lists the values found in served records only, so a value
 * that appears only on a record the feed leaves out is not listed.
 *
 * A found value is called a standard value only when it is on a list given
 * here. OSMLS accepts any two capital letters as a state, so a state is called
 * standard only if it is a real postal abbreviation; anything else is given as
 * a local value, never relabelled. Cities, counties and media types are not
 * checked against the Data Dictionary and are always given as local values.
 */
export const FOUND_LOOKUPS: Readonly<Record<string, { sources: readonly { resource: string; field: string }[]; standard?: readonly string[] }>> = {
  City: { sources: [{ resource: "Property", field: "City" }] },
  StateOrProvince: {
    sources: [
      { resource: "Property", field: "StateOrProvince" },
      { resource: "Office", field: "OfficeStateOrProvince" },
    ],
    standard: STATES_AND_PROVINCES,
  },
  CountyOrParish: { sources: [{ resource: "Property", field: "CountyOrParish" }] },
  MediaType: { sources: [{ resource: "Media", field: "MediaType" }] },
};

/** When the fixed descriptions of the feed (its fields, its fixed lookup values) last changed. Moved by hand with the allowlist. */
export const DESCRIPTION_CHANGED = "2026-11-20T00:00:00.000Z";

export const servedResource = (name: string): ServedResource | undefined => SERVED_RESOURCES.find((r) => r.name === name);

/** Records in a page when a request does not say, and the most it may ask for. */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
/** Requests one data consumer may make in a minute. */
export const MAX_REQUESTS_PER_MINUTE = 1200;

// ---- Feeds ----

/*
 * A feed is what one kind of data consumer may read. Each is written out here
 * as a narrowing of the allowlist above and can be nothing more: it names
 * fields that are on the allowlist, may add a condition on which records it
 * carries, and may give less than a stored value. Every data consumer reads
 * exactly one feed, fixed when the consumer is made.
 *
 * Like the allowlist, these are distribution policy, and the maintainer's to
 * set. A feed is not widened to satisfy a test.
 */

type FeedResource = {
  /** The served fields this feed carries, or every one of the resource's. */
  fields: "all" | readonly string[];
  /** A further fixed condition on which records the feed carries, added to the resource's own. */
  only?: string;
  /** For a field: what this feed gives in place of the stored column. */
  given?: Readonly<Record<string, string>>;
};

export type Feed = {
  label: string;
  /** What the feed is for, as staff are told when choosing one. */
  purpose: string;
  resources: Readonly<Record<string, FeedResource>>;
  /** For a fixed lookup: the values this feed can hold, when that is fewer than all of them. */
  lookups?: Readonly<Record<string, readonly string[]>>;
};

const DISPLAYED = `"StandardStatus" in (${sqlList(CLIENT_COPY_STATUSES)})`;
const onlyIfSold = (field: string) => `(case when "StandardStatus" = 'Closed' then "${field}" end)`;

export const FEEDS = {
  full: {
    label: "Full",
    purpose: "Everything on the allowlist, for listings in every status. For systems that work with the MLS's whole record.",
    resources: { Property: { fields: "all" }, Member: { fields: "all" }, Office: { fields: "all" }, Media: { fields: "all" }, Field: { fields: "all" }, Lookup: { fields: "all" } },
  },
  public: {
    label: "Public display",
    purpose:
      "Meant for showing listings to the public: listings that are Active, Active Under Contract, Pending or Closed, with the fields a client copy has. It is still read only with a token, and being in it does not by itself mean a consumer may publish a listing.",
    resources: {
      Property: {
        fields: [
          "ListingKey", "ListingId", "StandardStatus", "PropertyType", "ListPrice", "ClosePrice", "CloseDate", "UnparsedAddress", "City", "StateOrProvince", "PostalCode",
          "BedroomsTotal", "BathroomsTotalInteger", "LivingArea", "LotSizeAcres", "YearBuilt", "PublicRemarks", "ListAgentKey", "ListOfficeKey", "ModificationTimestamp",
        ],
        only: DISPLAYED,
        // As on a client copy: what a listing sold for, and when, only once it has sold.
        given: { ClosePrice: onlyIfSold("ClosePrice"), CloseDate: onlyIfSold("CloseDate") },
      },
      // Agents and offices that have a listing in this feed, by name.
      Member: {
        fields: ["MemberKey", "MemberFullName", "OfficeKey", "ModificationTimestamp"],
        only: `exists (select 1 from "Property" where "Property"."ListAgentKey" = "Member"."MemberKey" and ${DISPLAYED})`,
      },
      Office: {
        fields: ["OfficeKey", "OfficeName", "ModificationTimestamp"],
        only: `exists (select 1 from "Property" where "Property"."ListOfficeKey" = "Office"."OfficeKey" and ${DISPLAYED})`,
      },
      Media: {
        fields: "all",
        only: `exists (select 1 from "Property" where "Property"."ListingKey" = "Media"."ResourceRecordKey" and ${DISPLAYED})`,
      },
      Field: { fields: "all" },
      Lookup: { fields: "all" },
    },
    lookups: { StandardStatus: CLIENT_COPY_STATUSES },
  },
} as const satisfies Record<string, Feed>;

export type FeedName = keyof typeof FEEDS;
export const FEED_NAMES = Object.keys(FEEDS) as FeedName[];
export const isFeedName = (v: unknown): v is FeedName => typeof v === "string" && Object.hasOwn(FEEDS, v);

/** A feed's resources, each already narrowed: the only description of the feed the rest of the code reads. */
export type FeedView = {
  name: FeedName;
  resources: readonly ServedResource[];
  resource: (name: string) => ServedResource | undefined;
  /** The values of a fixed lookup as this feed can hold them. */
  fixedLookup: (name: string) => readonly string[] | undefined;
};

function narrowed(name: FeedName): FeedView {
  const feed: Feed = FEEDS[name];
  const resources = SERVED_RESOURCES.filter((r) => feed.resources[r.name]).map((r): ServedResource => {
    const chosen = feed.resources[r.name];
    const fields = r.fields
      .filter((f) => chosen.fields === "all" || chosen.fields.includes(f.name))
      .map((f) => (chosen.given?.[f.name] ? { ...f, given: chosen.given[f.name] } : f));
    // A feed may only narrow: a name that is not on the allowlist is a mistake in this file, not a wider feed.
    const unknown = chosen.fields === "all" ? [] : chosen.fields.filter((n) => !r.fields.some((f) => f.name === n));
    if (unknown.length > 0 || !fields.some((f) => f.name === r.key)) throw new Error(`The ${name} feed is not a narrowing of the allowlist for ${r.name}.`);
    const only = [r.only, chosen.only].filter(Boolean).map((c) => `(${c})`).join(" and ");
    return { ...r, fields, only: only || undefined, expand: r.expand && feed.resources[r.expand.resource] ? r.expand : undefined };
  });
  return {
    name,
    resources,
    resource: (wanted) => resources.find((r) => r.name === wanted),
    fixedLookup: (lookup) => feed.lookups?.[lookup] ?? FIXED_LOOKUPS[lookup],
  };
}

const VIEWS = Object.fromEntries(FEED_NAMES.map((name) => [name, narrowed(name)])) as Record<FeedName, FeedView>;
export const feedView = (name: FeedName): FeedView => VIEWS[name];
