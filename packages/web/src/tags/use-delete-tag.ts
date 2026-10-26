import { feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { deleteTag, refreshTagViews, tagFailureOf } from "./tags.ts";

// The refusals the confirmation tells in place, for which the shared error toast stays quiet; any other failure still raises it.
const SHOWN_IN_THE_DIALOG = inPlaceRefusals([
  { status: 404, code: "not_found" },
  { status: 429, code: "rate_limited" },
]);

/** Deletes a tag once the server has done it; the list does not show the tag gone before that. The bookmarks that carried it stay. */
export function useDeleteTag(onDeleted: (id: string) => void): UseMutationResult<void, Error, string> {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  return useMutation({
    mutationKey: ["tags", "delete"],
    meta: SHOWN_IN_THE_DIALOG,
    mutationFn: (id: string): Promise<void> => deleteTag(api, id),
    onSuccess: (_result, id) => {
      refreshTagViews(queryClient);
      feedbackToast.success(t("tags.deleted"));
      onDeleted(id);
    },
    onError: (error) => {
      // A tag that is gone already is gone from the list too once it is read again.
      if (tagFailureOf(error)?.kind === "notFound") {
        refreshTagViews(queryClient);
      }
    },
  });
}
