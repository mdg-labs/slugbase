import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ME_QUERY_KEY, type Account, type Me } from "./me.ts";

/**
 * The signed-in account as the cache holds it, and undefined while it does not. It asks for nothing: the
 * app loads the account when it starts, a saved change replaces it, and sign-out clears it.
 */
export function useCachedAccount(): Account | undefined {
  const queryClient = useQueryClient();
  return useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(onChange),
    () => queryClient.getQueryData<Me>(ME_QUERY_KEY)?.account,
  );
}
