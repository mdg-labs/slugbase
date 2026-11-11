import { REGISTRATION_ACKNOWLEDGEMENTS_MAX, RegistrationAcknowledgementSchema } from "@slugbase/contracts";
import { isSlotName } from "./slot-names.ts";
import type { ReactNode } from "react";
import type { WebExtension } from "./types.ts";

function assertAbsolutePath(path: string, what: string, extensionId: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`The ${what} "${path}" of the web extension "${extensionId}" must start with "/"`);
  }
}

/** Whether a checkbox label renders something a person can read: not empty, blank, `null`, `undefined` or a boolean. */
function hasLabel(label: ReactNode): boolean {
  if (label === null || label === undefined || typeof label === "boolean") {
    return false;
  }
  return typeof label !== "string" || label.trim() !== "";
}

/**
 * Refuses an extension list the app cannot start with: an empty or repeated id,
 * a slot name outside the closed set, a path that is not absolute, a route path
 * other than `/` that ends in `/` (the router would match it in place of the
 * same path without the slash), or a route path that another extension or the
 * app (`reservedPaths`) already owns, an acknowledgement whose id or version the
 * API would refuse or that has no label, an acknowledgement id declared twice across the extensions,
 * or more acknowledgements in total than one request may carry.
 */
export function assertValidExtensions(extensions: readonly WebExtension[], reservedPaths: readonly string[] = []): void {
  const ids = new Set<string>();
  const routePaths = new Set<string>(reservedPaths);
  const acknowledgementIds = new Set<string>();
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
      if (path.length > 1 && path.endsWith("/")) {
        throw new Error(`The route path "${path}" of the web extension "${id}" must not end with "/"`);
      }
      if (routePaths.has(path)) {
        throw new Error(`The route path "${path}" of the web extension "${id}" is already taken`);
      }
      routePaths.add(path);
    }
    for (const { id: acknowledgementId, version, label } of extension.acknowledgements ?? []) {
      const parsed = RegistrationAcknowledgementSchema.safeParse({ id: acknowledgementId, version });
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        throw new Error(`The acknowledgement "${acknowledgementId}" of the web extension "${id}" has an invalid ${String(issue?.path[0] ?? "entry")}: ${issue?.message ?? "refused"}`);
      }
      if (!hasLabel(label)) {
        throw new Error(`The acknowledgement "${acknowledgementId}" of the web extension "${id}" needs a label`);
      }
      if (acknowledgementIds.has(acknowledgementId)) {
        throw new Error(`The acknowledgement id "${acknowledgementId}" of the web extension "${id}" is used twice`);
      }
      acknowledgementIds.add(acknowledgementId);
    }
    for (const { to, label } of extension.navigation ?? []) {
      assertAbsolutePath(to, "navigation target", id);
      if (label.trim() === "") {
        throw new Error(`The navigation item "${to}" of the web extension "${id}" needs a label`);
      }
    }
  }
  if (acknowledgementIds.size > REGISTRATION_ACKNOWLEDGEMENTS_MAX) {
    throw new Error(`The web extensions declare ${String(acknowledgementIds.size)} acknowledgements; at most ${String(REGISTRATION_ACKNOWLEDGEMENTS_MAX)} are allowed`);
  }
}
