import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { Reauth } from "./reauth.ts";

const ReauthContext = createContext<Reauth | null>(null);

/** Hands the shared re-authentication prompt to the screens that must ask for it before they leave the app. */
export function ReauthProvider({ reauth, children }: { reauth: Reauth; children: ReactNode }): ReactElement {
  return <ReauthContext.Provider value={reauth}>{children}</ReauthContext.Provider>;
}

export function useReauth(): Reauth {
  const reauth = useContext(ReauthContext);
  if (reauth === null) {
    throw new Error("useReauth must be used inside the web app");
  }
  return reauth;
}
