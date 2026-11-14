import { test, expect, type Page } from "@playwright/test";

const PAGES: { path: string; heading: RegExp }[] = [
  { path: "/", heading: /Good (morning|afternoon|evening)/ },
  { path: "/dashboard", heading: /^Dashboard$/ },
  { path: "/clients", heading: /^Clients$/ },
  { path: "/payments", heading: /^Payments$/ },
  { path: "/tasks", heading: /^Tasks$/ },
  { path: "/health", heading: /^Client health$/ },
  { path: "/reports", heading: /^Reports$/ },
  { path: "/approvals", heading: /^Approvals$/ },
  { path: "/agents", heading: /^Agents$/ },
  { path: "/chat", heading: /^Jarvis$/ },
  { path: "/chat/jarvis/settings", heading: /^Jarvis settings$/ },
];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("health endpoint reports the database", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, db: "ok" });
});

test("signed-out visitors are sent to /login, which shows the logo", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  const logo = page.getByRole("img", { name: "1Media" });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("wrong password is rejected", async ({ page }) => {
  await page.goto("/login");
  const email = page.getByLabel("Email");
  if (await email.isVisible()) await email.fill(process.env.OWNER_EMAIL ?? "owner@example.com");
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Wrong (email or )?password\./)).toBeVisible();
});

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) throw new Error("ADMIN_PASSWORD must be set for the e2e smoke test");
    await page.goto("/login");
    // First sign-in (no accounts yet) asks only for ADMIN_PASSWORD and creates the OWNER_EMAIL owner;
    // after that the form asks for email + password.
    const email = page.getByLabel("Email");
    if (await email.isVisible()) await email.fill(process.env.OWNER_EMAIL ?? "owner@example.com");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  for (const { path, heading } of PAGES) {
    test(`${path} renders`, async ({ page }) => {
      const errors = collectErrors(page);
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(errors).toEqual([]);
    });
  }

  test("payment log: tick a month paid, untick it, and switch views", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/payments");
    const grid = page.getByTestId("payment-grid");
    await expect(grid).toBeVisible();
    // The first unpaid, past-due box in the grid.
    const box = grid.locator('button[role=checkbox][aria-checked=false][aria-label$="overdue"]').first();
    const name = (await box.getAttribute("aria-label"))!.replace(/: overdue$/, "");
    await box.click();
    const ticked = grid.getByRole("checkbox", { name: `${name}: paid` });
    await expect(ticked).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(grid.getByRole("checkbox", { name: `${name}: paid` })).toBeVisible();
    // Untick asks first.
    page.once("dialog", (d) => d.accept());
    await grid.getByRole("checkbox", { name: `${name}: paid` }).click();
    await expect(grid.getByRole("checkbox", { name: `${name}: overdue` })).toBeVisible();

    await page.getByRole("link", { name: "By month" }).click();
    await expect(page).toHaveURL(/view=list/);
    await expect(page.getByRole("columnheader", { name: "Amount due" }).first()).toBeVisible();
    await page.getByRole("link", { name: "Month view" }).click();
    await expect(page.getByText("Overdue by age")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("generate month rows: hidden before tracking started, and asks with the count and total first", async ({ page }) => {
    await page.goto("/payments?view=month&month=2025-06");
    await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Generate .* rows/ })).toHaveCount(0);

    const d = new Date();
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1)).toISOString().slice(0, 7); // a month with no rows yet
    await page.goto(`/payments?view=month&month=${next}`);
    let message = "";
    page.once("dialog", (dlg) => {
      message = dlg.message();
      dlg.dismiss();
    });
    await page.getByRole("button", { name: /Generate .* rows/ }).first().click();
    await expect.poll(() => message).toMatch(/^Create \d+ unpaid retainer rows? for .+, totalling €/);
    await expect(page.getByText(/No rows for/)).toBeVisible();
  });

  test("chat: send a message and see the reply (or the missing-key notice) stream in", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/chat/jarvis");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Message Jarvis").fill("Who owes us money right now?");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-role=user]").last()).toContainText("Who owes us money right now?");
    if (process.env.AGENTS_MOCK === "true" || process.env.ANTHROPIC_API_KEY) {
      // The URL moves to the new conversation and the answer arrives.
      await expect(page).toHaveURL(/\/chat\/jarvis\/\d+$/);
      await expect(page.locator("[data-role=assistant]").last()).toContainText(/owed|overdue/i, { timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
    } else {
      await expect(page.locator("p[role=alert]")).toContainText("ANTHROPIC_API_KEY");
    }
    expect(errors).toEqual([]);
  });
});
