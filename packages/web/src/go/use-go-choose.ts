import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { navigateTo } from "../auth/navigate.ts";
import { chooseBookmark, type GoChoice } from "./go.ts";

/** Chooses a bookmark of a slug and, once the server has answered its destination, leaves for it. */
export function useGoChoose(): UseMutationResult<string, Error, GoChoice> {
  const router = useRouter();
  const api = router.options.context.api;
  return useMutation({
    mutationFn: (choice: GoChoice): Promise<string> => chooseBookmark(api, choice),
    onSuccess: (url) => {
      navigateTo(url);
    },
  });
}
