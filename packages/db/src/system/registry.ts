/**
 * The system operations (doc 05 section 3.3): the reviewed list of the
 * `SECURITY DEFINER` functions that cross the tenant or account boundary. A
 * bare name is a function of the `public` schema; a function of another schema
 * is written `schema.name`. Every overload of a listed name is covered by it.
 *
 * `pnpm db:check` fails for a `SECURITY DEFINER` function that is not listed
 * here and for an entry without a function. Adding an entry is a risk-flagged
 * change (doc 10): the function it names ships in a migration of the same
 * change, under the rules of the `system-operations` rule.
 */
export const systemOperations: readonly string[] = ["sys_rate_limit_take"];
