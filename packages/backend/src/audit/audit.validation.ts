export const DEFAULT_AUDIT_PAGE_SIZE = 24;
export const MAX_AUDIT_PAGE_SIZE = 100;
export const MAX_AUDIT_METADATA_BYTES = 8_192;

export const AUDIT_ENTITY_TYPES = [
  "bookmark",
  "folder",
  "tag",
  "member",
  "team",
  "settings",
  "auth",
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export type AuditSort = "created-desc" | "created-asc";

export function parseAuditEntityType(
  value: string | undefined,
): AuditEntityType | undefined {
  if (value == null || value.length === 0) return undefined;
  if ((AUDIT_ENTITY_TYPES as readonly string[]).includes(value)) {
    return value as AuditEntityType;
  }
  throw new Error(`Invalid entityType: ${value}`);
}

export function parseAuditSort(sort: string | undefined): AuditSort {
  if (sort == null || sort === "created-desc") return "created-desc";
  if (sort === "created-asc") return "created-asc";
  throw new Error(`Invalid sort: ${sort}`);
}

export function parsePage(page: number | undefined): number {
  if (page == null || Number.isNaN(page)) return 1;
  return Math.max(1, Math.floor(page));
}

export function parsePageSize(pageSize: number | undefined): number {
  if (pageSize == null || Number.isNaN(pageSize)) {
    return DEFAULT_AUDIT_PAGE_SIZE;
  }
  return Math.min(MAX_AUDIT_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      sanitized[key] = value.replace(/<script>/gi, "").replace(/[<>]/g, "");
    } else if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      sanitized[key] = value;
    }
  }

  const encoded = JSON.stringify(sanitized);
  if (encoded.length > MAX_AUDIT_METADATA_BYTES) {
    throw new Error("metadata exceeds maximum size");
  }

  return sanitized;
}
