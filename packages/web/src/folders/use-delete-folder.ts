import { feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { FOLDERS_QUERY_KEY, deleteFolder, folderFailureOf } from "./folders.ts";

/** Deletes a folder once the server has done it; the list does not show the folder gone before that. The bookmarks in it stay. */
export function useDeleteFolder(onDeleted: () => void): UseMutationResult<void, Error, string> {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  return useMutation({
    mutationKey: ["folders", "delete"],
    mutationFn: (id: string): Promise<void> => deleteFolder(api, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      feedbackToast.success(t("folders.deleted"));
      onDeleted();
    },
    onError: (error) => {
      // A folder that is gone already is gone from the list too once it is read again.
      if (folderFailureOf(error)?.kind === "notFound") {
        void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      }
    },
  });
}
