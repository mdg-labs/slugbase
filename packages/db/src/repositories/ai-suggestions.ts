import { and, eq, gt, sql } from "drizzle-orm";
import { aiSuggestionUsage, aiSuggestions, type StoredAiSuggestion } from "../schema/ai.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";
import { lockTaggingOwner } from "./tag-links.ts";

// The cache of AI suggestions and the count of accepted fields of the active workspace (doc 05 section 2.8, doc 02 section 14, doc 10 T1 and T11). Both
// tables are a member's own in the workspace: the policies name the workspace and the account of the transaction (src/sql/690-ai-suggestions.sql), and every
// statement below names both too, so the application and the database each keep another member's rows, and another workspace's, out of an answer.
// `slugbase_app` may read the cache, insert a row and replace the result of one; it never deletes, and `retention.purge` deletes a row after `expires_at`. A
// row is current until `expires_at`, which the database clock sets 30 days after the suggestion was cached and judges (`now()`), so no application clock
// decides whether a result is still good. The usage rows are inserted and read, never changed.

const suggestions = defineScopedRepository("ai_suggestions", aiSuggestions, {
  methods: ["select", "insert", "update"],
  updateColumns: ["result", "provider", "model", "createdAt", "expiresAt"],
});

const usage = defineScopedRepository("ai_suggestion_usage", aiSuggestionUsage, {
  methods: ["select", "insert"],
  insertColumns: ["id", "accountId", "bookmarkId", "fieldsUsed"],
});

/** How long a cached suggestion is current, in days (doc 02 section 14). */
const AI_SUGGESTION_LIFETIME_DAYS = 30;

const USAGE_FIELDS: readonly string[] = ["title", "slug", "tags"];

/** What the cache holds for one key: the suggestion and what answered it. */
export interface AiSuggestionRecord {
  readonly result: StoredAiSuggestion;
  readonly provider: string;
  readonly model: string;
}

export interface AiSuggestionRepository {
  /**
   * The suggestion cached for the canonical URL and the language for the account of the transaction in the workspace of the transaction, when it has
   * not expired by the database clock; undefined otherwise. Another member's row, and another workspace's, is never visible. Needs a transaction opened with a workspace.
   */
  current(urlCanonical: string, locale: string): Promise<AiSuggestionRecord | undefined>;
  /**
   * Caches the suggestion for the key, replacing an earlier one, with `created_at` and `expires_at` from the database clock. Both tables name the membership of the
   * account through a foreign key, so the workspace row and then the membership row are locked first (`holdMember`); answers false, and writes nothing, when the account is
   * no member of the workspace any more. Needs a transaction opened with a workspace.
   */
  store(entry: { readonly urlCanonical: string; readonly locale: string } & AiSuggestionRecord): Promise<boolean>;
  /**
   * Locks the workspace row and then the membership row of the account of the transaction (`FOR KEY SHARE`), the order every departure takes them in
   * (src/repositories/tag-links.ts has the order of the locks), and answers whether both exist. A caller that holds a bookmark of the account and then inserts a count takes
   * them first, because the insert takes the membership row through its foreign key. False means the workspace is gone or the account has left it. Needs a transaction opened with a workspace.
   */
  holdMember(): Promise<boolean>;
  /**
   * Counts that the fields `fields` (one to three of `title`, `slug` and `tags`, without repeats) of a bookmark the account of the transaction saved came from a suggestion: one
   * row of the workspace of the transaction, naming `bookmarkId` and holding no content. Fields outside that list are refused before any statement, so the row cannot be refused by
   * the table's check and end the transaction of the save it belongs to. Needs a transaction opened with a workspace.
   */
  recordUsage(request: { readonly id: string; readonly bookmarkId: string | null; readonly fields: readonly string[] }): Promise<void>;
}

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the AI suggestions of a workspace need a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

export function aiSuggestionRepository(tx: TenantTx): AiSuggestionRepository {
  const cache = suggestions.bind(tx);
  const counts = usage.bind(tx);
  return {
    async current(urlCanonical, locale) {
      const [row] = await cache.select(
        and(eq(aiSuggestions.accountId, tx.accountId), eq(aiSuggestions.urlCanonical, urlCanonical), eq(aiSuggestions.locale, locale), gt(aiSuggestions.expiresAt, sql`now()`)),
      );
      return row === undefined ? undefined : { result: row.result, provider: row.provider, model: row.model };
    },

    async holdMember() {
      requireWorkspace(tx);
      return lockTaggingOwner(tx, tx.accountId);
    },

    async store({ urlCanonical, locale, result, provider, model }) {
      const workspaceId = requireWorkspace(tx);
      if (!(await lockTaggingOwner(tx, tx.accountId))) {
        return false;
      }
      const written = {
        result,
        provider,
        model,
        createdAt: sql`now()`,
        expiresAt: sql`now() + ${AI_SUGGESTION_LIFETIME_DAYS}::integer * interval '1 day'`,
      };
      await tenantHandle(tx)
        .insert(aiSuggestions)
        .values({ workspaceId, accountId: tx.accountId, urlCanonical, locale, ...written })
        .onConflictDoUpdate({ target: [aiSuggestions.workspaceId, aiSuggestions.accountId, aiSuggestions.urlCanonical, aiSuggestions.locale], set: written });
      return true;
    },

    async recordUsage({ id, bookmarkId, fields }) {
      requireWorkspace(tx);
      if (fields.length < 1 || new Set(fields).size !== fields.length || fields.some((field) => !USAGE_FIELDS.includes(field))) {
        throw new RangeError("the count of accepted fields names one to three of title, slug and tags, each once");
      }
      await counts.insert({ id, accountId: tx.accountId, bookmarkId, fieldsUsed: [...fields] });
    },
  };
}
