import type { StoryDefault } from "@ladle/react";
import { PasswordStrength, type PasswordScore } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Password strength",
  parameters: { subject: ["PasswordStrength"] },
} satisfies StoryDefault;

const WORDS = ["Very weak", "Weak", "Fair", "Good", "Strong"] as const;
const SCORES: readonly PasswordScore[] = [0, 1, 2, 3, 4];

export const Scores = (): React.ReactElement => (
  <div className="flex max-w-sm flex-col gap-3">
    {SCORES.map((score) => (
      <PasswordStrength key={score} label={`Password strength ${String(score)}`} score={score} scoreLabel={WORDS[score]} />
    ))}
  </div>
);
