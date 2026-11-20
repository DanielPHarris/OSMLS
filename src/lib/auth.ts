import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "../db";
import * as schema from "../db/schema";

/**
 * Accounts are created by MLS staff processes (in 0.1, the seed script), never
 * by public sign-up, so sign-up is off unless a script asks for it.
 */
export function createAuth(options: { allowSignUp?: boolean } = {}) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.allowSignUp,
      minPasswordLength: 12,
      // Setting a password through a link signs the member out everywhere else.
      revokeSessionsOnPasswordReset: true,
    },
    // Password links are kept only as hashes, so one cannot be read back from the database.
    verification: { storeIdentifier: "hashed" },
    // nextCookies must be last: it writes the session cookie from server actions.
    plugins: [nextCookies()],
  });
}

export const auth = createAuth();
