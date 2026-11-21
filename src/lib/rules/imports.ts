/*
 * The columns an import file may have. Each is named exactly as the Data
 * Dictionary field it fills; there is no other mapping. The listing columns
 * are the fields of the listing entry form, and a test fails if the two lists
 * ever differ.
 */
export const LISTING_COLUMNS = [
  "StandardStatus", "PropertyType", "ListPrice", "ListingContractDate", "StreetNumber", "StreetName", "UnitNumber", "City", "CountyOrParish", "ParcelNumber",
  "StateOrProvince", "PostalCode", "BedroomsTotal", "BathroomsTotalInteger", "LivingArea", "LotSizeAcres", "YearBuilt", "PublicRemarks",
  "ShowingInstructions", "ShowingRequirements", "ShowingContactName", "ShowingContactPhone", "ShowingContactType", "LockBoxType", "LockBoxLocation",
  "Latitude", "Longitude", "ClosePrice", "CloseDate",
] as const;

/** The listing agent, by member ID, and the listing's identifier in the system it came from. */
export const IMPORT_ONLY_COLUMNS = ["ListAgentMlsId", "SourceListingId"] as const;
export const IMPORT_COLUMNS = [...LISTING_COLUMNS, ...IMPORT_ONLY_COLUMNS] as const;

/** A file without one of these is refused whole. The rest may be left out, as they may be left blank on the form. */
export const REQUIRED_IMPORT_COLUMNS = [
  "StandardStatus", "PropertyType", "ListPrice", "ListingContractDate", "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode",
  "BedroomsTotal", "BathroomsTotalInteger", "ListAgentMlsId", "SourceListingId",
] as const;

export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** How long a preview that is not committed is kept. */
export const IMPORT_PREVIEW_HOURS = 24;
