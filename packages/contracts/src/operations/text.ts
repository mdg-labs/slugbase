import { z } from "zod";

/** The message of the field error a value that holds a NUL character is refused with. */
export const NUL_MESSAGE = "must not contain a NUL character";

/**
 * Refuses a string that holds U+0000. PostgreSQL cannot store it in a text column, so a request that carried one would reach the
 * database and be answered with a server error; it is refused here as a field error, 422 validation_failed, instead. Apply it to every
 * schema of a field the API stores as entered.
 */
export function withoutNul<Schema extends z.ZodString>(schema: Schema): Schema {
  return schema.refine((value) => !value.includes("\u0000"), { message: NUL_MESSAGE });
}
