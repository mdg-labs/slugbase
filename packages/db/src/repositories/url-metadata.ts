import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { urlMetadata, type UrlMetadataStatus } from "../schema/url-metadata.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";

// The cache of page metadata of the active workspace (doc 05 section 2.7, doc 02 section 5.4, doc 10 section 5 and T1). The cache is per
// workspace: the policy of `url_metadata` names the workspace of the transaction (src/sql/620-url-metadata.sql) and every statement below names it
// too, so one workspace never reads, replaces or expires another's row for the same URL. `slugbase_app` may read the table, insert a row and update
// the columns of a result; it never deletes, and `retention.purge` deletes a row after `expires_at`. A row is current until `expires_at`, which the
// database clock sets seven days after `fetched_at` and judges (`now()`), so no application clock decides whether a result is still good.

const scoped = defineScopedRepository("url_metadata", urlMetadata, {
  methods: ["select", "insert", "update"],
  updateColumns: ["status", "title", "description", "siteName", "canonicalUrl", "language", "fetchedAt", "expiresAt"],
});

/** How long a result is current, in days (doc 02 section 5.4). */
const URL_METADATA_LIFETIME_DAYS = 7;

/** The fields of a page, already plain text cut to the limits of the table; null for one the page did not give. */
export interface UrlMetadataFields {
  readonly title: string | null;
  readonly description: string | null;
  readonly siteName: string | null;
  /** The page's own canonical link, kept as text and never fetched. */
  readonly canonicalUrl: string | null;
  readonly language: string | null;
}

/** What the fetch of one URL ended as. `failed` and `blocked` hold no field. */
export type UrlMetadataResult =
  | ({ readonly status: "ok" } & UrlMetadataFields)
  | { readonly status: "failed" | "blocked" };

export interface UrlMetadataRecord extends UrlMetadataFields {
  readonly urlCanonical: string;
  readonly status: UrlMetadataStatus;
  readonly fetchedAt: Date;
  readonly expiresAt: Date;
}

export interface UrlMetadataRepository {
  /**
   * The canonical URL of the bookmark with that identifier in the workspace of the transaction, among the bookmarks its account can read;
   * undefined when there is none or it is plan-archived. Only reads; a bookmark is never changed. Needs a transaction opened with a workspace.
   */
  bookmarkUrl(bookmarkId: string): Promise<string | undefined>;
  /** The result stored for the URL in the workspace of the transaction when it has not expired by the database clock; undefined otherwise. */
  current(urlCanonical: string): Promise<UrlMetadataRecord | undefined>;
  /**
   * Stores the result for the URL in the workspace of the transaction, replacing an earlier one, with `fetched_at` and `expires_at` from the
   * database clock. Needs a transaction opened with a workspace.
   */
  store(urlCanonical: string, result: UrlMetadataResult): Promise<void>;
}

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the metadata cache of a workspace needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

export function urlMetadataRepository(tx: TenantTx): UrlMetadataRepository {
  const rows = scoped.bind(tx);
  return {
    async bookmarkUrl(bookmarkId) {
      const workspaceId = requireWorkspace(tx);
      const [row] = await tenantHandle(tx)
        .select({ urlCanonical: bookmarks.urlCanonical })
        .from(bookmarks)
        .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.id, bookmarkId), isNull(bookmarks.planArchivedAt)))
        .limit(1);
      return row?.urlCanonical;
    },

    async current(urlCanonical) {
      const [row] = await rows.select(and(eq(urlMetadata.urlCanonical, urlCanonical), gt(urlMetadata.expiresAt, sql`now()`)));
      return row;
    },

    async store(urlCanonical, result) {
      const workspaceId = requireWorkspace(tx);
      const fields: UrlMetadataFields =
        result.status === "ok" ? result : { title: null, description: null, siteName: null, canonicalUrl: null, language: null };
      const written = {
        status: result.status,
        title: fields.title,
        description: fields.description,
        siteName: fields.siteName,
        canonicalUrl: fields.canonicalUrl,
        language: fields.language,
        fetchedAt: sql`now()`,
        expiresAt: sql`now() + ${URL_METADATA_LIFETIME_DAYS}::integer * interval '1 day'`,
      };
      await tenantHandle(tx)
        .insert(urlMetadata)
        .values({ workspaceId, urlCanonical, ...written })
        .onConflictDoUpdate({ target: [urlMetadata.workspaceId, urlMetadata.urlCanonical], set: written });
    },
  };
}
