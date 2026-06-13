export interface PageMetadata {
  title: string | null;
  description: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

export interface FaviconPayload {
  body: Uint8Array;
  contentType: string;
}

export interface FetchMetadataQuery {
  url: string;
}
