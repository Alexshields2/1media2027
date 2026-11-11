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
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
});

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) throw new Error("ADMIN_PASSWORD must be set for the e2e smoke test");
    await page.goto("/login");
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
});
