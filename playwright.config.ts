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
  // Longer than the default five seconds, so a slow machine does not fail a
  // test whose page was only late. An assertion still passes the moment it holds.
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure" },
  // The permissions test changes the market-time settings that the figures in
  // every other test depend on, so it runs alone, after the rest have finished.
  projects: [
    { name: "main", testIgnore: /permissions\.spec\.ts/ },
    { name: "settings", testMatch: /permissions\.spec\.ts/, dependencies: ["main"] },
  ],
  webServer: {
    // The production build, not the development server: the development server
    // closes a connection after five idle seconds and cannot be told otherwise,
    // and a request that reuses a connection at that moment is reset or left
    // unanswered. That is the likely cause of these tests failing at random,
    // here and on GitHub: against this server the failures stopped.
    command: `pnpm build && pnpm start --port ${port} --keepAliveTimeout 70000`,
    url: `${baseURL}/sign-in`,
    // The test always starts its own server on the test database and a separate
    // photo folder, so it cannot write to development or demo data.
    env: {
      BETTER_AUTH_URL: baseURL,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      MEDIA_DIR: "./data/test-media",
      // A blank local map style, so the tests do not depend on an outside map service.
      MAP_STYLE_URL: `${baseURL}/blank-map-style.json`,
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
