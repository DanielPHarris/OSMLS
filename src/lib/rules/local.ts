/*
 * Local formats and limits. The defaults suit a United States MLS; an MLS
 * elsewhere would change them here.
 */
export const STATE_OR_PROVINCE_PATTERN = /^[A-Z]{2}$/;
export const POSTAL_CODE_PATTERN = /^\d{5}(-\d{4})?$/;
export const EARLIEST_YEAR_BUILT = 1600;
export const MAX_PHOTOS_PER_LISTING = 30;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_SEARCH_RESULTS = 100;
