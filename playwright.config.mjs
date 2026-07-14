import { defineConfig, devices } from "@playwright/test";

// Tests E2E de fumée (non-régression des bugs passés). Le site est servi par le
// serveur statique maison (aucune dépendance runtime). Fichiers : e2e/*.pw.mjs
// (le suffixe .pw évite que `node --test` ne les ramasse — ils passent par Playwright).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.mjs",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/serve.mjs 4173",
    url: "http://localhost:4173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
