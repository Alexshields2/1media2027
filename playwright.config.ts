import { defineConfig, devices } from "@playwright/test";

// Smoke test against a production build (`npm run build` first) and a seeded database.
// Needs DATABASE_URL and ADMIN_PASSWORD in the environment. PW_CHROMIUM_PATH optionally
// points at a preinstalled Chromium instead of the one `npx playwright install` downloads.
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "off",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: `npx next start -p ${PORT}`, url: `http://localhost:${PORT}/api/health`, reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
