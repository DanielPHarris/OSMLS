/*
 * Small checks used wherever a value arrives from outside: a form, a page
 * address, or something stored earlier.
 */

/**
 * Whether a string is a real calendar date written YYYY-MM-DD.
 *
 * The shape and Date.parse are not enough: JavaScript rolls "2026-02-31" over
 * into March and calls it valid, and the database then refuses it. The date is
 * built and compared with what was asked for.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Whether a string is one of an object's own keys.
 *
 * "in" is not enough: it also finds what every object inherits, so "constructor"
 * and "toString" would pass as members of any set of options.
 */
export function isOwnKey<T extends object>(options: T, value: unknown): value is keyof T & string {
  return typeof value === "string" && Object.hasOwn(options, value);
}
