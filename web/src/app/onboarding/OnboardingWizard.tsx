"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
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

export function OnboardingWizard() {
  const [step, setStep] = useState<1 | 2>(1);

  // Step 1 (F1) state
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("lbs");
  const [weightInput, setWeightInput] = useState("185");
  const [heightUnit, setHeightUnit] = useState<HeightUnit>("ftin");
  const [heightFeet, setHeightFeet] = useState("5");
  const [heightInches, setHeightInches] = useState("11");
  const [heightCmInput, setHeightCmInput] = useState("180");
  const [age, setAge] = useState("26");
  const [biologicalSex, setBiologicalSex] = useState<BiologicalSex | null>(
    null,
  );
  const [activityLevel, setActivityLevel] = useState<ActivityLevel | null>(
    null,
  );
  const [goal, setGoal] = useState<Goal | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Metric snapshot taken when Step 1 is submitted, reused on final save
  const [metrics, setMetrics] = useState<{
    weightKg: number;
    heightCm: number;
    age: number;
  } | null>(null);

  // Step 2 (F1 review + F2) state. Targets pre-fill from the calculation but
  // are editable — PRD 7.3 F1: "user can nudge any value manually."
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [dietaryStyles, setDietaryStyles] = useState<string[]>([]);
  const [allergyPresets, setAllergyPresets] = useState<string[]>([]);
  const [otherAllergies, setOtherAllergies] = useState("");
  const [dislikes, setDislikes] = useState("");
  const [weeklyBudget, setWeeklyBudget] = useState("");
  const [zipCode, setZipCode] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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

    setSaving(false);
    if (result.error) {
      setSaveError(result.error);
    } else {
      setSaved(true);
    }
  }

  if (saved) {
    return (
      <main className="mx-auto w-full min-w-0 max-w-md px-6 py-24 text-center">
        <h1 className="text-2xl font-bold">Profile saved</h1>
        <p className="mt-2 text-muted">
          {calories} kcal · {protein}g protein · {carbs}g carbs · {fat}g fat,
          daily.
        </p>
        <Link
          href="/plan"
          className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 font-semibold text-white"
        >
          Continue to your meal plan
        </Link>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-semibold text-muted">
                Weekly budget (optional)
              </label>
              <Input
                type="number"
                value={weeklyBudget}
                onChange={(e) => setWeeklyBudget(e.target.value)}
                placeholder="$"
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
          </div>

          {saveError && <p className="text-sm text-red-500">{saveError}</p>}

          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setStep(1)} className="py-3">
              Back
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-3"
            >
              {saving ? "Saving…" : "Looks good"}
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
