export type ImportBookmarkInput = {
  title: string;
  url: string;
  slug?: string | null;
  forwardingEnabled?: boolean;
  pinned?: boolean;
  folders?: string[];
  tags?: string[];
};

export type ImportResult = {
  total: number;
  successCount: number;
  failureCount: number;
  skippedSlugCount: number;
  capLimitedCount: number;
};
