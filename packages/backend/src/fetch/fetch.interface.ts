export type FetchMethod = "GET" | "HEAD";

export interface FetchRequestOptions {
  method?: FetchMethod;
  headers?: Readonly<Record<string, string>>;
  skipCache?: boolean;
}

export interface FetchResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  url: string;
}

export interface FetchPort {
  get(url: string, options?: Omit<FetchRequestOptions, "method">): Promise<FetchResponse>;
  fetch(url: string, options?: FetchRequestOptions): Promise<FetchResponse>;
}
