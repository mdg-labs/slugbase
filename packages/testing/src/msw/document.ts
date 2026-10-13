// The part of an OpenAPI 3.1 document the mock reads: its operations and the
// response schemas they declare (doc 08 section 7).

type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components?: Readonly<Record<string, unknown>>;
}

export type HttpMethod = "get" | "put" | "post" | "delete" | "patch" | "head" | "options";
const HTTP_METHODS: readonly string[] = ["get", "put", "post", "delete", "patch", "head", "options"];

export interface DeclaredResponse {
  readonly status: number;
  /** Media type to schema, in document order. A response without a body has none. */
  readonly content: ReadonlyMap<string, unknown>;
  readonly headers: ReadonlyMap<string, unknown>;
}

export interface DocumentOperation {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** The path template of the document, such as `/api/v1/bookmarks/{bookmarkId}`. */
  readonly path: string;
  readonly responses: readonly DeclaredResponse[];
}

export function describe(operation: Pick<DocumentOperation, "operationId" | "method" | "path">): string {
  return `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path})`;
}

export function parseDocument(value: unknown): OpenApiDocument {
  if (!isRecord(value) || typeof value.openapi !== "string" || !isRecord(value.paths)) {
    throw new Error("The value is not an OpenAPI document: it needs an `openapi` version and `paths`");
  }
  return value as unknown as OpenApiDocument;
}

function resolveReference(document: OpenApiDocument, reference: string): unknown {
  if (!reference.startsWith("#/")) {
    throw new Error(`Reference ${reference} points outside the document`);
  }
  let node: unknown = document;
  for (const segment of reference.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(node) || !(key in node)) {
      throw new Error(`Reference ${reference} does not resolve inside the document`);
    }
    node = node[key];
  }
  return node;
}

/** Follows a `$ref` chain to the object it names; a value without `$ref` is returned as it is. */
export function dereference(document: OpenApiDocument, value: unknown): unknown {
  let current = value;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) {
      throw new Error(`Reference ${current.$ref} refers to itself`);
    }
    seen.add(current.$ref);
    current = resolveReference(document, current.$ref);
  }
  return current;
}

function declaredResponses(document: OpenApiDocument, operation: string, value: unknown): DeclaredResponse[] {
  if (!isRecord(value)) {
    throw new Error(`${operation} declares no responses`);
  }
  const responses: DeclaredResponse[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[1-5]\d\d$/.test(key)) {
      throw new Error(`${operation} declares the response key "${key}"; the mock reads exact status codes only`);
    }
    const response = dereference(document, raw);
    if (!isRecord(response)) {
      throw new Error(`${operation} declares response ${key} that is not an object`);
    }
    const content = new Map<string, unknown>();
    if (isRecord(response.content)) {
      for (const [mediaType, media] of Object.entries(response.content)) {
        content.set(mediaType, isRecord(media) ? media.schema : undefined);
      }
    }
    const headers = new Map<string, unknown>();
    if (isRecord(response.headers)) {
      for (const [name, header] of Object.entries(response.headers)) {
        const resolved = dereference(document, header);
        headers.set(name, isRecord(resolved) ? resolved.schema : undefined);
      }
    }
    responses.push({ status: Number(key), content, headers });
  }
  return responses.sort((a, b) => a.status - b.status);
}

/** Every operation of the document. An operation the mock cannot read is an error, never skipped. */
export function listOperations(document: OpenApiDocument): DocumentOperation[] {
  const operations: DocumentOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isRecord(item)) {
      throw new Error(`Path ${path} is not an object`);
    }
    for (const key of Object.keys(item)) {
      const isMethod = HTTP_METHODS.includes(key);
      if (key === "trace") {
        throw new Error(`${path} declares a trace operation; the mock has no handler for that method`);
      }
      if (!isMethod || !isRecord(item[key])) {
        continue;
      }
      const method = key as HttpMethod;
      const operation = item[key];
      const label = `${method.toUpperCase()} ${path}`;
      if (typeof operation.operationId !== "string" || operation.operationId === "") {
        throw new Error(`${label} has no operationId`);
      }
      if (seen.has(operation.operationId)) {
        throw new Error(`operationId ${operation.operationId} is used twice`);
      }
      seen.add(operation.operationId);
      operations.push({
        operationId: operation.operationId,
        method,
        path,
        responses: declaredResponses(document, label, operation.responses),
      });
    }
  }
  return operations;
}
