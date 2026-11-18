import { readFile } from "node:fs/promises";
import path from "node:path";
import { getPhoto, mediaDir } from "@/lib/listings";
import { getCurrentMember } from "@/lib/session";

// Photos are served only to signed-in members.
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!(await getCurrentMember())) return new Response("Sign in required", { status: 401 });
  const photo = await getPhoto((await params).key);
  if (!photo) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(path.join(mediaDir(), path.basename(photo.OsmlsStoragePath)));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": photo.MediaType,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
