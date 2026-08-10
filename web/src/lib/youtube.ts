// Recipe video deep-links — zero API calls, zero quota.

export function recipeVideoSearchUrl(recipeTitle: string): string {
  const query = encodeURIComponent(`${recipeTitle} recipe`);
  return `https://www.youtube.com/results?search_query=${query}`;
}
