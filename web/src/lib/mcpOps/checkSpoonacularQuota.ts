export async function checkSpoonacularQuota(apiKey?: string) {
  const key = apiKey ?? process.env.SPOONACULAR_API_KEY;
  if (!key) throw new Error("no API key provided and SPOONACULAR_API_KEY is not set");

  const res = await fetch(
    `https://api.spoonacular.com/food/ingredients/search?apiKey=${encodeURIComponent(key)}&query=stock&number=1`,
  );
  const quotaLeft = res.headers.get("x-api-quota-left");
  const quotaUsed = res.headers.get("x-api-quota-used");

  return {
    status: res.status,
    quotaLeft: quotaLeft ? Number(quotaLeft) : null,
    quotaUsed: quotaUsed ? Number(quotaUsed) : null,
    note: "Quota readings are volatile — a key has been observed going from 30+ points to fully exhausted (402) within seconds. A passing check here doesn't guarantee a subsequent recipe/ingredient call will succeed.",
  };
}
