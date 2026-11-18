const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
// History is an audit record, so times always say which zone they are in.
const dateTime = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const dateOnly = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export const formatMoney = (n: number | null | undefined) => (n == null ? "—" : money.format(n));
export const formatDateTime = (d: Date) => dateTime.format(d);
export const formatDate = (iso: string | null | undefined) => (iso ? dateOnly.format(new Date(`${iso}T00:00:00Z`)) : "—");

const MONEY_FIELDS = new Set(["ListPrice", "ClosePrice"]);
/** Show a stored history value the way a person would write it. */
export function formatHistoryValue(field: string, value: string | null): string {
  if (value == null || value === "") return "—";
  if (MONEY_FIELDS.has(field)) return formatMoney(Number(value));
  return value;
}

/** "ListPrice" -> "List Price" */
export const fieldLabel = (field: string) => field.replace(/([a-z])([A-Z])/g, "$1 $2");
