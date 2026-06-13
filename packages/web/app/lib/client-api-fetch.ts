import { resolveFetchBase } from "./client-api-path.js";

export type JsonHeaders = Record<string, string>;

export async function fetchCsrfHeaders(request?: Request): Promise<JsonHeaders> {
  const cookie = request?.headers.get("Cookie") ?? "";
  const res = await fetch(`${resolveFetchBase(request)}/auth/csrf-token`, {
    headers: cookie ? { Cookie: cookie } : {},
    credentials: request ? undefined : "include",
  });
  if (!res.ok) {
    throw new Error("Failed to fetch CSRF token");
  }
  const data = (await res.json()) as { csrfToken: string };
  return {
    "Content-Type": "application/json",
    "x-csrf-token": data.csrfToken,
  };
}

export async function fetchCsrfHeadersOrEmpty(request?: Request): Promise<JsonHeaders> {
  try {
    return await fetchCsrfHeaders(request);
  } catch {
    return {};
  }
}

export type ClientFetchInit = Omit<RequestInit, "credentials"> & {
  request?: Request;
  csrf?: boolean;
};

/** Browser or server fetch against the API (same-origin or absolute base). */
export async function apiFetch(path: string, init: ClientFetchInit = {}): Promise<Response> {
  const { request, csrf = false, headers: initHeaders, ...rest } = init;
  const base = resolveFetchBase(request);
  const cookie = request?.headers.get("Cookie") ?? "";

  const headerRecord: Record<string, string> = {};
  if (csrf) {
    Object.assign(headerRecord, await fetchCsrfHeaders(request));
  }
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => {
      headerRecord[key] = value;
    });
  } else if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      headerRecord[key] = value;
    }
  } else if (initHeaders) {
    Object.assign(headerRecord, initHeaders);
  }
  if (cookie) {
    headerRecord["Cookie"] = cookie;
  }

  return fetch(`${base}${path}`, {
    ...rest,
    headers: Object.keys(headerRecord).length > 0 ? headerRecord : undefined,
    credentials: request ? undefined : "include",
  });
}

export async function serverFetchJson<T>(
  request: Request,
  path: string,
): Promise<T | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${resolveFetchBase(request)}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function parseApiErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string };
    return data.message ?? "Request failed";
  } catch {
    return "Request failed";
  }
}
