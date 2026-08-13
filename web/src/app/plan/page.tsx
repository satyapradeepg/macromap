import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/identity";
import { LogoutBar } from "../LogoutBar";
import { getMostRecentPlan } from "./data";
import { getPantryItems } from "./pantryData";
import { getGroceryList } from "./groceryData";
import { PlanBoard } from "./PlanView";

// 21 concurrent Spoonacular calls + up to 3 sequential tolerance widenings
// per slot + up to 3 shared retry-budget queries can genuinely take several
// seconds — past Vercel's 10s Hobby default for Server Actions invoked from
// this route (OQ7/OQ6).
export const maxDuration = 60;

// Login is enforced in proxy.ts (Auth0 session check) before this page ever
// renders -- the `!user` branch below is a defensive fallback, not the real
// gate. Kept dynamic since it's always rendered per-session, never a
// build-time snapshot.
export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const supabase = await createClient();
  const user = await getCurrentUser();

  if (!user) {
    redirect("/auth/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, allergies, dislikes, dietary_styles, daily_calories, tier")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    redirect("/onboarding");
  }

  const tier: "free" | "pro" = profile.tier ?? "free";
  // getMostRecentPlan and getPantryItems don't depend on each other -- they
  // were previously awaited one after the other for no reason, adding a
  // full extra round-trip to every /plan navigation (live-confirmed
  // 2026-08-13, reported as this page feeling slow to reach from /account).
  // getGroceryList genuinely can't join this Promise.all: it needs
  // initialPlan.id, which doesn't exist until the plan lookup resolves.
  const [initialPlan, initialPantryItems] = await Promise.all([
    getMostRecentPlan(supabase, user.id),
    getPantryItems(supabase, user.id),
  ]);
  const initialGroceryList = initialPlan ? await getGroceryList(supabase, initialPlan.id, user.id, tier) : [];

  return (
    <>
      <LogoutBar />
      <PlanBoard
        initialPlan={initialPlan}
        dietaryStyles={profile.dietary_styles ?? []}
        dailyCalories={profile.daily_calories}
        initialPantryItems={initialPantryItems}
        initialGroceryList={initialGroceryList}
      />
    </>
  );
}
