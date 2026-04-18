/** Mockup §5.15.2: length ≥ 8 → 1; +1 per character class (lower, upper, digit, symbol); cap at 4. */
export function passwordStrengthScore(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length < 8) return 0;
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/\d/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1;
  const raw = 1 + classes;
  return Math.min(4, raw) as 0 | 1 | 2 | 3 | 4;
}
