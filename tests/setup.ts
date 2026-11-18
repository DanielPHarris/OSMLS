import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

// Tests run against their own database, never the development or demo one.
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set. Copy it from .env.example into .env.");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
