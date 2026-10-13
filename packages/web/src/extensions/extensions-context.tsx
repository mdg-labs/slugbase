import { createContext, use, type ReactElement, type ReactNode } from "react";
import type { WebExtension } from "./types.ts";

const ExtensionsContext = createContext<readonly WebExtension[] | undefined>(undefined);

/** Makes the app's extensions readable by the slots and the navigation. */
export function ExtensionsProvider({
  extensions,
  children,
}: {
  extensions: readonly WebExtension[];
  children: ReactNode;
}): ReactElement {
  return <ExtensionsContext value={extensions}>{children}</ExtensionsContext>;
}

export function useExtensions(): readonly WebExtension[] {
  const extensions = use(ExtensionsContext);
  if (extensions === undefined) {
    throw new Error("Extensions can only be read inside the web app");
  }
  return extensions;
}
