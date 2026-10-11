/** A copy of the object without the given keys. */
export function omit<T extends object, K extends keyof T>(source: T, ...keys: K[]): Omit<T, K> {
  const dropped: PropertyKey[] = keys;
  return Object.fromEntries(Object.entries(source).filter(([key]) => !dropped.includes(key))) as Omit<T, K>;
}
