import { isReady, readiness } from "@/lib/operations";

/*
 * Ready: the application can serve. Open without sign-in, for a monitor to
 * call, so it says only ok or not ok and never which check failed. Staff see
 * the checks on the status screen.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const ok = isReady(await readiness());
  return Response.json({ status: ok ? "ok" : "not ok" }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
