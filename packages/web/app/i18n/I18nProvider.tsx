import { TolgeeProvider } from "@tolgee/react";
import type { ReactNode } from "react";
import { tolgee } from "./tolgee.js";

export type I18nProviderProps = {
  children: ReactNode;
};

export function I18nProvider({ children }: I18nProviderProps) {
  return <TolgeeProvider tolgee={tolgee}>{children}</TolgeeProvider>;
}
