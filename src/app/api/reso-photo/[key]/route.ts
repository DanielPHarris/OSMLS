import { readFile } from "node:fs/promises";
import path from "node:path";
import { admitRequest, consumerFor, finishRequest, servedPhoto } from "@/lib/data-exchange";
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
  // Photos count against the same limit as everything else the consumer asks for.
  const admitted = await admitRequest(consumer, "photo", key.replace(/[^0-9a-f-]/gi, "?").slice(0, 100));
  if (admitted === "refused") return new Response("A valid bearer token is required.", { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } });
  if (admitted === "limit") return new Response("Too many requests in the last minute. Try again shortly.", { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  const photo = await servedPhoto(key);
  const missing = async () => {
    await finishRequest(admitted, 404, 0);
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  };
  if (!photo) return missing();
  try {
    const bytes = await readFile(path.join(mediaDir(), path.basename(photo.OsmlsStoragePath)));
    await finishRequest(admitted, 200, 1);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": photo.MediaType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return missing();
  }
}
