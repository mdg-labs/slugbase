import { suggestBookmarkDetails as suggestBookmarkDetailsOperation } from "@slugbase/contracts";
import { suggestWithAi, type AiSuggestPort, type AiSuggestionStore, type AiUsageRecorder } from "@slugbase/core";
import { accountProfileRepository, aiSuggestionRepository, bookmarkRepository, tagRepository, workspaceRepository, type TenantTx } from "@slugbase/db";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { route } from "../register.ts";

// POST /api/v1/ai/suggestions (doc 04 sections 7 and 10.8, doc 02 section 14, doc 05 section 2.8, doc 10 T1, T11 and T13). The chain has decided, before this handler runs, who may
// call it: a member by a session or a token of the write scope, and the `ai.suggestions` entitlement of the workspace (stage 9, `403 entitlement_required`; an entitlement source that
// fails ends the request, never with a grant). Stage 6 has taken the request from the `ai` bucket (60 an hour for the account, 600 an hour for the workspace) before the handler and so
// before the cache is read: a request that is answered from the cache takes a token too, so a member cannot spend provider calls past the bucket by any mix of hits and misses.
//
// The handler then asks `suggestWithAi` for the rest, in this order and each before any call to the provider: no AI port configured is `503 ai_unavailable`; the workspace toggle
// off, or the member opted out, is `403 forbidden`; a URL that is not an http or https URL is `422 url_not_allowed` and a malformed one `422 validation_failed`. The settings are read
// in a transaction of their own, together with the cache and the names of the member's own tags, and an error reading them ends the request. The cache of the member (src/repositories/ai-suggestions.ts)
// is keyed by the workspace, the member, the canonical URL and the language and the policy of its table names the member and the workspace, so no other member and no other workspace
// is ever served a row. The provider is asked with no transaction open, for at most five seconds; a failure, a timeout and an answer that does not pass the checks are
// `502 upstream_failed` and are not cached. The suggestion is returned and nothing else is written for it: no bookmark, slug or tag is created or changed.

const NO_WORKSPACE = "No such resource.";
const AI_UNAVAILABLE = "AI suggestions are not available on this instance.";
const AI_WORKSPACE_DISABLED = "AI suggestions are turned off for this workspace.";
const AI_MEMBER_OPTED_OUT = "You have opted out of AI suggestions.";
const URL_NOT_ALLOWED = "Only http and https URLs can be saved as a bookmark.";
const URL_INVALID = "The URL is not valid.";
const UPSTREAM_FAILED = "The suggestion could not be made.";
const URL_FIELD_CODES = { empty: "too_small", too_long: "too_big", malformed: "invalid_url" } as const;

export interface AiRoutesOptions {
  /** The AI port; the unconfigured one is `available: false` and answers `503 ai_unavailable`. */
  readonly ai: AiSuggestPort;
  /** What the cache records as the provider and the model that answered: the operator's display name and model of the endpoint. */
  readonly provider: string;
  readonly model: string;
  /** The time the provider is given, in milliseconds; five seconds when left out. */
  readonly budgetMs?: number;
}

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** The core store over the repositories of the open transaction. */
function storeOf(tx: TenantTx): AiSuggestionStore {
  const cache = aiSuggestionRepository(tx);
  return {
    async availability() {
      const settings = await workspaceRepository(tx).settings();
      const profile = await accountProfileRepository(tx).profile();
      return settings === undefined || profile === undefined ? undefined : { workspaceEnabled: settings.aiEnabled, memberOptedOut: profile.aiOptOut };
    },
    async tagNames(limit) {
      const tags = await tagRepository(tx).list({ ownerId: tx.accountId, sort: "name", after: undefined, limit });
      return tags.map((tag) => tag.name);
    },
    async cached(urlCanonical, locale) {
      return (await cache.current(urlCanonical, locale))?.result;
    },
    cache: ({ urlCanonical, locale, result, provider, model }) => cache.store({ urlCanonical, locale, result, provider, model }),
    slugTaken: async (slug) => (await bookmarkRepository(tx).slugUse({ slug, ownerId: tx.accountId, exceptBookmarkId: undefined })).takenByOwner,
  };
}

/**
 * Counts the fields a save took from a suggestion in the transaction of the save (doc 02 section 14). The client's claim is not checked against a suggestion
 * and no AI setting is read, so naming fields never refuses a save; the fields reach the table only after the repository has checked them.
 */
export function aiUsageOf(tx: TenantTx): AiUsageRecorder {
  const cache = aiSuggestionRepository(tx);
  return {
    hold: () => cache.holdMember(),
    async record({ bookmarkId, fields }) {
      await cache.recordUsage({ id: uuidv7(), bookmarkId, fields });
    },
  };
}

export function aiRoutes({ ai, provider, model, budgetMs }: AiRoutesOptions): RouteBinding[] {
  return [
    route(suggestBookmarkDetailsOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await suggestWithAi(
        {
          ai,
          withStore: (work) => tenant.withTenant((tx) => work(storeOf(tx))),
          provider,
          model,
          ...(budgetMs === undefined ? {} : { timeoutMs: budgetMs }),
          onProviderFailure: (error) => {
            const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "unknown";
            context.get("logger")?.warn("An AI suggestion failed", { code });
          },
        },
        { url: body.url, locale: body.locale, metadata: body.metadata },
      );
      switch (outcome.kind) {
        case "suggested":
          return { status: 200, body: { ...outcome.suggestion, tags: [...outcome.suggestion.tags] } };
        case "unavailable":
          throw new ProblemError("ai_unavailable", AI_UNAVAILABLE);
        case "disabled":
          throw new ProblemError("forbidden", outcome.reason === "workspace" ? AI_WORKSPACE_DISABLED : AI_MEMBER_OPTED_OUT);
        case "not_found":
          throw new ProblemError("not_found", NO_WORKSPACE);
        case "url_refused":
          if (outcome.reason === "not_http") {
            throw new ProblemError("url_not_allowed", URL_NOT_ALLOWED, { errors: [{ path: "url", code: "url_not_allowed" }] });
          }
          throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "url", code: URL_FIELD_CODES[outcome.reason] }] });
        case "failed":
          throw new ProblemError("upstream_failed", UPSTREAM_FAILED);
      }
    }),
  ];
}
