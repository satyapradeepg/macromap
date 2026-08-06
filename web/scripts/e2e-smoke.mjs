// Real end-to-end smoke test against a running MacroMap environment,
// exercising the actual Auth0 login flow (migration
// 0034_auth0_identity_swap.sql replaced Basic Auth + the /profiles
// picker + Supabase Auth entirely -- see that migration's header comment
// for the full architecture). Not wired into CI: it needs a real,
// persistent test account's real credentials, and (lightly) mutates that
// account's profile/plan data. Run by hand after any change touching
// proxy.ts, lib/auth0.ts, lib/identity.ts, lib/supabase/server.ts, or the
// account/onboarding/plan Server Actions.
//
// Deliberately does NOT test account deletion -- that's destructive to the
// one persistent test account this script depends on for every other run.
// Verified manually once during the Auth0 migration itself (real Auth0
// user deletion confirmed via a subsequent failed login attempt); if that
// path needs re-testing, do it by hand against a disposable account, not
// via this script.
//
// Usage:
//   E2E_BASE_URL=http://localhost:3000 \
//   E2E_EMAIL=... E2E_PASSWORD=... \
//   node scripts/e2e-smoke.mjs

import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("Set E2E_EMAIL and E2E_PASSWORD (a real Auth0 test account's credentials).");
  process.exit(1);
}

let allOk = true;
function check(label, ok, extra) {
  if (!ok) allOk = false;
  console.log(`[${ok ? "OK" : "FAIL"}] ${label}${extra ? " -- " + extra : ""}`);
}

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByText("Log in", { exact: true }).click();
  const usernameField = page.locator('input[name="username"], input[type="email"], input#username');
  await usernameField.first().waitFor({ timeout: 10000 });
  await usernameField.first().fill(EMAIL);
  await page.locator('input[name="password"], input[type="password"], input#password').first().fill(PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((url) => url.origin === BASE, { timeout: 20000 });
}

async function main() {
  const browser = await chromium.launch();

  // 1. Homepage must be reachable with NO session at all.
  {
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    const res = await anonPage.goto(`${BASE}/`, { waitUntil: "networkidle" });
    check("homepage reachable with no Auth0 session", res.status() === 200, `status=${res.status()}`);
    await anonContext.close();
  }

  // 2. /plan and /account must redirect to Auth0 login with no session.
  {
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
    check("/plan redirects to Auth0 login when logged out", anonPage.url().includes("auth0.com"), anonPage.url());
    await anonPage.goto(`${BASE}/account`, { waitUntil: "networkidle" });
    check("/account redirects to Auth0 login when logged out", anonPage.url().includes("auth0.com"), anonPage.url());
    await anonContext.close();
  }

  // 3. Everything below uses a real authenticated session.
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page);
    check("login redirects to a real app page (/plan or /onboarding), not an error", /\/plan$|\/onboarding$/.test(page.url()), page.url());

    // If landed on /onboarding, this test account has no profile yet --
    // complete a minimal onboarding so the rest of the checks have a plan
    // to work with. If already onboarded (the normal case for a reused
    // persistent test account), this is skipped entirely.
    if (page.url() === `${BASE}/onboarding`) {
      const numberInputs = page.locator('input[type="number"]');
      await numberInputs.nth(0).fill("170");
      await numberInputs.nth(1).fill("5");
      await numberInputs.nth(2).fill("9");
      await numberInputs.nth(3).fill("29");
      await page.getByRole("button", { name: "Male", exact: true }).click();
      await page.locator("select").selectOption({ index: 1 });
      await page.getByRole("button", { name: "⚖️ Maintain", exact: true }).click();
      await page.getByRole("button", { name: "Calculate my macros", exact: true }).click();
      await page.waitForTimeout(1000);
      await page.getByRole("button", { name: "Looks good", exact: true }).click();
      await page.waitForTimeout(1500);
      await page.getByText("Continue to your meal plan", { exact: false }).click();
      await page.waitForURL(`${BASE}/plan`, { timeout: 15000 });
    }
    check("on /plan with a real session", page.url() === `${BASE}/plan`);

    const bodyText = await page.locator("body").innerText();
    check("plan page shows real content, not a stale error state", !/sign in|invalid refresh|unauthorized/i.test(bodyText));

    // Session survives a reload.
    await page.reload({ waitUntil: "networkidle" });
    check("session survives a reload", page.url() === `${BASE}/plan`, page.url());

    // /account reachable, shows the right identity.
    await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
    const acctText = await page.locator("body").innerText();
    check("/account shows the logged-in user's own email", acctText.includes(EMAIL));

    // Logout actually ends the session (not just clears a client-side flag).
    await page.getByText("Log out", { exact: true }).click();
    await page.waitForTimeout(1500);
    await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
    check("/plan requires login again after logout", page.url().includes("auth0.com"), page.url());

    // Re-login and confirm the same account's data persisted.
    await login(page);
    check("re-login lands back on /plan (existing profile persisted)", page.url() === `${BASE}/plan`, page.url());
  } catch (e) {
    check("EXCEPTION", false, String(e));
  } finally {
    await context.close();
  }

  // 4. RLS defense-in-depth: an unauthenticated Supabase request must never
  // return another user's (or any) row, regardless of app-level bugs.
  {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && anonKey) {
      for (const table of ["profiles", "meal_plans", "pantry_items", "grocery_price_overrides"]) {
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*`, {
          headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        });
        const body = await res.json();
        check(`RLS blocks unauthenticated reads on ${table}`, Array.isArray(body) && body.length === 0, `rows=${Array.isArray(body) ? body.length : JSON.stringify(body)}`);
      }
    } else {
      console.log("[SKIP] RLS check -- NEXT_PUBLIC_SUPABASE_URL/ANON_KEY not set in this shell.");
    }
  }

  await browser.close();
  console.log(allOk ? "\n=== ALL CHECKS PASSED ===" : "\n=== SOME CHECKS FAILED ===");
  process.exit(allOk ? 0 : 1);
}

main();
