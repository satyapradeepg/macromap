import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMostRecentPlan } from "./data";
import { getPantryItems } from "./pantryData";
import { getGroceryList } from "./groceryData";
import { PlanBoard } from "./PlanView";

// 21 concurrent Spoonacular calls + up to 3 sequential tolerance widenings
// per slot + up to 3 shared retry-budget queries can genuinely take several
// seconds — past Vercel's 10s Hobby default for Server Actions invoked from
// this route (OQ7/OQ6).
export const maxDuration = 60;

export default async function PlanPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/onboarding");
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
  const initialPlan = await getMostRecentPlan(supabase, user.id);
  const initialPantryItems = await getPantryItems(supabase, user.id);
  const initialGroceryList = initialPlan ? await getGroceryList(supabase, initialPlan.id, user.id, tier) : [];

  return (
    <PlanBoard
      initialPlan={initialPlan}
      dietaryStyles={profile.dietary_styles ?? []}
      dailyCalories={profile.daily_calories}
      initialPantryItems={initialPantryItems}
      initialGroceryList={initialGroceryList}
      tier={tier}
    />
  );
}
