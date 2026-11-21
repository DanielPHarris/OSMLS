import type { Instrumentation } from "next";
import { serverErrorLine } from "@/lib/error-log";

/** Called by Next.js for every server error it catches. One line each: see src/lib/error-log.ts. */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  console.error(JSON.stringify(serverErrorLine(err, request, context)));
};
