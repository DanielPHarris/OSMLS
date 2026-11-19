import { readFile } from "node:fs/promises";
import path from "node:path";
import { mediaDir } from "@/lib/listings";
import { getSharedPhoto } from "@/lib/shares";

// A photo for whoever holds a working link, and only a photo that link's page shows.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; key: string }> }) {
  const { token, key } = await params;
  const photo = await getSharedPhoto(token, key);
  if (!photo) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(path.join(mediaDir(), path.basename(photo.OsmlsStoragePath)));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": photo.MediaType,
        // Never stored, so a revoked link's photos are not served from a cache.
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
