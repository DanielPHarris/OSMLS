import { readFile } from "node:fs/promises";
import { documentPath, getDocumentForViewer } from "@/lib/documents";
import { getCurrentMember } from "@/lib/session";

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/*
 * The only way to a document's contents. Access is checked on every request.
 * A document the viewer may not have answers exactly like one that does not exist.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const viewer = await getCurrentMember();
  if (!viewer) return new Response("Sign in required", { status: 401 });
  const document = await getDocumentForViewer(viewer, (await params).key);
  if (!document) return new Response("Not found", { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await readFile(documentPath(document.OsmlsStoragePath));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const ext = EXTENSIONS[document.MediaType] ?? "bin";
  // The download is named after the document, reduced to plain characters.
  const base = (document.ShortDescription ?? "document").replace(/[^A-Za-z0-9 ._-]+/g, "_").slice(0, 80) || "document";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": document.MediaType,
      "Content-Length": String(bytes.length),
      // Always a download, never shown inside the application's own pages.
      "Content-Disposition": `attachment; filename="${base}.${ext}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
