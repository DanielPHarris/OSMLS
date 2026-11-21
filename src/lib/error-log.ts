import { randomUUID } from "node:crypto";

/*
 * One line in the process log for each server error the application did not
 * handle. It says where and what kind, and nothing about whom or with what:
 * no query string, no form contents, no address, no member, and not the
 * error's message, which can quote data. Nothing is stored or sent anywhere;
 * shipping the log is the installation's.
 */

export type ServerErrorLine = {
  level: "error";
  event: "server-error";
  at: string;
  // Made here for this line. Nothing a caller sent is copied, however plain it looks: it could be personal.
  requestId: string;
  method: string;
  // The route's pattern, such as /listings/[id]: never the address asked for.
  route: string;
  routeType: string;
  error: string;
  // The reference shown on the error page, so a report from a person can be matched to this line.
  digest: string | null;
};

// The reference Next.js makes for the error page is a short hash. Anything else in its place is left out.
const PLAIN_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function serverErrorLine(
  err: unknown,
  request: { method: string },
  context: { routePath: string; routeType: string },
  now = new Date(),
): ServerErrorLine {
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : null;
  return {
    level: "error",
    event: "server-error",
    at: now.toISOString(),
    requestId: randomUUID(),
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
    error: err instanceof Error ? err.name : "Error",
    digest: digest && PLAIN_ID.test(digest) ? digest : null,
  };
}
