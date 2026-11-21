import { parseExportKind, recordExport, searchExport, toCsv } from "@/lib/exports";
import { criteriaFromParams } from "@/lib/search-criteria";
import { getCurrentMember } from "@/lib/session";

/*
 * The exported file itself. It is made here, when it is asked for, from the
 * search as this member would run it now, and the download is recorded before
 * the file is sent.
 */
export async function GET(request: Request) {
  const current = await getCurrentMember();
  // Signed out, or suspended: there is nothing here.
  if (!current) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const url = new URL(request.url);
  const kind = parseExportKind(url.searchParams.get("kind"));
  if (!kind) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const params: Record<string, string | string[]> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    params[name] = values.length > 1 ? values : values[0];
  }
  const criteria = criteriaFromParams(params);
  const file = await searchExport(current, criteria, kind);
  if (!file) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  await recordExport(current, criteria, file);
  return new Response(toCsv(file), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
