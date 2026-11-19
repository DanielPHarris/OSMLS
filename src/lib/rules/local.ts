/*
 * Local formats and limits. The defaults suit a United States MLS; an MLS
 * elsewhere would change them here.
 */
export const STATE_OR_PROVINCE_PATTERN = /^[A-Z]{2}$/;
export const POSTAL_CODE_PATTERN = /^\d{5}(-\d{4})?$/;
export const EARLIEST_YEAR_BUILT = 1600;
export const MAX_PHOTOS_PER_LISTING = 30;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_LISTING = 25;
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_SEARCH_RESULTS = 100;
// A member's saved work.
export const MAX_SAVED_SEARCHES_PER_MEMBER = 50;
export const MAX_COLLECTIONS_PER_MEMBER = 50;
export const MAX_LISTINGS_PER_COLLECTION = 200;
export const MAX_SAVED_NAME_LENGTH = 80;
// Saved-search activity. A page that leaves anything out says so.
export const MAX_ACTIVITY_LISTINGS = 100;
export const MAX_ACTIVITY_EVENTS_PER_LISTING = 10;
// Printable reports. A report that is cut short by either limit says so.
export const MAX_LISTINGS_PER_REPORT = 50;
export const MAX_PHOTOS_PER_REPORT = 6;
/** Where maps open when there is nothing else to centre on. The demo's invented towns sit here. */
export const DEFAULT_MAP_VIEW = { longitude: -122.26, latitude: 47.31, zoom: 10 };
/** Used when MAP_STYLE_URL is not set. Any MapLibre-compatible style URL works. */
export const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
// Links shared with clients. Every link expires; there is no permanent one.
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export const DEFAULT_SHARE_EXPIRY_DAYS = 30;
export const MAX_SHARE_NOTE_LENGTH = 500;
export const MAX_ACTIVE_SHARES_PER_MEMBER = 50;
export const MAX_SHARE_EMAILS_PER_DAY = 50;
// An ended link's record, with the keyed hash of its recipient, is deleted this long after it ended.
export const SHARE_RECORD_RETENTION_DAYS = 30;
// Scheduled email alerts. An alert pauses after this many sends in a row that
// the mail server refused, or this many whose outcome is not known.
export const MAX_ALERT_FAILURES = 5;
export const MAX_UNCERTAIN_ALERT_SENDS = 3;
