import { isSlotName } from "./slot-names.ts";
import type { WebExtension } from "./types.ts";

function assertAbsolutePath(path: string, what: string, extensionId: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`The ${what} "${path}" of the web extension "${extensionId}" must start with "/"`);
  }
}

/**
 * Refuses an extension list the app cannot start with: an empty or repeated id,
 * a slot name outside the closed set, a path that is not absolute, or a route
 * path that another extension or the app (`reservedPaths`) already owns.
 */
export function assertValidExtensions(extensions: readonly WebExtension[], reservedPaths: readonly string[] = []): void {
  const ids = new Set<string>();
  const routePaths = new Set<string>(reservedPaths);
  for (const extension of extensions) {
    const { id } = extension;
    if (id.trim() === "") {
      throw new Error("A web extension needs a non-empty id");
    }
    if (ids.has(id)) {
      throw new Error(`The web extension id "${id}" is used twice`);
    }
    ids.add(id);

    for (const name of Object.keys(extension.slots ?? {})) {
      if (!isSlotName(name)) {
        throw new Error(`The web extension "${id}" fills the unknown slot "${name}"`);
      }
    }
    for (const { path } of extension.routes ?? []) {
      assertAbsolutePath(path, "route path", id);
      if (routePaths.has(path)) {
        throw new Error(`The route path "${path}" of the web extension "${id}" is already taken`);
      }
      routePaths.add(path);
    }
    for (const { to, label } of extension.navigation ?? []) {
      assertAbsolutePath(to, "navigation target", id);
      if (label.trim() === "") {
        throw new Error(`The navigation item "${to}" of the web extension "${id}" needs a label`);
      }
    }
  }
}
