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
  // En CI : `list` reste le journal lisible dans la sortie du job, et `html` produit en plus le
  // rapport sur disque que l'étape upload-artifact archive avec les traces (`open: "never"` :
  // un runner n'a pas de navigateur à ouvrir, et le serveur du rapport bloquerait le job).
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/serve.mjs 4173",
    url: "http://127.0.0.1:4173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
