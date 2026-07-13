// Unit conversions for the onboarding form. PRD 7.3 F1: users pick lbs/kg and
// ft-in/cm, but all internal calculations run in metric.

export function lbsToKg(lbs: number): number {
  return lbs / 2.205;
}

export function kgToLbs(kg: number): number {
  return kg * 2.205;
}

export function feetInchesToCm(feet: number, inches: number): number {
  return (feet * 12 + inches) * 2.54;
}

export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return { feet, inches };
}
