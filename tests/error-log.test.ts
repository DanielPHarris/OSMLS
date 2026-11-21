/*
 * The one log line a server error writes: where and what kind, and nothing of
 * what the request carried.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "../src/instrumentation";
import { serverErrorLine } from "../src/lib/error-log";

const SECRET = "jordan.client@example.com";
const failure = Object.assign(new TypeError(`could not save listing for ${SECRET}`), { digest: "1234567890" });
const request = {
  path: `/search?email=${SECRET}`,
  method: "POST",
  headers: { cookie: `session=${SECRET}`, "x-forwarded-for": "203.0.113.9", "user-agent": SECRET },
};
const context = { routerKind: "App Router", routePath: "/listings/[id]", routeType: "action", renderSource: "react-server-components", revalidateReason: undefined, renderType: "dynamic" } as const;

afterEach(() => vi.restoreAllMocks());

describe("a server error", () => {
  it("writes exactly one line, with the stated fields and none of the request's data", async () => {
    const written = vi.spyOn(console, "error").mockImplementation(() => {});
    await onRequestError(failure, request, context);
    expect(written).toHaveBeenCalledTimes(1);
    const text = written.mock.calls[0][0] as string;
    expect(text).not.toContain("\\n");
    const line = JSON.parse(text);
    expect(Object.keys(line).sort()).toEqual(["at", "digest", "error", "event", "level", "method", "requestId", "route", "routeType"]);
    expect(line).toMatchObject({ level: "error", event: "server-error", method: "POST", route: "/listings/[id]", routeType: "action", error: "TypeError", digest: "1234567890" });
    expect(line.requestId).toMatch(/^[0-9a-f-]{36}$/);
    for (const absent of [SECRET, "203.0.113.9", "could not save", "/search", "session="]) expect(text.includes(absent), absent).toBe(false);
  });

  it("uses the caller's request identifier only if it is a plain one", () => {
    const withId = (id: string) => serverErrorLine(failure, { ...request, headers: { "x-request-id": id } }, context).requestId;
    expect(withId("req-42.a_b")).toBe("req-42.a_b");
    expect(withId(`id ${SECRET}`)).toMatch(/^[0-9a-f-]{36}$/);
    expect(withId("x".repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is still one line when what was thrown is not an error", () => {
    expect(serverErrorLine(`text with ${SECRET}`, request, context)).toMatchObject({ error: "Error", digest: null });
  });
});
