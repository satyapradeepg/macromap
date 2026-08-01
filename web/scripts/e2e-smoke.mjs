// Real end-to-end smoke test against a deployed MacroMap environment.
//
// This exists because two real bugs (a stale comment-only edit that left
// removed code running, and a gate cookie scoped to the wrong path) both
// slipped past tsc/eslint/vitest and curl-based verification on 2026-08-01
// -- neither approach exercises a real authenticated browser session, which
// is the only thing that actually caught either bug. Run this by hand after
// any change touching middleware.ts, the persona-switcher, or auth/cookies
// in general. Not wired into CI: it mutates real data (creates + deletes a
// throwaway persona) and needs real deployed credentials.
//
// Usage:
//   E2E_BASE_URL=https://macromap.apps.human-angle.com \
//   E2E_USERNAME=... E2E_PASSWORD=... \
//   node scripts/e2e-smoke.mjs

import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "https://macromap.apps.human-angle.com";
const USERNAME = process.env.E2E_USERNAME;
const PASSWORD = process.env.E2E_PASSWORD;
const LABEL = `e2e-smoke-${Date.now()}`;

if (!USERNAME || !PASSWORD) {
  console.error("Set E2E_USERNAME and E2E_PASSWORD (the deployed ACCESS_USERNAME/ACCESS_PASSWORD).");
  process.exit(1);
}

let allOk = true;
function check(label, ok, extra) {
  if (!ok) allOk = false;
  console.log(`[${ok ? "OK" : "FAIL"}] ${label}${extra ? " -- " + extra : ""}`);
}

async function main() {
  const browser = await chromium.launch();

  // 1. Homepage must be reachable with NO credentials at all.
  {
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    const res = await anonPage.goto(`${BASE}/`, { waitUntil: "networkidle" });
    check("homepage reachable with no Basic Auth credentials", res.status() === 200, `status=${res.status()}`);
    await anonContext.close();
  }

  // 2. /profiles must 401 with NO credentials.
  {
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    const res = await anonPage.goto(`${BASE}/profiles`, { waitUntil: "domcontentloaded" });
    check("/profiles requires Basic Auth when no credentials given", res.status() === 401, `status=${res.status()}`);
    await anonContext.close();
  }

  // 3. Everything below uses a context with valid Basic Auth credentials.
  const context = await browser.newContext({ httpCredentials: { username: USERNAME, password: PASSWORD } });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept()); // confirm() on Delete

  try {
    await page.goto(`${BASE}/profiles`, { waitUntil: "networkidle" });
    check("/profiles reachable with valid Basic Auth credentials", page.url() === `${BASE}/profiles`);

    // Create a disposable persona
    await page.getByPlaceholder(/vegan_soy_allergy/i).fill(LABEL);
    await page.getByRole("button", { name: /New profile/i }).click();
    await page.waitForURL(`${BASE}/onboarding`, { timeout: 15000 });
    check("create persona -> /onboarding", page.url() === `${BASE}/onboarding`);

    // Back to profiles, switch to it. Row cards are the specific
    // .rounded-lg.border.border-border.bg-surface div (see Card.tsx) --
    // a generic "div with this text" locator also matches broad ancestor
    // wrappers, and "Switch" (exact: false) also substring-matches the
    // LogoutBar's unrelated "Switch profile" button.
    await page.goto(`${BASE}/profiles`, { waitUntil: "networkidle" });
    const row = page.locator(".rounded-lg.border.border-border.bg-surface").filter({ hasText: LABEL });
    // The disposable persona has no profiles row yet (onboarding was never
    // completed for it), so /plan/page.tsx's own pre-existing logic
    // correctly bounces it to /onboarding rather than staying on /plan --
    // that's the right outcome here, not a bug. The thing actually under
    // test is that it lands somewhere real (an app page with real content),
    // not on a 401 or a login page that no longer exists.
    await row.getByRole("button", { name: "Switch", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/plan" || url.pathname === "/onboarding", { timeout: 15000 });
    await page.waitForTimeout(2000);
    const afterSwitchUrl = page.url();
    check("switch lands on a real app page (/plan or /onboarding), not login/401", true, `url=${afterSwitchUrl}`);
    const planText = await page.locator("body").innerText();
    check("post-switch page shows real content, not an error", !/sign in|invalid refresh/i.test(planText));

    // Reload proves the session persists across a fresh request
    await page.reload({ waitUntil: "networkidle" });
    check("session survives a reload", page.url() === afterSwitchUrl, `url=${page.url()}`);

    // Edit -> /onboarding, stays
    await page.goto(`${BASE}/profiles`, { waitUntil: "networkidle" });
    const editRow = page.locator(".rounded-lg.border.border-border.bg-surface").filter({ hasText: LABEL });
    await editRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForURL(`${BASE}/onboarding`, { timeout: 15000 });
    await page.waitForTimeout(1500);
    check("edit -> /onboarding and stays there", page.url() === `${BASE}/onboarding`);

    // "Switch profile" ends the persona session but keeps Basic Auth valid
    await page.getByRole("button", { name: /Switch profile/i }).click();
    await page.waitForURL(`${BASE}/profiles`, { timeout: 10000 });
    check("switch profile -> /profiles (not a 401 -- Basic Auth still cached)", page.url() === `${BASE}/profiles`);

    await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
    check("/plan with no active persona redirects to /onboarding, not a 401", page.url() === `${BASE}/onboarding`);

    // Clean up: delete the disposable persona
    await page.goto(`${BASE}/profiles`, { waitUntil: "networkidle" });
    const deleteRow = page.locator(".rounded-lg.border.border-border.bg-surface").filter({ hasText: LABEL });
    await deleteRow.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForTimeout(1500);
    const afterDeleteText = await page.locator("body").innerText();
    check("disposable persona cleaned up", !afterDeleteText.includes(LABEL));
  } catch (e) {
    check("EXCEPTION", false, String(e));
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(allOk ? "\n=== ALL CHECKS PASSED ===" : "\n=== SOME CHECKS FAILED ===");
  process.exit(allOk ? 0 : 1);
}

main();
