import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { ME_QUERY_KEY, type Me } from "../account/me.ts";

export type WorkspaceList = ComponentTypes["schemas"]["WorkspaceList"];
export type WorkspaceSummary = ComponentTypes["schemas"]["WorkspaceSummary"];

export const WORKSPACES_QUERY_KEY = ["workspaces"] as const;

/** The account's workspaces, the most recently active first, and whether it can create another. */
export function workspacesQuery(api: ApiClient) {
  return queryOptions({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: async (): Promise<WorkspaceList> => {
      const { data, error } = await api.GET("/api/v1/workspaces");
      if (data === undefined) {
        throw new Error("The workspaces request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/** Creates a workspace with the account as its owner. The account's active workspace does not change. */
export async function createWorkspace(api: ApiClient, name: string, signal: AbortSignal): Promise<WorkspaceSummary> {
  const { data, error } = await api.POST("/api/v1/workspaces", { body: { name }, signal });
  if (data === undefined) {
    throw new Error("The workspace creation did not answer with a document", { cause: error });
  }
  return data;
}

async function setActiveWorkspace(api: ApiClient, workspaceId: string): Promise<void> {
  const { response, error } = await api.PUT("/api/v1/session/active-workspace", { body: { workspaceId } });
  if (!response.ok || error !== undefined) {
    throw new Error("The workspace switch did not answer with a success", { cause: error });
  }
}

/** The cached account with the workspace added to its memberships as the owner, so everything that reads the account lists it. */
export function addMembership(queryClient: QueryClient, workspace: WorkspaceSummary): void {
  queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) =>
    me === undefined || me.memberships.some(({ workspaceId }) => workspaceId === workspace.id)
      ? me
      : { ...me, memberships: [...me.memberships, { workspaceId: workspace.id, name: workspace.name, role: workspace.role }] },
  );
  void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
}

/** Why a switch did not go through, as far as the member is told. */
export type SwitchFailure = "notAMember" | "unavailable";

/** The sentence for a failed switch, in the language of the page. */
export function useSwitchFailureMessage(): (failure: SwitchFailure) => string {
  const { t } = useTranslation();
  return (failure) => (failure === "notAMember" ? t("workspaces.switch.failed.notAMember") : t("workspaces.switch.failed.unavailable"));
}

export type SwitchOutcome =
  | { readonly status: "switched" }
  /** The server did not switch; the session keeps its workspace. Undefined for an ended session, which the app answers as a whole. */
  | { readonly status: "failed"; readonly failure: SwitchFailure | undefined }
  /** A switch was already under way, so nothing was sent. */
  | { readonly status: "skipped" };

export interface WorkspaceSwitch {
  /** Whether a switch is under way. */
  readonly pending: boolean;
  /**
   * Makes the workspace the session's active one and reloads the data of the app. The cached account takes the
   * new workspace only once the server has confirmed it, so the interface never shows a workspace as active that
   * the server did not switch to.
   */
  readonly switchTo: (workspaceId: string) => Promise<SwitchOutcome>;
}

/** Switches the session's active workspace. Only one switch runs at a time. */
export function useWorkspaceSwitch(): WorkspaceSwitch {
  const router = useRouter();
  const queryClient = useQueryClient();
  const running = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const switchTo = useCallback(
    async (workspaceId: string): Promise<SwitchOutcome> => {
      if (running.current) {
        return { status: "skipped" };
      }
      running.current = true;
      setPending(true);
      try {
        await setActiveWorkspace(router.options.context.api, workspaceId);
      } catch (caught) {
        if (caught instanceof ApiProblemError && caught.status === 404) {
          // The account is no longer a member of it: the list the member chose from is out of date.
          void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
          return { status: "failed", failure: "notAMember" };
        }
        return { status: "failed", failure: isSessionEnded(caught) ? undefined : "unavailable" };
      } finally {
        running.current = false;
        if (mounted.current) {
          setPending(false);
        }
      }
      queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) => (me === undefined ? me : { ...me, activeWorkspaceId: workspaceId }));
      void queryClient.invalidateQueries();
      void router.invalidate();
      return { status: "switched" };
    },
    [queryClient, router],
  );

  return { pending, switchTo };
}
