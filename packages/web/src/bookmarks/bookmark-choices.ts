/** The value of a tag chip that is a name the caller has no tag of yet; an identifier never starts with it. */
const NEW_TAG_PREFIX = "new:";

/** The values of the tag chips for the tags `ids` and the new names `names`, in that order. */
export function tagValuesOf(ids: readonly string[], names: readonly string[]): string[] {
  return [...ids, ...names.map((name) => `${NEW_TAG_PREFIX}${name}`)];
}

/** The identifiers and the new names the tag chips `values` stand for. */
export function splitTagValues(values: readonly string[]): { readonly ids: string[]; readonly names: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  for (const value of values) {
    if (value.startsWith(NEW_TAG_PREFIX)) {
      names.push(value.slice(NEW_TAG_PREFIX.length));
    } else {
      ids.push(value);
    }
  }
  return { ids, names };
}

/** Whether two lists of identifiers hold the same ones, whatever their order. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
