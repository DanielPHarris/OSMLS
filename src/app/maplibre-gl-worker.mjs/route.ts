import { readFile } from "node:fs/promises";
import path from "node:path";

/*
 * The map library runs part of itself in a background worker, which the browser
 * must load from a URL of its own. This serves that file from the installed
 * package, so the application depends on no outside host for it.
 */
const workerFile = path.join(process.cwd(), "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");
let cached: Promise<Buffer> | undefined;

export async function GET() {
  // A failed read is not remembered, so the next request tries again.
  cached ??= readFile(workerFile).catch((error) => {
    cached = undefined;
    throw error;
  });
  return new Response(new Uint8Array(await cached), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
