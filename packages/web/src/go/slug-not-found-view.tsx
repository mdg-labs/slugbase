import { Button } from "@slugbase/ui";
import { CompassIcon, EmptyState, feedbackToast, PlusIcon } from "@slugbase/ui/patterns";
import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useSwitchFailureMessage, useWorkspaceSwitch } from "../shell/workspaces.ts";
import type { GoWorkspace } from "./go.ts";

export interface SlugNotFoundViewProps {
  readonly slug: string;
  /** The name of the workspace the slug was looked up in. */
  readonly workspaceName: string | undefined;
  /** The member's other workspaces in which they can read a bookmark with the slug (doc 02 section 6.2 step 3.5, Q26). */
  readonly otherWorkspaces: readonly GoWorkspace[];
  /** Reads the slug again, for a list of workspaces that turned out to be out of date. */
  readonly onRefresh: () => void;
}

/**
 * Nothing the member can read has the slug in the workspace (doc 03 section 10): the page offers to create the bookmark, with the
 * slug filled in, and to switch to a workspace of the member where the slug exists. Switching is the member's own request:
 * the answer of a workspace is read again for the new one, and the slug goes on from there.
 */
export function SlugNotFoundView({ slug, workspaceName, otherWorkspaces, onRefresh }: SlugNotFoundViewProps): ReactElement {
  const { t } = useTranslation();
  const { pending, switchTo } = useWorkspaceSwitch();
  const failureMessage = useSwitchFailureMessage();
  const [target, setTarget] = useState<string | undefined>(undefined);

  async function switchAndContinue(workspace: GoWorkspace): Promise<void> {
    setTarget(workspace.id);
    const outcome = await switchTo(workspace.id);
    if (outcome.status === "failed") {
      if (outcome.failure !== undefined) {
        feedbackToast.error(failureMessage(outcome.failure));
      }
      if (outcome.failure === "notAMember") {
        onRefresh();
      }
    }
  }

  return (
    <EmptyState
      actions={
        <>
          <Button render={<Link search={{ new: 1, slug }} to="/bookmarks" />}>
            <PlusIcon aria-hidden="true" />
            {t("go.notFound.create")}
          </Button>
          {otherWorkspaces.map((workspace) => (
            <Button
              className="h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-start"
              disabled={pending}
              key={workspace.id}
              loading={pending && target === workspace.id}
              onClick={() => {
                void switchAndContinue(workspace);
              }}
              variant="outline"
            >
              {t("go.notFound.switch", { workspace: workspace.name })}
            </Button>
          ))}
        </>
      }
      description={t("go.notFound.description")}
      headingLevel={1}
      icon={<CompassIcon aria-hidden="true" />}
      title={t("go.notFound.title", { slug, workspace: workspaceName ?? t("go.notFound.thisWorkspace") })}
    />
  );
}
