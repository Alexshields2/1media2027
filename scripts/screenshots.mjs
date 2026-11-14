// Screenshots of every page at desktop (1440) and phone (390) width, for design review.
//   node scripts/screenshots.mjs <base-url> <out-dir> [suffix]
// Needs a running app on a seeded database and ADMIN_PASSWORD (and OWNER_EMAIL) in the environment.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:3100";
const out = process.argv[3] ?? "docs/screenshots/w9";
const suffix = process.argv[4] ?? "";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});

async function signIn(page) {
  await page.goto(`${base}/login`);
  const email = page.getByLabel("Email");
  if (await email.isVisible().catch(() => false)) await email.fill(process.env.OWNER_EMAIL ?? "owner@example.com");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${base}/`);
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/login-${label}${suffix}.png`, fullPage: true });
  await signIn(page);
  // Find a client and an agent run to open.
  await page.goto(`${base}/clients?view=table`);
  const clientHref = await page.locator('a[href^="/clients/"]:not([href="/clients/new"])').first().getAttribute("href");
  await page.goto(`${base}/agents`);
  const runHref = await page.locator('a[href^="/agents/runs/"]').first().getAttribute("href").catch(() => null);
  const pages = [
    ["home", "/"],
    ["dashboard", "/dashboard"],
    ["clients", "/clients"],
    ["clients-table", "/clients?view=table"],
    ["client", clientHref],
    ["payments", "/payments"],
    ["tasks", "/tasks"],
    ["health", "/health"],
    ["reports", "/reports"],
    ["approvals", "/approvals"],
    ["agents", "/agents"],
    ["agent-run", runHref],
    ["settings", "/settings"],
  ];
  for (const [name, path] of pages) {
    if (!path) continue;
    await page.goto(`${base}${path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) console.log(`${label} ${name}: horizontal page overflow ${overflow}px`);
    await page.screenshot({ path: `${out}/${name}-${label}${suffix}.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
console.log(`Saved to ${out}`);
