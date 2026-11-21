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
  // The caller's own identifier if it sent a plain one, otherwise one made here.
  requestId: string;
  method: string;
  // The route's pattern, such as /listings/[id]: never the address asked for.
  route: string;
  routeType: string;
  error: string;
  // The reference shown on the error page, so a report from a person can be matched to this line.
  digest: string | null;
};

const PLAIN_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function serverErrorLine(
  err: unknown,
  request: { method: string; headers: Record<string, string | string[] | undefined> },
  context: { routePath: string; routeType: string },
  now = new Date(),
): ServerErrorLine {
  const given = request.headers["x-request-id"];
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : null;
  return {
    level: "error",
    event: "server-error",
    at: now.toISOString(),
    requestId: typeof given === "string" && PLAIN_ID.test(given) ? given : randomUUID(),
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
    error: err instanceof Error ? err.name : "Error",
    digest: digest && PLAIN_ID.test(digest) ? digest : null,
  };
}
