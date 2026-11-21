import type { EdmType, ServedField, ServedResource } from "./rules/data-exchange";
import { isCalendarDate } from "./validation";

/*
 * Reading the query options of an OData request against the export allowlist.
 * Nothing here touches the database: a query is turned into a checked
 * structure, or refused. A field that is not on the allowlist for the resource
 * does not exist as far as any option is concerned, and naming one is an error.
 */

/** A request that cannot be answered as asked. `status` is the HTTP status to give. */
export class ODataError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "BadRequest",
  ) {
    super(message);
  }
}

/** Text the database can hold: no control characters, and not absurdly long. */
export const isPlainText = (v: string) => v.length <= 500 && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * Whether a date and time in ISO form is a real one. The shape and Date.parse
 * are not enough: JavaScript rolls "2026-02-31T00:00:00Z" over into March and
 * calls it valid, and the database refuses it.
 */
export const isRealMoment = (v: string) => isCalendarDate(v.slice(0, 10)) && !Number.isNaN(Date.parse(v));

export type Comparison = "eq" | "ne" | "gt" | "ge" | "lt" | "le";
export type Literal = { kind: "null" } | { kind: "string"; value: string } | { kind: "number"; value: number } | { kind: "date"; value: string } | { kind: "moment"; value: string };
export type Filter =
  | { op: "and" | "or"; left: Filter; right: Filter }
  | { op: "not"; operand: Filter }
  | { op: Comparison; field: ServedField; value: Literal };

export type Order = { field: ServedField; descending: boolean };

const field = (resource: ServedResource, name: string, use: string): ServedField => {
  const found = resource.fields.find((f) => f.name === name);
  if (!found) throw new ODataError(`${resource.name} has no field "${name}" (in ${use}).`);
  return found;
};
const stored = (resource: ServedResource, name: string, use: string): ServedField => {
  const found = field(resource, name, use);
  if (found.derived && !found.queryable) throw new ODataError(`"${name}" is worked out when a response is made and cannot be used in ${use}.`);
  return found;
};

/** The fields a request asked for, or every served field when it did not say. */
export function parseSelect(resource: ServedResource, value: string | null): ServedField[] {
  if (value == null || value.trim() === "" || value.trim() === "*") return [...resource.fields];
  const names = value.split(",").map((n) => n.trim());
  if (names.some((n) => n === "")) throw new ODataError("$select has an empty field name.");
  return [...new Set(names)].map((n) => field(resource, n, "$select"));
}

export function parseOrderBy(resource: ServedResource, value: string | null): Order[] {
  if (value == null || value.trim() === "") return [];
  return value.split(",").map((part) => {
    const [name, direction, ...rest] = part.trim().split(/\s+/);
    if (!name || rest.length > 0 || (direction !== undefined && direction !== "asc" && direction !== "desc")) {
      throw new ODataError(`$orderby cannot be read at "${part.trim()}".`);
    }
    return { field: stored(resource, name, "$orderby"), descending: direction === "desc" };
  });
}

/** The resources to read along with each record. Only what the allowlist names for this resource can be expanded. */
export function parseExpand(resource: ServedResource, value: string | null): NonNullable<ServedResource["expand"]>[] {
  if (value == null || value.trim() === "") return [];
  return [...new Set(value.split(",").map((n) => n.trim()))].map((name) => {
    if (!resource.expand || resource.expand.name !== name) throw new ODataError(`${resource.name} has nothing called "${name}" to expand.`);
    return resource.expand;
  });
}

/** The page size a request asks the server not to exceed, from its Prefer header, or null. */
export function preferredPageSize(prefer: string | null): number | null {
  const match = /(?:^|[,;\s])odata\.maxpagesize=(\d{1,6})(?:$|[,;\s])/i.exec(prefer ?? "");
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

/** A whole number at least `least`, or the fallback when the option was not given. */
export function parseCount(name: string, value: string | null, fallback: number, least = 0): number {
  if (value == null) return fallback;
  if (!/^\d{1,9}$/.test(value.trim()) || Number(value) < least) throw new ODataError(`${name} must be a whole number of ${least} or more.`);
  return Number(value);
}

type Token = { kind: "word" | "string" | "number" | "date" | "moment" | "open" | "close"; text: string };

function tokens(input: string): Token[] {
  const out: Token[] = [];
  const pattern =
    /\s*(?:(\()|(\))|'((?:[^']|'')*)'|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))|(\d{4}-\d{2}-\d{2})|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*(?:\(\))?))/y;
  let at = 0;
  while (at < input.length) {
    if (/^\s*$/.test(input.slice(at))) break;
    pattern.lastIndex = at;
    const m = pattern.exec(input);
    if (!m) throw new ODataError(`$filter cannot be read at "${input.slice(at, at + 20).trim()}".`);
    at = pattern.lastIndex;
    if (m[1]) out.push({ kind: "open", text: "(" });
    else if (m[2]) out.push({ kind: "close", text: ")" });
    else if (m[3] !== undefined) out.push({ kind: "string", text: m[3].replace(/''/g, "'") });
    else if (m[4]) out.push({ kind: "moment", text: m[4] });
    else if (m[5]) out.push({ kind: "date", text: m[5] });
    else if (m[6]) out.push({ kind: "number", text: m[6] });
    else out.push({ kind: "word", text: m[7] });
  }
  return out;
}

const COMPARISONS: readonly string[] = ["eq", "ne", "gt", "ge", "lt", "le"];
// Far more than any real filter; stops a request built to exhaust the parser.
const MAX_FILTER_TERMS = 50;

const accepts: Record<EdmType, Literal["kind"][]> = {
  "Edm.String": ["string"],
  "Edm.Int32": ["number"],
  "Edm.Decimal": ["number"],
  "Edm.Date": ["date"],
  "Edm.DateTimeOffset": ["moment"],
};

/**
 * Reads a $filter: comparisons of a served field with a literal, joined by
 * and, or, not, and parentheses. `now` is what now() means for this request.
 */
export function parseFilter(resource: ServedResource, value: string | null, now: Date = new Date()): Filter | null {
  if (value == null || value.trim() === "") return null;
  const list = tokens(value);
  let at = 0;
  let terms = 0;
  const peek = () => list[at];
  const isWord = (text: string) => peek()?.kind === "word" && peek().text === text;

  const literal = (): Literal => {
    const t = list[at++];
    if (!t) throw new ODataError("$filter ends where a value was expected.");
    // Every value is checked here to be one the database will accept, so that a
    // value it would refuse is answered as a bad query and never reaches it.
    if (t.kind === "string") {
      if (!isPlainText(t.text)) throw new ODataError("$filter has text that is too long or holds control characters.");
      return { kind: "string", value: t.text };
    }
    if (t.kind === "number") {
      if (t.text.length > 30 || !Number.isFinite(Number(t.text))) throw new ODataError(`"${t.text.slice(0, 40)}" is not a number this service can compare.`);
      return { kind: "number", value: Number(t.text) };
    }
    if (t.kind === "date") {
      if (!isCalendarDate(t.text)) throw new ODataError(`"${t.text}" is not a calendar date.`);
      return { kind: "date", value: t.text };
    }
    if (t.kind === "moment") {
      if (!isRealMoment(t.text)) throw new ODataError(`"${t.text}" is not a date and time.`);
      return { kind: "moment", value: new Date(t.text).toISOString() };
    }
    if (t.kind === "word" && t.text === "null") return { kind: "null" };
    if (t.kind === "word" && t.text === "now()") return { kind: "moment", value: now.toISOString() };
    throw new ODataError(`$filter has "${t.text}" where a value was expected.`);
  };

  const comparison = (): Filter => {
    if (++terms > MAX_FILTER_TERMS) throw new ODataError("$filter has too many terms.", 413, "RequestEntityTooLarge");
    const t = list[at++];
    if (!t) throw new ODataError("$filter ends where a field was expected.");
    if (t.kind === "open") {
      const inner = either();
      if (list[at++]?.kind !== "close") throw new ODataError("$filter has an unclosed parenthesis.");
      return inner;
    }
    if (t.kind !== "word") throw new ODataError(`$filter has "${t.text}" where a field was expected.`);
    const of = stored(resource, t.text, "$filter");
    const op = list[at++];
    if (!op || op.kind !== "word" || !COMPARISONS.includes(op.text)) throw new ODataError(`$filter needs eq, ne, gt, ge, lt or le after "${of.name}".`);
    const against = literal();
    if (against.kind === "null") {
      if (op.text !== "eq" && op.text !== "ne") throw new ODataError(`"${of.name}" can only be compared with null using eq or ne.`);
    } else if (!accepts[of.type].includes(against.kind)) {
      throw new ODataError(`"${of.name}" is ${of.type} and cannot be compared with that value.`);
    }
    return { op: op.text as Comparison, field: of, value: against };
  };
  const negation = (): Filter => {
    if (isWord("not")) {
      at++;
      return { op: "not", operand: negation() };
    }
    return comparison();
  };
  const both = (): Filter => {
    let left = negation();
    while (isWord("and")) {
      at++;
      left = { op: "and", left, right: negation() };
    }
    return left;
  };
  const either = (): Filter => {
    let left = both();
    while (isWord("or")) {
      at++;
      left = { op: "or", left, right: both() };
    }
    return left;
  };

  const parsed = either();
  if (at < list.length) throw new ODataError(`$filter cannot be read at "${list[at].text}".`);
  return parsed;
}
