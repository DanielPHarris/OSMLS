import { readFile } from "node:fs/promises";
import path from "node:path";
import { consumerFor, logRequest, servedPhoto } from "@/lib/data-exchange";
import { mediaDir } from "@/lib/listings";

/*
 * A listing photo, for a data consumer holding a bearer token. The feed's
 * MediaURL points here. Only photos are served: a document's key, any other
 * key, and no key at all are answered alike.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const consumer = await consumerFor(request.headers.get("authorization"));
  if (!consumer) return new Response("A valid bearer token is required.", { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } });
  const { key } = await params;
  const photo = await servedPhoto(key);
  const missing = async () => {
    await logRequest(consumer, "photo", key.slice(0, 100), 404, 0);
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  };
  if (!photo) return missing();
  try {
    const bytes = await readFile(path.join(mediaDir(), path.basename(photo.OsmlsStoragePath)));
    await logRequest(consumer, "photo", key, 200, 1);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": photo.MediaType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return missing();
  }
}
