import { z } from "zod";

const TRUE_VALUES: ReadonlySet<string> = new Set(["true", "1"]);
const FALSE_VALUES: ReadonlySet<string> = new Set(["false", "0"]);

/**
 * A boolean environment value: "true" and "1" are true, "false" and "0" are
 * false, anything else (an empty string, "yes", "False") is a validation error.
 * An unset key takes the default of `.default()`.
 */
export function envBoolean() {
  return z
    .string()
    .refine((value) => TRUE_VALUES.has(value) || FALSE_VALUES.has(value), {
      error: 'must be one of "true", "false", "1" or "0"',
    })
    .transform((value) => TRUE_VALUES.has(value));
}
