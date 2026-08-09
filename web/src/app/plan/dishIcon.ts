// AI-composed dishes never have a real photo (nothing was ever fetched or
// matched against Spoonacular), and until now every one showed the exact
// same generic bowl-and-steam placeholder regardless of what the dish
// actually was. No dish-type/cuisine metadata exists anywhere in the
// generation pipeline (aiMealComposition.ts only tags ingredients by macro
// role -- protein/carb/fat -- not dish shape), so a keyword match against
// the AI-generated title is the only signal available.
export type DishIconKind = "smoothie" | "soup" | "bowl" | "skillet" | "baked" | "sandwich" | "fallback";

// Order matters -- first match wins. Kept to a small, visually-distinct
// set rather than one rule per possible dish word.
const RULES: Array<[DishIconKind, RegExp]> = [
  ["smoothie", /smoothie|shake/i],
  ["soup", /soup|stew|chili|curry/i],
  ["bowl", /bowl|salad/i],
  ["skillet", /scramble|hash|skillet|stir[\s-]?fry/i],
  ["baked", /casserole|bake|gratin|quiche/i],
  ["sandwich", /sandwich|wrap|toast|burger/i],
];

export function pickDishIcon(recipeTitle: string): DishIconKind {
  for (const [kind, pattern] of RULES) {
    if (pattern.test(recipeTitle)) return kind;
  }
  return "fallback";
}
