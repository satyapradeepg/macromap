// Deterministic core of the assistant's edit_profile intent (F7): turns
// a classified list of add/remove/set operations into the full profile
// fields saveProfile() (app/onboarding/actions.ts) needs, applied on top
// of the user's CURRENT profile row -- never a full replacement, since a
// chat message only ever describes a delta ("I'm allergic to peanuts
// now"), not the user's entire profile restated. Pure and unit-testable;
// chatActions.ts is the only caller and does the actual DB read/write.
//
// Unit conversion convention: the intent classifier is instructed to
// report weightKg's value in POUNDS and heightCm's value in INCHES (the
// same units OnboardingWizard.tsx defaults its own form to) rather than
// asking the classifier to do unit math itself -- this keeps the LLM's
// job to plain extraction/normalization and keeps the actual arithmetic
// here, deterministic, using the exact same lib/units.ts helpers the
// onboarding form uses.

import { AGE_RANGE, HEIGHT_CM_RANGE, WEIGHT_KG_RANGE, type ActivityLevel, type BiologicalSex, type Goal } from "@/lib/tdee";
import { kgToLbs, lbsToKg } from "@/lib/units";
import type { DietaryStyle } from "@/lib/mealplan/dietaryMapping";
import type { ProfileOperation } from "./intentClassifier";

export interface ProfileScalarFields {
  weightKg: number;
  heightCm: number;
  age: number;
  biologicalSex: BiologicalSex;
  activityLevel: ActivityLevel;
  goal: Goal;
}

export interface ProfileListFields {
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
}

export type ProfileFields = ProfileScalarFields & ProfileListFields;

export interface ApplyProfileOperationsResult {
  fields: ProfileFields;
  // True only if a macro-affecting scalar changed -- callers use this to
  // decide whether daily macro targets need recomputing (calculateBmr ->
  // calculateTdee -> calculateMacroTargets), vs. a pure list edit (a new
  // allergy) which leaves the existing macro numbers untouched.
  scalarsChanged: boolean;
  error: string | null;
}

const VALID_DIETARY_STYLES: DietaryStyle[] = ["vegetarian", "vegan", "gluten_free", "dairy_free", "halal", "kosher"];
const VALID_ACTIVITY_LEVELS: ActivityLevel[] = ["sedentary", "lightly_active", "active", "very_active"];
const VALID_GOALS: Goal[] = ["cut", "bulk", "maintain"];
const VALID_SEXES: BiologicalSex[] = ["male", "female"];

function normalizeEnumValue(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function addUnique(list: string[], value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return list;
  if (list.some((v) => v.toLowerCase() === trimmed.toLowerCase())) return list;
  return [...list, trimmed];
}

function removeMatching(list: string[], value: string): string[] {
  const normalized = value.trim().toLowerCase();
  return list.filter((v) => v.toLowerCase() !== normalized);
}

// Never partially applies -- one bad operation invalidates the whole
// batch (returns the ORIGINAL, untouched fields alongside the error), the
// same "never a partial result" discipline this codebase's other
// batch-validation functions follow (e.g. mealProposer.ts's
// validateBatchProposals).
export function applyProfileOperations(current: ProfileFields, operations: ProfileOperation[]): ApplyProfileOperationsResult {
  const fields: ProfileFields = {
    ...current,
    dietaryStyles: [...current.dietaryStyles],
    allergies: [...current.allergies],
    dislikes: [...current.dislikes],
  };
  let scalarsChanged = false;

  const fail = (error: string): ApplyProfileOperationsResult => ({ fields: current, scalarsChanged: false, error });

  for (const op of operations) {
    if (op.field === "dietaryStyles" || op.field === "allergies" || op.field === "dislikes") {
      if (op.field === "dietaryStyles" && op.action === "add") {
        const normalized = normalizeEnumValue(op.value);
        if (!VALID_DIETARY_STYLES.includes(normalized as DietaryStyle)) {
          return fail(`"${op.value}" isn't a dietary style I recognize -- I can add vegetarian, vegan, gluten-free, dairy-free, halal, or kosher.`);
        }
        fields.dietaryStyles = addUnique(fields.dietaryStyles, normalized);
        continue;
      }
      fields[op.field] = op.action === "add" ? addUnique(fields[op.field], op.value) : removeMatching(fields[op.field], op.value);
      continue;
    }

    switch (op.field) {
      case "weightKg": {
        const lbs = parseFloat(op.value);
        const kg = lbsToKg(lbs);
        if (!Number.isFinite(kg) || kg < WEIGHT_KG_RANGE.min || kg > WEIGHT_KG_RANGE.max) {
          return fail(`Weight must be between ${Math.round(kgToLbs(WEIGHT_KG_RANGE.min))} and ${Math.round(kgToLbs(WEIGHT_KG_RANGE.max))} lbs.`);
        }
        fields.weightKg = kg;
        scalarsChanged = true;
        break;
      }
      case "heightCm": {
        const totalInches = parseFloat(op.value);
        const cm = totalInches * 2.54;
        if (!Number.isFinite(cm) || cm < HEIGHT_CM_RANGE.min || cm > HEIGHT_CM_RANGE.max) {
          return fail(`Height must be between ${Math.round(HEIGHT_CM_RANGE.min / 2.54)} and ${Math.round(HEIGHT_CM_RANGE.max / 2.54)} inches.`);
        }
        fields.heightCm = cm;
        scalarsChanged = true;
        break;
      }
      case "age": {
        const age = parseInt(op.value, 10);
        if (!Number.isFinite(age) || age < AGE_RANGE.min || age > AGE_RANGE.max) {
          return fail(`Age must be between ${AGE_RANGE.min} and ${AGE_RANGE.max}.`);
        }
        fields.age = age;
        scalarsChanged = true;
        break;
      }
      case "activityLevel": {
        const normalized = normalizeEnumValue(op.value);
        if (!VALID_ACTIVITY_LEVELS.includes(normalized as ActivityLevel)) {
          return fail(`"${op.value}" isn't an activity level I recognize -- sedentary, lightly active, active, or very active.`);
        }
        fields.activityLevel = normalized as ActivityLevel;
        scalarsChanged = true;
        break;
      }
      case "goal": {
        const normalized = normalizeEnumValue(op.value);
        if (!VALID_GOALS.includes(normalized as Goal)) {
          return fail(`"${op.value}" isn't a goal I recognize -- cut, bulk, or maintain.`);
        }
        fields.goal = normalized as Goal;
        scalarsChanged = true;
        break;
      }
      case "biologicalSex": {
        const normalized = normalizeEnumValue(op.value);
        if (!VALID_SEXES.includes(normalized as BiologicalSex)) {
          return fail(`"${op.value}" isn't a value I recognize -- male or female.`);
        }
        fields.biologicalSex = normalized as BiologicalSex;
        scalarsChanged = true;
        break;
      }
    }
  }

  return { fields, scalarsChanged, error: null };
}
