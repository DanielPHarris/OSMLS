import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  primaryKey,
  uniqueIndex,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  DOCUMENT_PERMISSIONS,
  MEDIA_CATEGORIES,
  MEMBER_STATUSES,
  PROPERTY_TYPES,
  ROLES,
  STANDARD_STATUSES,
  sqlList,
} from "../lib/lookups";

/*
 * Tables and columns are named after the RESO Data Dictionary 2.1 resources and
 * fields (Property, Member, Office, Media, HistoryTransactional).
 * Columns that are not in the Data Dictionary start with "Osmls".
 * The lower-case tables at the bottom belong to the sign-in library.
 */

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

export const office = pgTable("Office", {
  OfficeKey: uuid().primaryKey().defaultRandom(),
  OfficeMlsId: text().notNull().unique(),
  OfficeName: text().notNull(),
  // Null for a brokerage's main office; otherwise points at it.
  MainOfficeKey: uuid(),
  OfficeStatus: text().notNull().default("Active"),
  OfficePhone: text(),
  OfficeCity: text(),
  OfficeStateOrProvince: text(),
  ModificationTimestamp: timestamptz().notNull().defaultNow(),
});

export const member = pgTable(
  "Member",
  {
    MemberKey: uuid().primaryKey().defaultRandom(),
    MemberMlsId: text().notNull().unique(),
    MemberFirstName: text().notNull(),
    MemberLastName: text().notNull(),
    MemberFullName: text().notNull(),
    MemberEmail: text().notNull().unique(),
    MemberDirectPhone: text(),
    MemberStatus: text().notNull().default("Active"),
    // Null for MLS staff.
    OfficeKey: uuid().references(() => office.OfficeKey),
    OsmlsRole: text().notNull(),
    OsmlsUserId: text()
      .notNull()
      .unique()
      .references(() => user.id),
    ModificationTimestamp: timestamptz().notNull().defaultNow(),
  },
  () => [
    check("Member_MemberStatus_valid", sql.raw(`"MemberStatus" IN (${sqlList(MEMBER_STATUSES)})`)),
    check("Member_OsmlsRole_valid", sql.raw(`"OsmlsRole" IN (${sqlList(ROLES)})`)),
  ],
);

export const listingIdSeq = pgSequence("listing_id_seq", { startWith: 1000001 });

export const property = pgTable(
  "Property",
  {
    ListingKey: uuid().primaryKey().defaultRandom(),
    // The MLS number shown to users.
    ListingId: text()
      .notNull()
      .unique()
      .default(sql`'OS' || nextval('listing_id_seq')::text`),
    StandardStatus: text().notNull(),
    PropertyType: text().notNull(),

    ListPrice: numeric({ precision: 14, scale: 2, mode: "number" }).notNull(),
    OriginalListPrice: numeric({ precision: 14, scale: 2, mode: "number" }).notNull(),
    ClosePrice: numeric({ precision: 14, scale: 2, mode: "number" }),
    CloseDate: date({ mode: "string" }),
    ListingContractDate: date({ mode: "string" }).notNull(),
    OnMarketDate: date({ mode: "string" }),

    StreetNumber: text().notNull(),
    StreetName: text().notNull(),
    UnitNumber: text(),
    City: text().notNull(),
    StateOrProvince: text().notNull(),
    PostalCode: text().notNull(),
    UnparsedAddress: text().notNull(),
    // With the state, the jurisdiction that issued the parcel number.
    CountyOrParish: text(),
    // Unique only within its county and state. Used to recognise a relisting.
    ParcelNumber: text(),
    // Where the pin sits on the map. Both are set, or neither.
    Latitude: numeric({ precision: 9, scale: 6, mode: "number" }),
    Longitude: numeric({ precision: 9, scale: 6, mode: "number" }),

    BedroomsTotal: integer().notNull(),
    BathroomsTotalInteger: integer().notNull(),
    LivingArea: integer(),
    LotSizeAcres: numeric({ precision: 10, scale: 3, mode: "number" }),
    YearBuilt: integer(),
    PublicRemarks: text(),

    // How the property is shown. Restricted: see src/lib/access.ts.
    ShowingInstructions: text(),
    ShowingRequirements: text().array().notNull().default(sql`'{}'::text[]`),
    ShowingContactName: text(),
    ShowingContactPhone: text(),
    ShowingContactType: text().array().notNull().default(sql`'{}'::text[]`),
    LockBoxType: text().array().notNull().default(sql`'{}'::text[]`),
    LockBoxLocation: text(),

    ListAgentKey: uuid()
      .notNull()
      .references(() => member.MemberKey),
    ListOfficeKey: uuid()
      .notNull()
      .references(() => office.OfficeKey),

    // Fields a local MLS adds beyond the core set. Not used by 0.1 screens.
    OsmlsLocalFields: jsonb().notNull().default({}),

    OriginalEntryTimestamp: timestamptz().notNull().defaultNow(),
    ModificationTimestamp: timestamptz().notNull().defaultNow(),
    StatusChangeTimestamp: timestamptz().notNull().defaultNow(),
    PriceChangeTimestamp: timestamptz(),
  },
  (t) => [
    check(
      "Property_StandardStatus_valid",
      sql.raw(`"StandardStatus" IN (${sqlList(STANDARD_STATUSES)})`),
    ),
    check("Property_PropertyType_valid", sql.raw(`"PropertyType" IN (${sqlList(PROPERTY_TYPES)})`)),
    check("Property_ListPrice_positive", sql`${t.ListPrice} > 0`),
    check("Property_BedroomsTotal_nonnegative", sql`${t.BedroomsTotal} >= 0`),
    check("Property_BathroomsTotalInteger_nonnegative", sql`${t.BathroomsTotalInteger} >= 0`),
    check(
      "Property_Closed_has_price_and_date",
      sql`${t.StandardStatus} <> 'Closed' OR (${t.ClosePrice} IS NOT NULL AND ${t.CloseDate} IS NOT NULL)`,
    ),
    check("Property_Latitude_range", sql`${t.Latitude} BETWEEN -90 AND 90`),
    check("Property_Longitude_range", sql`${t.Longitude} BETWEEN -180 AND 180`),
    check(
      "Property_location_both_or_neither",
      sql`(${t.Latitude} IS NULL) = (${t.Longitude} IS NULL)`,
    ),
    index("Property_location_idx").on(t.Latitude, t.Longitude),
    index("Property_ParcelNumber_idx").on(t.ParcelNumber),
    index("Property_CloseDate_idx").on(t.CloseDate),
    index("Property_StandardStatus_idx").on(t.StandardStatus),
    index("Property_City_idx").on(t.City),
    index("Property_PostalCode_idx").on(t.PostalCode),
    index("Property_ListPrice_idx").on(t.ListPrice),
    index("Property_ListAgentKey_idx").on(t.ListAgentKey),
  ],
);

export const media = pgTable(
  "Media",
  {
    MediaKey: uuid().primaryKey().defaultRandom(),
    ResourceName: text().notNull().default("Property"),
    ResourceRecordKey: uuid()
      .notNull()
      .references(() => property.ListingKey),
    MediaCategory: text().notNull().default("Photo"),
    // MIME type, for example image/jpeg.
    MediaType: text().notNull(),
    Order: integer().notNull(),
    // For a document, the name people see.
    ShortDescription: text(),
    // Who may see a document. Photos have none: every active member sees them.
    Permission: text(),
    // File name inside MEDIA_DIR (photos) or its documents folder.
    OsmlsStoragePath: text().notNull(),
    OsmlsFileSize: integer(),
    // SHA-256 of the stored file, as hexadecimal.
    OsmlsFileHash: text(),
    ModificationTimestamp: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check("Media_MediaCategory_valid", sql.raw(`"MediaCategory" IN (${sqlList(MEDIA_CATEGORIES)})`)),
    check("Media_Permission_valid", sql.raw(`"Permission" IN (${sqlList(DOCUMENT_PERMISSIONS)})`)),
    // A document always has a permission and a name; nothing is visible by omission.
    // Each column is tested for NULL by name: a CHECK passes when its result is unknown.
    check(
      "Media_document_is_complete",
      sql`${t.MediaCategory} <> 'Document' OR (${t.Permission} IS NOT NULL AND ${t.ShortDescription} IS NOT NULL AND length(trim(${t.ShortDescription})) > 0 AND ${t.OsmlsFileHash} IS NOT NULL AND ${t.OsmlsFileSize} IS NOT NULL)`,
    ),
    index("Media_ResourceRecordKey_idx").on(t.ResourceRecordKey),
  ],
);

/*
 * One row per changed field. Rows are written in the same transaction as the
 * change they describe and can never be updated or deleted (see the trigger in
 * the migrations folder).
 */
export const historyTransactional = pgTable(
  "HistoryTransactional",
  {
    HistoryTransactionalKey: uuid().primaryKey().defaultRandom(),
    ResourceName: text().notNull().default("Property"),
    ResourceRecordKey: uuid().notNull(),
    ResourceRecordID: text().notNull(),
    ClassName: text().notNull(),
    FieldName: text().notNull(),
    PreviousValue: text(),
    NewValue: text(),
    ChangeType: text(),
    ChangedByMemberKey: uuid()
      .notNull()
      .references(() => member.MemberKey),
    ChangedByMemberID: text().notNull(),
    ModificationTimestamp: timestamptz().notNull().defaultNow(),
    // The order rows were committed in: a trigger hands the numbers out one
    // transaction at a time (migration 0008). Settles the order of changes that
    // share a timestamp, which the market-time calculation depends on, and lets
    // "everything up to number N" be a safe checkpoint for saved-search activity.
    OsmlsSequence: bigserial({ mode: "number" }).notNull(),
    // True when MLS staff, rather than the listing agent, made the change.
    OsmlsStaffCorrection: boolean().notNull().default(false),
    OsmlsCorrectionReason: text(),
  },
  (t) => [
    check(
      "HistoryTransactional_correction_has_reason",
      sql`NOT ${t.OsmlsStaffCorrection} OR length(trim(${t.OsmlsCorrectionReason})) > 0`,
    ),
    index("HistoryTransactional_record_idx").on(t.ResourceRecordKey, t.ModificationTimestamp),
    index("HistoryTransactional_sequence_idx").on(t.OsmlsSequence),
  ],
);

/*
 * Saved work: a member's own saved searches and collections of listings.
 * Private to the member who made them; see canUseSavedSearch and
 * canUseCollection in src/lib/access.ts. Neither holds a copy of any listing.
 */

// Named after the Data Dictionary's SavedSearch resource. The criteria are kept in
// OSMLS's own form, not as a $filter or DMQL2 query, so SearchQuery is not used.
export const savedSearch = pgTable(
  "SavedSearch",
  {
    SavedSearchKey: uuid().primaryKey().defaultRandom(),
    MemberKey: uuid()
      .notNull()
      .references(() => member.MemberKey),
    SavedSearchName: text().notNull(),
    ResourceName: text().notNull().default("Property"),
    // The criteria, as src/lib/search-criteria.ts defines them.
    OsmlsCriteria: jsonb().notNull(),
    SearchQueryHumanReadable: text().notNull(),
    // The activity checkpoint: history up to and including this sequence number
    // is behind the member. Set when the search is saved, when its criteria
    // change, and when the member marks activity as seen. See src/lib/activity.ts.
    OsmlsActivitySeenThrough: bigint({ mode: "number" }).notNull().default(0),
    // When that checkpoint was last set.
    OsmlsActivitySeenAt: timestamptz().notNull().defaultNow(),
    // Scheduled email alerts to the owner. See src/lib/alerts.ts.
    // Null means off.
    OsmlsAlertFrequency: text(),
    // The email checkpoint, separate from the one above: history up to here has
    // been emailed, or was behind the member when alerts were switched on.
    OsmlsAlertSentThrough: bigint({ mode: "number" }).notNull().default(0),
    // When the last alert was accepted, or when alerts were switched on or the
    // criteria changed. The next alert is not due until one period after this.
    OsmlsAlertLastSentAt: timestamptz(),
    // Sends started for the pending activity whose outcome is not known.
    OsmlsAlertAttempts: integer().notNull().default(0),
    // Sends in a row that the mail server definitely did not take.
    OsmlsAlertFailures: integer().notNull().default(0),
    // Why sending has stopped until the member resumes it, if it has.
    OsmlsAlertPaused: text(),
    // Goes up whenever the member changes the alert or the criteria, so a send
    // that began before the change cannot write over what the change set.
    OsmlsAlertGeneration: integer().notNull().default(0),
    OriginalEntryTimestamp: timestamptz().notNull().defaultNow(),
    ModificationTimestamp: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check("SavedSearch_alert_frequency_valid", sql`${t.OsmlsAlertFrequency} IS NULL OR ${t.OsmlsAlertFrequency} IN ('daily', 'weekly')`),
    check("SavedSearch_alert_paused_valid", sql`${t.OsmlsAlertPaused} IS NULL OR ${t.OsmlsAlertPaused} IN ('failed', 'uncertain')`),
    check("SavedSearch_name_not_blank", sql`${t.SavedSearchName} IS NOT NULL AND length(trim(${t.SavedSearchName})) > 0`),
    // A member cannot have two with the same name, whatever the capitalisation.
    uniqueIndex("SavedSearch_member_name_unique").on(t.MemberKey, sql`lower(${t.SavedSearchName})`),
  ],
);

export const collection = pgTable(
  "OsmlsCollection",
  {
    CollectionKey: uuid().primaryKey().defaultRandom(),
    MemberKey: uuid()
      .notNull()
      .references(() => member.MemberKey),
    CollectionName: text().notNull(),
    OriginalEntryTimestamp: timestamptz().notNull().defaultNow(),
    ModificationTimestamp: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check("OsmlsCollection_name_not_blank", sql`${t.CollectionName} IS NOT NULL AND length(trim(${t.CollectionName})) > 0`),
    uniqueIndex("OsmlsCollection_member_name_unique").on(t.MemberKey, sql`lower(${t.CollectionName})`),
  ],
);

export const collectionListing = pgTable(
  "OsmlsCollectionListing",
  {
    CollectionKey: uuid()
      .notNull()
      .references(() => collection.CollectionKey, { onDelete: "cascade" }),
    ListingKey: uuid()
      .notNull()
      .references(() => property.ListingKey),
    AddedTimestamp: timestamptz().notNull().defaultNow(),
    // Order of adding, for listings added in the same instant.
    AddedSequence: bigserial({ mode: "number" }).notNull(),
  },
  // A listing is in a collection once or not at all.
  (t) => [primaryKey({ columns: [t.CollectionKey, t.ListingKey] })],
);

// ---- Sign-in library tables (Better Auth core schema) ----

/*
 * A link a member gives a client. It holds no listing data: the page it opens is
 * built fresh through the client boundary (src/lib/rules/client-copy.ts) each
 * time. Only a hash of the link's secret is kept, so the link itself cannot be
 * read back from the database. See src/lib/shares.ts.
 */
export const share = pgTable(
  "OsmlsShare",
  {
    ShareKey: uuid().primaryKey().defaultRandom(),
    MemberKey: uuid()
      .notNull()
      .references(() => member.MemberKey),
    OsmlsTokenHash: text().notNull().unique(),
    // Exactly one of these: the listing or the collection the link shows.
    ListingKey: uuid().references(() => property.ListingKey),
    CollectionKey: uuid().references(() => collection.CollectionKey, { onDelete: "cascade" }),
    ExpirationTimestamp: timestamptz().notNull(),
    OsmlsRevokedTimestamp: timestamptz(),
    // Set only when the link was sent by email. The address is deleted when the
    // link is revoked, when it expires, or when the recipient asks for no more
    // email. Its keyed hash stays with the row so that request can still be met.
    OsmlsRecipientEmail: text(),
    OsmlsRecipientHash: text(),
    OsmlsSentTimestamp: timestamptz(),
    OriginalEntryTimestamp: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check("OsmlsShare_one_target", sql`(${t.ListingKey} IS NULL) <> (${t.CollectionKey} IS NULL)`),
    index("OsmlsShare_member_idx").on(t.MemberKey),
    index("OsmlsShare_recipient_idx").on(t.OsmlsRecipientHash),
  ],
);

// Addresses that asked for no more email, kept only as keyed hashes.
export const mailBlock = pgTable("OsmlsMailBlock", {
  OsmlsAddressHash: text().primaryKey(),
  OriginalEntryTimestamp: timestamptz().notNull().defaultNow(),
});

export const user = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text().primaryKey(),
  expiresAt: timestamp().notNull(),
  token: text().notNull().unique(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
  ipAddress: text(),
  userAgent: text(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: timestamp(),
  refreshTokenExpiresAt: timestamp(),
  scope: text(),
  password: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});

export type Office = typeof office.$inferSelect;
export type Member = typeof member.$inferSelect;
export type Property = typeof property.$inferSelect;
export type Media = typeof media.$inferSelect;
export type HistoryRow = typeof historyTransactional.$inferSelect;
export type SavedSearch = typeof savedSearch.$inferSelect;
export type Collection = typeof collection.$inferSelect;
export type Share = typeof share.$inferSelect;
