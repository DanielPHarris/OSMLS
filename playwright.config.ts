import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set. Copy it from .env.example into .env.");

// A dedicated port, so the test never attaches to some other app on 3000.
const port = process.env.E2E_PORT ?? "3210";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: `${baseURL}/sign-in`,
    // The test always starts its own server on the test database and a separate
    // photo folder, so it cannot write to development or demo data.
    env: {
      BETTER_AUTH_URL: baseURL,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      MEDIA_DIR: "./data/test-media",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
