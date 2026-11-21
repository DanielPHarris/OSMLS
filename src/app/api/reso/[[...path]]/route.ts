import { admitRequest, consumerFor, feedOf, finishRequest, metadataDocument, readResource, serviceDocument } from "@/lib/data-exchange";
import { ODataError, preferredPageSize } from "@/lib/odata";

/*
 * The data exchange feed: a read-only RESO Web API (OData) service for outside
 * systems holding a bearer token. Member sessions do not open it. What it
 * serves is decided in src/lib/data-exchange.ts from the export allowlist.
 */

const COMMON = { "OData-Version": "4.0", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...COMMON, "Content-Type": "application/json;odata.metadata=minimal;charset=utf-8" } });
const failure = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...COMMON, "Content-Type": "application/json;charset=utf-8", ...extra } });

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const consumer = await consumerFor(request.headers.get("authorization"));
  // Unknown, revoked and expired tokens are answered alike, and before anything about the request is looked at.
  if (!consumer) return failure(401, "Unauthorized", "A valid bearer token is required.", { "WWW-Authenticate": "Bearer" });

  // Everything below answers for this consumer's feed and for no other.
  const view = feedOf(consumer);
  const url = new URL(request.url);
  const path = ((await params).path ?? []).map((part) => decodeURIComponent(part));
  const query = url.search.slice(1);
  const asked = path.join("/") || "(service document)";
  // One of the consumer's requests for this minute is taken here, in one step with counting them.
  const admitted = await admitRequest(consumer, asked.replace(/[\u0000-\u001f\u007f]/g, "?"), query);
  if (admitted === "refused") return failure(401, "Unauthorized", "A valid bearer token is required.", { "WWW-Authenticate": "Bearer" });
  if (admitted === "limit") return failure(429, "TooManyRequests", "Too many requests in the last minute. Try again shortly.", { "Retry-After": "60" });
  const done = (status: number, records: number) => finishRequest(admitted, status, records);
  try {
    if (path.length === 0) {
      await done(200, 0);
      return json(serviceDocument(view));
    }
    if (path.length === 1 && path[0] === "$metadata") {
      await done(200, 0);
      return new Response(metadataDocument(view), { headers: { ...COMMON, "Content-Type": "application/xml;charset=utf-8" } });
    }
    if (path.length !== 1) throw new ODataError(`There is nothing at "${asked}".`, 404, "NotFound");
    // "Property" for a collection, "Property('key')" for one record.
    const one = /^([A-Za-z]+)\('([^']*)'\)$/.exec(path[0]);
    const maxPageSize = preferredPageSize(request.headers.get("prefer"));
    const result = one ? await readResource(view, one[1], url.searchParams, one[2]) : await readResource(view, path[0], url.searchParams, undefined, { maxPageSize });
    if ("value" in result && Array.isArray(result.value)) {
      const page = result as import("@/lib/data-exchange").Page;
      await done(200, page.value.length);
      return json({
        "@odata.context": page.context,
        ...(page.count === undefined ? {} : { "@odata.count": page.count }),
        value: page.value,
        ...(page.nextLink ? { "@odata.nextLink": page.nextLink } : {}),
      });
    }
    await done(200, 1);
    return json(result);
  } catch (err) {
    if (!(err instanceof ODataError)) throw err;
    await done(err.status, 0);
    return failure(err.status, err.code, err.message);
  }
}
