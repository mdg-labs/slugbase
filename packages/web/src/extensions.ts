/**
 * What a composition adds to the web app (doc 01 section 7.2). An extension is
 * identified by `id`; the routes, navigation items and slot components it
 * contributes arrive with the slot system.
 */
export interface WebExtension {
  /** Unique among the extensions of one app. */
  readonly id: string;
}

export function assertValidExtensions(extensions: readonly WebExtension[]): void {
  const seen = new Set<string>();
  for (const { id } of extensions) {
    if (id.trim() === "") {
      throw new Error("A web extension needs a non-empty id");
    }
    if (seen.has(id)) {
      throw new Error(`The web extension id "${id}" is used twice`);
    }
    seen.add(id);
  }
}
