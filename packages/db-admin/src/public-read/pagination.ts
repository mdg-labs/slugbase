export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export type ParsedPagination = {
  page: number;
  limit: number;
  offset: number;
};

export function parsePagination(
  page: number | undefined,
  limit: number | undefined,
): ParsedPagination {
  const resolvedPage = Math.max(1, page ?? DEFAULT_PAGE);
  const resolvedLimit = Math.min(
    MAX_LIMIT,
    Math.max(1, limit ?? DEFAULT_LIMIT),
  );

  return {
    page: resolvedPage,
    limit: resolvedLimit,
    offset: (resolvedPage - 1) * resolvedLimit,
  };
}
