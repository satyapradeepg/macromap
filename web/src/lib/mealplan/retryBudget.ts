// Epic E2 (F3) — shared retry budget spent by claim-resolution's exhaustion
// re-queries first, then weekly reconciliation's re-queries (see
// docs/PRD-MacroMap.md OQ7 + weekly reconciliation: both are capped at 3
// extra queries total per plan, not 3 each — exhaustion is rare, so in the
// common case it spends nothing and leaves the full budget for
// reconciliation).

export interface RetryBudget {
  remaining: number;
}

export function createRetryBudget(total = 3): RetryBudget {
  return { remaining: total };
}

// No partial spend: returns false (and leaves remaining untouched) if the
// budget can't cover the full request.
export function trySpend(budget: RetryBudget, n = 1): boolean {
  if (budget.remaining < n) return false;
  budget.remaining -= n;
  return true;
}
