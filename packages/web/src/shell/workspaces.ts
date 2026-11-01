import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { ME_QUERY_KEY, type Me } from "../account/me.ts";
import { WORKSPACE_QUERY_KEY } from "./workspace.ts";

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
export type SwitchFailure = "notAMember" | "saving" | "unavailable";

/** The sentence for a failed switch, in the language of the page. */
export function useSwitchFailureMessage(): (failure: SwitchFailure) => string {
  const { t } = useTranslation();
  return (failure) => {
    switch (failure) {
      case "notAMember":
        return t("workspaces.switch.failed.notAMember");
      case "saving":
        return t("workspaces.switch.failed.saving");
      case "unavailable":
        return t("workspaces.switch.failed.unavailable");
    }
  };
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

/**
 * How long a write may be out before it no longer holds a switch back. A write names no workspace and the server
 * binds it to the session's workspace when it arrives, so one still on its way when the session moves can change
 * the other workspace; a write that has not answered after this long is taken as stuck, so that it cannot lock the
 * switch for the rest of the session.
 */
export const SWITCH_WRITE_WAIT_MS = 30_000;

/** Whether a write (a mutation of React Query) was started less than `SWITCH_WRITE_WAIT_MS` ago and has not answered. */
function writeIsOut(queryClient: QueryClient): boolean {
  const now = Date.now();
  return queryClient.getMutationCache().getAll().some(({ state }) => state.status === "pending" && now - state.submittedAt < SWITCH_WRITE_WAIT_MS);
}

/**
 * Switches the session's active workspace. Only one switch runs at a time, and none while a write is out: the
 * switch answers `saving` and sends nothing, and the member tries again once the write has answered. Writes that
 * are not React Query mutations are not seen, and neither are writes started after the switch request left.
 */
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
      if (writeIsOut(queryClient)) {
        return { status: "failed", failure: "saving" };
      }
      running.current = true;
      setPending(true);
      try {
        await setActiveWorkspace(router.options.context.api, workspaceId);
        // A read of the account that is still out was asked before the session moved, and its answer would put the previous workspace back.
        // A read of the workspace that is still out was asked before the session moved too, and a read with no data yet is not restarted by the
        // invalidation below, which would leave the page on its skeleton, as `useWorkspace` hides the previous workspace's document; cancelled, the invalidation starts a new read.
        await Promise.all([queryClient.cancelQueries({ queryKey: ME_QUERY_KEY }), queryClient.cancelQueries({ queryKey: WORKSPACE_QUERY_KEY, exact: true })]);
        queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) => (me === undefined ? me : { ...me, activeWorkspaceId: workspaceId }));
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
      void queryClient.invalidateQueries();
      void router.invalidate();
      return { status: "switched" };
    },
    [queryClient, router],
  );

  return { pending, switchTo };
}
