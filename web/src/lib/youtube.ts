// F9 recipe video deep-links — zero API calls, zero quota (PRD 7.3 F9).

export function recipeVideoSearchUrl(recipeTitle: string): string {
  const query = encodeURIComponent(`${recipeTitle} recipe`);
  return `https://www.youtube.com/results?search_query=${query}`;
}
