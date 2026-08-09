"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
import { Spinner } from "@/components/ui/Spinner";
import {
  ACTIVITY_MULTIPLIERS,
  AGE_RANGE,
  HEIGHT_CM_RANGE,
  WEIGHT_KG_RANGE,
  calculateBmr,
  calculateMacroTargets,
  calculateTdee,
  type ActivityLevel,
  type BiologicalSex,
  type Goal,
} from "@/lib/tdee";
import {
  cmToFeetInches,
  feetInchesToCm,
  kgToLbs,
  lbsToKg,
} from "@/lib/units";
import type { DietaryStyle } from "@/lib/mealplan/dietaryMapping";
import { saveProfile } from "./actions";
import { generatePlan } from "@/app/plan/actions";

const ACTIVITY_OPTIONS: { value: ActivityLevel; label: string }[] = [
  { value: "sedentary", label: "Sedentary" },
  { value: "lightly_active", label: "Lightly active" },
  { value: "active", label: "Active" },
  { value: "very_active", label: "Very active" },
];

const GOAL_OPTIONS: { value: Goal; label: string; emoji: string }[] = [
  { value: "cut", label: "Cut", emoji: "📉" },
  { value: "bulk", label: "Bulk", emoji: "💪" },
  { value: "maintain", label: "Maintain", emoji: "⚖️" },
];

// This wait can run 50-90s+ (orchestrate.ts's real generation pipeline --
// pantry-aware querying, tolerance widening, AI-composition fallback) with
// literally zero motion beforehand (2026-08-08 UI pass). Named after the
// pipeline's own real stages rather than generic "please wait" filler.
// Advances once per interval and holds on the last message rather than
// looping, so it reads as progress, not a stuck repeat.
const GENERATING_STATUS_MESSAGES = [
  "Checking your pantry for ingredients you already have…",
  "Matching recipes to your macro targets…",
  "Filtering for your dietary restrictions and allergies…",
  "Balancing macros across the week…",
  "Almost ready…",
];

// `satisfies readonly DietaryStyle[]` (audit round 3, finding 12): a new
// entry added here without a matching dietaryMapping.ts DIETARY_STYLE_MAP
// entry used to vanish completely -- not even surfaced as "unsupported"
// like halal/kosher, since resolveDiet/resolveIntolerances/
// unsupportedDietaryStyles all filter through isDietaryStyle first. This
// turns that into a compile error instead of a silent runtime gap.
const DIETARY_STYLE_OPTIONS = [
  "vegetarian",
  "vegan",
  "gluten_free",
  "dairy_free",
  "halal",
  "kosher",
] as const satisfies readonly DietaryStyle[];

// The 9 FDA-recognized major allergens (2023 FASTER Act) -- previously
// only offered nuts/shellfish/eggs/soy, leaving milk/wheat/fish/sesame to
// depend entirely on correct free-text entry (audit round 3, finding 3).
const ALLERGY_PRESET_OPTIONS = ["nuts", "shellfish", "eggs", "soy", "milk", "wheat", "fish", "sesame"] as const;

type WeightUnit = "lbs" | "kg";
type HeightUnit = "ftin" | "cm";

function toggleInArray(value: string, list: string[]): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

export interface OnboardingInitialProfile {
  weightKg: number;
  heightCm: number;
  age: number;
  biologicalSex: BiologicalSex;
  activityLevel: ActivityLevel;
  goal: Goal;
  dailyCalories: number;
  dailyProteinG: number;
  dailyCarbsG: number;
  dailyFatG: number;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
  weeklyBudgetUsd: number | null;
  zipCode: string | null;
}

// initialProfile turns this into an edit form for an already-onboarded user
// (/account) instead of a fresh-signup wizard (/onboarding) -- saveProfile
// upserts by user id either way, so the only difference is what the fields
// start out showing.
export function OnboardingWizard({
  initialProfile,
}: {
  initialProfile?: OnboardingInitialProfile;
} = {}) {
  const [step, setStep] = useState<1 | 2>(1);

  const initialHeightFtIn = initialProfile
    ? cmToFeetInches(initialProfile.heightCm)
    : { feet: 5, inches: 11 };
  const initialAllergyPresets =
    initialProfile?.allergies.filter((a) =>
      (ALLERGY_PRESET_OPTIONS as readonly string[]).includes(a),
    ) ?? [];
  const initialOtherAllergies =
    initialProfile?.allergies
      .filter((a) => !(ALLERGY_PRESET_OPTIONS as readonly string[]).includes(a))
      .join(", ") ?? "";

  // Step 1 (F1) state
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("lbs");
  const [weightInput, setWeightInput] = useState(
    initialProfile ? String(Math.round(kgToLbs(initialProfile.weightKg))) : "185",
  );
  const [heightUnit, setHeightUnit] = useState<HeightUnit>("ftin");
  const [heightFeet, setHeightFeet] = useState(String(initialHeightFtIn.feet));
  const [heightInches, setHeightInches] = useState(String(initialHeightFtIn.inches));
  const [heightCmInput, setHeightCmInput] = useState(
    initialProfile ? String(Math.round(initialProfile.heightCm)) : "180",
  );
  const [age, setAge] = useState(initialProfile ? String(initialProfile.age) : "26");
  const [biologicalSex, setBiologicalSex] = useState<BiologicalSex | null>(
    initialProfile?.biologicalSex ?? null,
  );
  const [activityLevel, setActivityLevel] = useState<ActivityLevel | null>(
    initialProfile?.activityLevel ?? null,
  );
  const [goal, setGoal] = useState<Goal | null>(initialProfile?.goal ?? null);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Metric snapshot taken when Step 1 is submitted, reused on final save
  const [metrics, setMetrics] = useState<{
    weightKg: number;
    heightCm: number;
    age: number;
  } | null>(null);

  // Step 2 (F1 review + F2) state. Targets pre-fill from the calculation but
  // are editable — PRD 7.3 F1: "user can nudge any value manually."
  const [calories, setCalories] = useState(
    initialProfile ? String(initialProfile.dailyCalories) : "",
  );
  const [protein, setProtein] = useState(
    initialProfile ? String(initialProfile.dailyProteinG) : "",
  );
  const [carbs, setCarbs] = useState(
    initialProfile ? String(initialProfile.dailyCarbsG) : "",
  );
  const [fat, setFat] = useState(initialProfile ? String(initialProfile.dailyFatG) : "");
  const [dietaryStyles, setDietaryStyles] = useState<string[]>(
    initialProfile?.dietaryStyles ?? [],
  );
  const [allergyPresets, setAllergyPresets] = useState<string[]>(initialAllergyPresets);
  const [otherAllergies, setOtherAllergies] = useState(initialOtherAllergies);
  const [dislikes, setDislikes] = useState(initialProfile?.dislikes.join(", ") ?? "");
  // No form control edits this anymore -- the budget-aware ranking feature
  // (orchestrate.ts/ranking.ts) still reads weekly_budget_usd, so this just
  // carries forward whatever a user already had set (or null for everyone
  // else) rather than clearing it. Re-adding an input here is all it'd take
  // to let users set it again.
  const weeklyBudget = initialProfile?.weeklyBudgetUsd != null ? String(initialProfile.weeklyBudgetUsd) : "";
  const [zipCode, setZipCode] = useState(initialProfile?.zipCode ?? "");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [alsoGenerate, setAlsoGenerate] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [usingCachedFallback, setUsingCachedFallback] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);

  const router = useRouter();
  const [continuing, startContinuing] = useTransition();

  useEffect(() => {
    if (!generating) return;
    const interval = setInterval(() => {
      setStatusIndex((i) => Math.min(i + 1, GENERATING_STATUS_MESSAGES.length - 1));
    }, 4000);
    return () => clearInterval(interval);
  }, [generating]);

  function handleCalculate() {
    const weightKg =
      weightUnit === "lbs"
        ? lbsToKg(parseFloat(weightInput))
        : parseFloat(weightInput);
    const heightCm =
      heightUnit === "ftin"
        ? feetInchesToCm(
            parseFloat(heightFeet) || 0,
            parseFloat(heightInches) || 0,
          )
        : parseFloat(heightCmInput);
    const ageNum = parseInt(age, 10);

    if (!biologicalSex) return setStep1Error("Select a biological sex.");
    if (!activityLevel) return setStep1Error("Select an activity level.");
    if (!goal) return setStep1Error("Select a goal.");
    if (
      Number.isNaN(weightKg) ||
      weightKg < WEIGHT_KG_RANGE.min ||
      weightKg > WEIGHT_KG_RANGE.max
    ) {
      return setStep1Error(
        `Weight must be between ${Math.round(kgToLbs(WEIGHT_KG_RANGE.min))} and ${Math.round(kgToLbs(WEIGHT_KG_RANGE.max))} lbs.`,
      );
    }
    if (
      Number.isNaN(heightCm) ||
      heightCm < HEIGHT_CM_RANGE.min ||
      heightCm > HEIGHT_CM_RANGE.max
    ) {
      return setStep1Error(
        `Height must be between ${HEIGHT_CM_RANGE.min} and ${HEIGHT_CM_RANGE.max} cm.`,
      );
    }
    if (
      Number.isNaN(ageNum) ||
      ageNum < AGE_RANGE.min ||
      ageNum > AGE_RANGE.max
    ) {
      return setStep1Error(
        `Age must be between ${AGE_RANGE.min} and ${AGE_RANGE.max}.`,
      );
    }

    setStep1Error(null);

    const bmr = calculateBmr({
      weightKg,
      heightCm,
      age: ageNum,
      biologicalSex,
    });
    const tdee = calculateTdee(bmr, activityLevel);
    const targets = calculateMacroTargets(tdee, weightKg, goal);

    setMetrics({ weightKg, heightCm, age: ageNum });
    setCalories(String(targets.dailyCalories));
    setProtein(String(targets.dailyProteinG));
    setCarbs(String(targets.dailyCarbsG));
    setFat(String(targets.dailyFatG));
    setStep(2);
  }

  async function handleSave() {
    if (!metrics || !biologicalSex || !activityLevel || !goal) return;
    setSaving(true);
    setSaveError(null);

    const allergies = [...allergyPresets];
    if (otherAllergies.trim()) {
      allergies.push(
        ...otherAllergies
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      );
    }

    const result = await saveProfile({
      weightKg: metrics.weightKg,
      heightCm: metrics.heightCm,
      age: metrics.age,
      biologicalSex,
      activityLevel,
      goal,
      dailyCalories: parseInt(calories, 10),
      dailyProteinG: parseInt(protein, 10),
      dailyCarbsG: parseInt(carbs, 10),
      dailyFatG: parseInt(fat, 10),
      dietaryStyles,
      allergies,
      dislikes: dislikes
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      weeklyBudgetUsd: weeklyBudget ? parseFloat(weeklyBudget) : null,
      zipCode: zipCode.trim() || null,
    });

    if (result.error) {
      setSaving(false);
      setSaveError(result.error);
      return;
    }

    if (alsoGenerate) {
      setSaving(false);
      setStatusIndex(0);
      setGenerating(true);
      // Live-confirmed 2026-08-09 (same root cause found on /plan's own
      // Regenerate button): a slow generation can exceed the platform's
      // gateway timeout (measured at exactly 120s), surfacing as a
      // rejected fetch here, not a normal `{ error: ... }` result. With no
      // try/catch, that throw used to propagate past `setGenerating
      // (false)` and leave this full-viewport overlay stuck forever. The
      // profile itself already saved successfully above regardless.
      let genResult;
      try {
        genResult = await generatePlan();
      } catch {
        setGenerating(false);
        setGenerateError(
          "This is taking longer than the page can wait for. It may still finish in the background -- try refreshing in a minute to check.",
        );
        setSaved(true);
        return;
      }
      setGenerating(false);
      if (genResult.error) {
        // Profile itself did save -- just surface the generation failure
        // and fall back to the manual "Continue" link below, rather than
        // losing the save.
        setGenerateError(genResult.error);
        setSaved(true);
        return;
      }
      if (genResult.usingCachedFallback) {
        // No error, but the "plan" just returned is last week's, not one
        // built from the targets just saved -- an auto-redirect to /plan
        // here would look identical to a real regeneration succeeding.
        // Stop and say so instead, same as the genResult.error branch above.
        setUsingCachedFallback(true);
        setSaved(true);
        return;
      }
      router.push("/plan");
      return;
    }

    setSaving(false);
    setSaved(true);
  }

  if (generating) {
    // Fixed full-viewport overlay, not a block in normal flow -- on
    // /account this component sits between AccountIdentity and DangerZone
    // (siblings rendered by the page, not by this component, see
    // account/page.tsx), which used to leave both visible around a plain
    // static message. A spinner competing with unrelated page chrome
    // around it reads as more broken than static text did, so this covers
    // the whole viewport regardless of where those siblings render.
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <main className="mx-auto w-full min-w-0 max-w-md px-6 text-center">
          <Spinner className="mx-auto h-8 w-8 text-accent" />
          <h1 className="mt-4 text-2xl font-bold">Generating your meal plan</h1>
          <p className="mt-2 text-muted">{GENERATING_STATUS_MESSAGES[statusIndex]}</p>
        </main>
      </div>
    );
  }

  if (saved) {
    return (
      <main className="mx-auto w-full min-w-0 max-w-md px-6 py-24 text-center">
        <h1 className="text-2xl font-bold">Profile saved</h1>
        <p className="mt-2 text-muted">
          {calories} kcal · {protein}g protein · {carbs}g carbs · {fat}g fat,
          daily.
        </p>
        {generateError && (
          <p className="mt-2 text-sm text-red-500">
            Couldn&apos;t generate a new meal plan automatically: {generateError}
          </p>
        )}
        {usingCachedFallback && (
          <p className="mt-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
            Live generation is temporarily unavailable, so the meal plan
            you&apos;ll see next is your last one, not yet updated for these
            new targets. Try &quot;Regenerate&quot; from the meal plan page
            shortly.
          </p>
        )}
        <Button
          variant="primary"
          onClick={() => startContinuing(() => router.push("/plan"))}
          loading={continuing}
          loadingText="Loading"
          className="mt-6"
        >
          Continue to your meal plan
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full min-w-0 max-w-lg px-6 py-16">
      <div className="flex gap-1.5">
        <div className={`h-1 flex-1 rounded-full ${step >= 1 ? "bg-accent" : "bg-border"}`} />
        <div className={`h-1 flex-1 rounded-full ${step >= 2 ? "bg-accent" : "bg-border"}`} />
      </div>
      <p className="mt-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Step {step} of 2</p>

      <h1 className="mt-2 text-2xl font-bold">
        {step === 1
          ? "Let's calculate your targets"
          : "Your suggested daily targets"}
      </h1>

      {step === 1 ? (
        <div className="mt-8 flex flex-col gap-5">
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-muted">
                Weight
              </label>
              <UnitToggle
                options={[
                  { value: "lbs", label: "lbs" },
                  { value: "kg", label: "kg" },
                ]}
                value={weightUnit}
                onChange={(u) => {
                  const kg =
                    weightUnit === "lbs"
                      ? lbsToKg(parseFloat(weightInput) || 0)
                      : parseFloat(weightInput) || 0;
                  setWeightUnit(u as WeightUnit);
                  setWeightInput(
                    u === "kg"
                      ? String(Math.round(kg))
                      : String(Math.round(kgToLbs(kg))),
                  );
                }}
              />
            </div>
            <Input
              type="number"
              value={weightInput}
              onChange={(e) => setWeightInput(e.target.value)}
              className="mt-1"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-muted">
                Height
              </label>
              <UnitToggle
                options={[
                  { value: "ftin", label: "ft/in" },
                  { value: "cm", label: "cm" },
                ]}
                value={heightUnit}
                onChange={(u) => {
                  if (u === "cm") {
                    setHeightCmInput(
                      String(
                        Math.round(
                          feetInchesToCm(
                            parseFloat(heightFeet) || 0,
                            parseFloat(heightInches) || 0,
                          ),
                        ),
                      ),
                    );
                  } else {
                    const { feet, inches } = cmToFeetInches(
                      parseFloat(heightCmInput) || 0,
                    );
                    setHeightFeet(String(feet));
                    setHeightInches(String(inches));
                  }
                  setHeightUnit(u as HeightUnit);
                }}
              />
            </div>
            {heightUnit === "ftin" ? (
              <div className="mt-1 flex gap-2">
                <Input
                  type="number"
                  value={heightFeet}
                  onChange={(e) => setHeightFeet(e.target.value)}
                  placeholder="ft"
                />
                <Input
                  type="number"
                  value={heightInches}
                  onChange={(e) => setHeightInches(e.target.value)}
                  placeholder="in"
                />
              </div>
            ) : (
              <Input
                type="number"
                value={heightCmInput}
                onChange={(e) => setHeightCmInput(e.target.value)}
                className="mt-1"
              />
            )}
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">Age</label>
            <Input
              type="number"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">
              Biological sex
            </label>
            <p className="text-xs text-muted">
              Used only to calculate your BMR accurately.
            </p>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(["male", "female"] as BiologicalSex[]).map((s) => (
                <Pill
                  key={s}
                  active={biologicalSex === s}
                  onClick={() => setBiologicalSex(s)}
                  className="text-center capitalize"
                >
                  {s}
                </Pill>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">
              Activity level
            </label>
            <select
              value={activityLevel ?? ""}
              onChange={(e) =>
                setActivityLevel(
                  (e.target.value || null) as ActivityLevel | null,
                )
              }
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-foreground focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
            >
              <option value="" disabled>
                Select…
              </option>
              {ACTIVITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label} ({ACTIVITY_MULTIPLIERS[o.value]}×)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">Goal</label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {GOAL_OPTIONS.map((o) => (
                <Pill
                  key={o.value}
                  active={goal === o.value}
                  onClick={() => setGoal(o.value)}
                  className="text-center"
                >
                  {o.emoji} {o.label}
                </Pill>
              ))}
            </div>
          </div>

          {step1Error && <p className="text-sm text-red-500">{step1Error}</p>}

          <Button variant="primary" onClick={handleCalculate} className="mt-2 w-full py-3">
            Calculate my macros
          </Button>
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Calories"
              value={calories}
              onChange={setCalories}
            />
            <NumberField
              label="Protein (g)"
              value={protein}
              onChange={setProtein}
            />
            <NumberField label="Carbs (g)" value={carbs} onChange={setCarbs} />
            <NumberField label="Fat (g)" value={fat} onChange={setFat} />
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">
              Dietary style (optional)
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              {DIETARY_STYLE_OPTIONS.map((option) => (
                <Pill
                  key={option}
                  size="sm"
                  active={dietaryStyles.includes(option)}
                  onClick={() =>
                    setDietaryStyles(toggleInArray(option, dietaryStyles))
                  }
                  className="capitalize"
                >
                  {option.replace("_", " ")}
                </Pill>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">
              Allergies
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              {ALLERGY_PRESET_OPTIONS.map((option) => (
                <Pill
                  key={option}
                  size="sm"
                  active={allergyPresets.includes(option)}
                  onClick={() =>
                    setAllergyPresets(toggleInArray(option, allergyPresets))
                  }
                  className="capitalize"
                >
                  {option}
                </Pill>
              ))}
            </div>
            <Input
              type="text"
              value={otherAllergies}
              onChange={(e) => setOtherAllergies(e.target.value)}
              placeholder="Other allergies, comma separated"
              className="mt-2"
            />
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">
              Dislikes
            </label>
            <Input
              type="text"
              value={dislikes}
              onChange={(e) => setDislikes(e.target.value)}
              placeholder="e.g. Brussels sprouts, cilantro"
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-semibold text-muted">
              Zip code
            </label>
            <Input
              type="text"
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value)}
              className="mt-1"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={alsoGenerate}
              onChange={(e) => setAlsoGenerate(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Also generate a new meal plan with these targets
          </label>

          {saveError && <p className="text-sm text-red-500">{saveError}</p>}

          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setStep(1)} className="py-3">
              Back
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              loading={saving}
              loadingText="Saving"
              className="flex-1 py-3"
            >
              Looks good
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

function UnitToggle({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-2 py-0.5 text-[10px] font-bold ${
            value === o.value ? "bg-accent text-white" : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-semibold tracking-wide text-muted uppercase">
        {label}
      </label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 font-mono"
      />
    </div>
  );
}
