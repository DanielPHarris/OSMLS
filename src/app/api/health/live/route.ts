/*
 * Alive: the application process answers. It checks nothing else, so that a
 * database outage is not mistaken for a dead process.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
