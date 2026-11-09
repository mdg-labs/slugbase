/** The value with object members in a fixed order and `undefined` as `null`, so that the same request spelled differently serialises, and so hashes, the same (the request hash of the idempotency stage, doc 04 section 6.3). */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, member]) => [name, canonical(member)]),
    );
  }
  return value === undefined ? null : value;
}
