import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/identity";
import { LogoutBar } from "../LogoutBar";
import { OnboardingWizard, type OnboardingInitialProfile } from "../onboarding/OnboardingWizard";
import { AccountIdentity } from "./AccountIdentity";
import { DangerZone } from "./DangerZone";

// Login is enforced in proxy.ts (Auth0 session check) before this page ever
// renders. Kept dynamic since it's always rendered per-session.
export const dynamic = "force-dynamic";

interface ProfileRow {
  weight_kg: number;
  height_cm: number;
  age: number;
  biological_sex: OnboardingInitialProfile["biologicalSex"];
  activity_level: OnboardingInitialProfile["activityLevel"];
  goal: OnboardingInitialProfile["goal"];
  daily_calories: number;
  daily_protein_g: number;
  daily_carbs_g: number;
  daily_fat_g: number;
  dietary_styles: string[];
  allergies: string[];
  dislikes: string[];
  weekly_budget_usd: number | null;
  zip_code: string | null;
}

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/auth/login");
  }

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "weight_kg, height_cm, age, biological_sex, activity_level, goal, daily_calories, daily_protein_g, daily_carbs_g, daily_fat_g, dietary_styles, allergies, dislikes, weekly_budget_usd, zip_code",
    )
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  // No profile yet -- account editing doesn't apply until onboarding is
  // done at least once (mirrors plan/page.tsx's own check).
  if (!profile) {
    redirect("/onboarding");
  }

  const initialProfile: OnboardingInitialProfile = {
    weightKg: profile.weight_kg,
    heightCm: profile.height_cm,
    age: profile.age,
    biologicalSex: profile.biological_sex,
    activityLevel: profile.activity_level,
    goal: profile.goal,
    dailyCalories: profile.daily_calories,
    dailyProteinG: profile.daily_protein_g,
    dailyCarbsG: profile.daily_carbs_g,
    dailyFatG: profile.daily_fat_g,
    dietaryStyles: profile.dietary_styles ?? [],
    allergies: profile.allergies ?? [],
    dislikes: profile.dislikes ?? [],
    weeklyBudgetUsd: profile.weekly_budget_usd,
    zipCode: profile.zip_code,
  };

  return (
    <>
      <LogoutBar />
      <div className="mx-auto w-full min-w-0 max-w-lg px-6 py-10">
        <h1 className="text-2xl font-bold">Account</h1>
        <div className="mt-6">
          <AccountIdentity email={user.email} name={user.name} />
        </div>
      </div>
      <OnboardingWizard initialProfile={initialProfile} />
      <div className="mx-auto w-full min-w-0 max-w-lg px-6 pb-16">
        <DangerZone />
      </div>
    </>
  );
}
