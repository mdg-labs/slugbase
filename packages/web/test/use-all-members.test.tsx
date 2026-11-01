import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Me } from "../src/account/me.ts";
import { ME_QUERY_KEY } from "../src/account/me.ts";
import type { ApiClient } from "../src/api/client.ts";
import { useAllMembers } from "../src/shell/use-all-members.ts";
import { MEMBERS_QUERY_KEY } from "../src/shell/workspace-members.ts";
import { ACCOUNT_BODY, WORKSPACE_ID } from "./support.tsx";
import { GRACE, OTHER_WORKSPACE_ID, SELF, type TestMember } from "./workspace-settings-server.ts";

// The hook reads the router only for the API client, so a router that holds one stands in for the application's.
const routerApi: { current: ApiClient | undefined } = { current: undefined };
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ options: { context: { api: routerApi.current } } }),
}));

const HEDY: TestMember = { ...GRACE, accountId: "0192f3a0-bbbb-7000-8000-000000000003", displayName: "Hedy Lamarr", email: "hedy@example.org" };

type Respond = (items: readonly TestMember[], nextCursor: string | null) => void;

function meIn(workspaceId: string): Me {
  return { account: ACCOUNT_BODY, memberships: [{ workspaceId, name: "Workspace", role: "owner" }], activeWorkspaceId: workspaceId };
}

/** A members endpoint that answers one member a page, from the list of the workspace the account acts in, unless a read is held. */
function setup(lists: Readonly<Record<string, readonly TestMember[]>>, initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(ME_QUERY_KEY, meIn(initial));
  const held: Respond[] = [];
  const state = { holding: false };
  const get = vi.fn((_path: string, init: { params: { query: { cursor?: string } }; signal?: AbortSignal }) => {
    const list = lists[client.getQueryData<Me>(ME_QUERY_KEY)?.activeWorkspaceId ?? ""] ?? [];
    const start = Number(init.params.query.cursor ?? 0);
    const answer = (items: readonly TestMember[], nextCursor: string | null) => ({ data: { items, nextCursor } });
    if (state.holding) {
      return new Promise((resolve) => {
        held.push((items, nextCursor) => {
          resolve(answer(items, nextCursor));
        });
      });
    }
    return Promise.resolve(answer(list.slice(start, start + 1), start + 1 < list.length ? String(start + 1) : null));
  });
  routerApi.current = { GET: get } as unknown as ApiClient;
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useAllMembers(), { wrapper });
  return { client, held, state, hook };
}

describe("useAllMembers", () => {
  it("reaches complete on a cold cache with one member to a page", async () => {
    const { hook } = setup({ [WORKSPACE_ID]: [SELF, GRACE, HEDY] }, WORKSPACE_ID);
    expect(hook.result.current.complete).toBe(false);
    await waitFor(() => {
      expect(hook.result.current.complete).toBe(true);
    });
    expect(hook.result.current.members.map((member) => member.displayName)).toEqual(["Ada Lovelace", "Grace Hopper", "Hedy Lamarr"]);
  });

  it("reports no member and not complete while the read made after a switch is held, then the new workspace's members", async () => {
    const { client, held, state, hook } = setup({ [WORKSPACE_ID]: [SELF, GRACE], [OTHER_WORKSPACE_ID]: [HEDY] }, WORKSPACE_ID);
    await waitFor(() => {
      expect(hook.result.current.complete).toBe(true);
    });
    expect(hook.result.current.members).toHaveLength(2);

    state.holding = true;
    await act(async () => {
      client.setQueryData(ME_QUERY_KEY, meIn(OTHER_WORKSPACE_ID));
      void client.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(held.length).toBeGreaterThan(0);
    });
    expect(hook.result.current.members).toEqual([]);
    expect(hook.result.current.complete).toBe(false);

    state.holding = false;
    await act(async () => {
      for (const respond of held.splice(0)) {
        respond([HEDY], null);
      }
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hook.result.current.complete).toBe(true);
    });
    expect(hook.result.current.members.map((member) => member.displayName)).toEqual(["Hedy Lamarr"]);
  });
});
