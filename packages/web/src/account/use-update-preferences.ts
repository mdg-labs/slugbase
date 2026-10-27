import { hashKey, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ME_QUERY_KEY, withAccount, type Account, type Me, type PreferenceChanges } from "./me.ts";

const PREFERENCE_KEYS = ["theme", "accent", "defaultView", "singleKeyShortcuts", "signinAlerts", "aiOptOut", "analyticsConsent", "onboarding"] as const;

/** The account as it looks once the changes are saved; the onboarding keys given are merged into the stored ones. */
function applied(account: Account, changes: PreferenceChanges): Account {
  return {
    ...account,
    ...changes,
    onboarding: { ...account.onboarding, ...changes.onboarding },
  };
}

interface Saves {
  /** What the server last confirmed; every change that fails goes back to this, never to another change's unsaved value. */
  confirmed: Account | undefined;
  /** The changes made and not yet answered, oldest first. */
  pending: PreferenceChanges[];
}

const saves = new WeakMap<QueryClient, Saves>();

function savesOf(queryClient: QueryClient): Saves {
  let state = saves.get(queryClient);
  if (state === undefined) {
    state = { confirmed: undefined, pending: [] };
    saves.set(queryClient, state);
    keepPendingShown(queryClient, state);
  }
  return state;
}

/**
 * An account the cache receives from a read (a refetch on focus, a late observer, an invalidation) is what
 * the server held when it answered, so while saves are pending it becomes the confirmed account and the
 * pending changes are laid over it again. Writes made by the saves themselves are manual and left alone.
 */
function keepPendingShown(queryClient: QueryClient, state: Saves): void {
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual === true) {
      return;
    }
    if (state.pending.length === 0 || event.query.queryHash !== hashKey(ME_QUERY_KEY)) {
      return;
    }
    const read = (event.action.data as Me | undefined)?.account;
    if (read === undefined) {
      return;
    }
    state.confirmed = read;
    show(queryClient, state);
  });
}

/** `base` with its preference fields set to the confirmed account's with every change still pending laid over. */
function shown(base: Account, { confirmed, pending }: Saves): Account {
  if (confirmed === undefined) {
    return base;
  }
  const expected = pending.reduce(applied, confirmed);
  const next = { ...base };
  for (const key of PREFERENCE_KEYS) {
    Object.assign(next, { [key]: expected[key] });
  }
  return next;
}

function settle(state: Saves, changes: PreferenceChanges): void {
  const index = state.pending.indexOf(changes);
  if (index !== -1) {
    state.pending.splice(index, 1);
  }
}

function show(queryClient: QueryClient, state: Saves, base?: Account): void {
  queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) => (me === undefined ? me : withAccount(me, shown(base ?? me.account, state))));
}

/**
 * Saves a change of the account's preferences. The change shows at once, in the cached account that the
 * theme, the accent, the shortcuts and the preferences page read, and is taken back when the server refuses
 * it or cannot be reached; a failure is raised as a toast by the app's mutation handler. Changes are sent one
 * after the other, so the last one made is the one the server keeps.
 */
export function useUpdatePreferences() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["account", "preferences"],
    scope: { id: "account-preferences" },
    mutationFn: async (changes: PreferenceChanges): Promise<Account> => {
      const { data, error } = await router.options.context.api.PATCH("/api/v1/me", { body: changes });
      if (data === undefined) {
        throw new Error("The preferences update did not answer with an account", { cause: error });
      }
      return data;
    },
    onMutate: async (changes) => {
      await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY });
      const state = savesOf(queryClient);
      if (state.pending.length === 0) {
        state.confirmed = queryClient.getQueryData<Me>(ME_QUERY_KEY)?.account;
      }
      state.pending.push(changes);
      show(queryClient, state);
      return { changes };
    },
    onError: (_error, _changes, context) => {
      const state = savesOf(queryClient);
      if (context !== undefined) {
        settle(state, context.changes);
      }
      show(queryClient, state);
    },
    onSuccess: (saved, _changes, context) => {
      const state = savesOf(queryClient);
      settle(state, context.changes);
      state.confirmed = saved;
      show(queryClient, state, saved);
    },
  });
}
