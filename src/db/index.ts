import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// The production build imports this file without a database; only running code needs one.
if (!process.env.DATABASE_URL && process.env.NEXT_PHASE !== "phase-production-build") {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
}

// Reuse one pool across hot reloads in development.
const globalForDb = globalThis as unknown as { osmlsPool?: Pool };
export const pool =
  globalForDb.osmlsPool ?? new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalForDb.osmlsPool = pool;

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
