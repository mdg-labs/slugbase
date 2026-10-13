import {
  identifiersOf,
  namesOf,
  principalsOf,
  type FixtureIdentifier,
  type FixturePrincipal,
  type PrincipalRole,
  type TenantFixture,
} from "./fixture.js";
import { kindOfParameter, PATH_PARAMETER_MAPPING, type PathParameterMapping } from "./mapping.js";
import {
  classifyOperations,
  describeOperation,
  type ClassificationSummary,
  type ClassifiedOperation,
  type InputLocation,
} from "./openapi.js";
import type { MatrixFailure } from "./report.js";

// API mode of the cross-tenant matrix (doc 08 section 3.3, D8): every principal
// of workspace A attempts every tenant-scoped operation against every
// identifier workspace B holds. Each attempt must not quote anything of B and
// must leave the row-level checksum of B unchanged, and answers by role:
//
//   at or above the policy   404 (never 403: existence is not disclosed)
//   below the policy         403, the refusal of stage 9 of the chain, which
//                            comes before any lookup and so discloses nothing
//
// The policy is the operation's `x-slugbase-auth` level: `member`, `admin` or
// `owner`. A principal of workspace A below it never reaches the handler, so a
// 404 is asserted exactly where a lookup happens.

const ROLE_RANK: Readonly<Record<PrincipalRole, number>> = { member: 1, admin: 2, owner: 3 };

/** The status the chain answers a principal of workspace A for a row of workspace B, by the policy of the operation. */
function expectedStatus(policy: string, role: PrincipalRole): number {
  const required = Object.hasOwn(ROLE_RANK, policy) ? ROLE_RANK[policy as PrincipalRole] : undefined;
  // A policy outside the tenant-scoped ones does not reach here; it is held to the stricter answer.
  return required !== undefined && ROLE_RANK[role] < required ? 403 : 404;
}

/** One request the matrix makes. */
export interface ApiCall {
  readonly operation: ClassifiedOperation;
  readonly principal: FixturePrincipal;
  /** The path with the parameters substituted. */
  readonly url: string;
  /** Path parameter to the workspace B identifier substituted for it. */
  readonly targets: Readonly<Record<string, string>>;
  /**
   * The identifier-carrying query inputs, by parameter name, holding an
   * identifier of B; an array input holds one. Already in `url`.
   */
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /**
   * The JSON body holding an identifier of B at every identifier-carrying
   * input of the operation, and nothing else: the request function completes
   * whatever else a valid request needs. Undefined when the operation takes no
   * such body input.
   */
  readonly body: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body?: unknown;
}

/** Sends a call as its principal. The contract tests of `@slugbase/server` give it a request function that talks to an in-process `createServer`, so the matrix runs over the real chain. */
export type RequestFunction = (call: ApiCall) => Promise<ApiResponse>;

export interface ApiMatrixOptions {
  /** The OpenAPI document, parsed. */
  readonly document: unknown;
  readonly fixture: TenantFixture;
  readonly request: RequestFunction;
  /**
   * Input name to the kind of fixture identifier it takes: path parameters,
   * and the query and body inputs the classifier found (their names are in
   * `ClassifiedOperation.inputs`).
   */
  readonly mapping?: PathParameterMapping;
}

export interface ApiMatrixReport {
  readonly classified: ClassificationSummary;
  /** Requests made. */
  readonly attempts: number;
  readonly failures: readonly MatrixFailure[];
}

function failure(subject: string, kind: string, detail: string): MatrixFailure {
  return { mode: "api", subject, kind, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function substitute(path: string, targets: Readonly<Record<string, string>>): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(targets[name] ?? ""));
}

interface Target {
  /** The path parameter name, or the name of the input. */
  readonly name: string;
  readonly location: "path" | InputLocation;
  readonly segments: readonly string[];
  readonly candidates: readonly FixtureIdentifier[];
}

function product(targets: readonly Target[]): Map<Target, string>[] {
  let combinations: Map<Target, string>[] = [new Map<Target, string>()];
  for (const target of targets) {
    combinations = combinations.flatMap((combination) =>
      target.candidates.map((candidate) => new Map(combination).set(target, candidate.id)),
    );
  }
  return combinations;
}

/** Sets `value` at `segments` of a JSON value, where `[]` is the first item of an array; shared prefixes are merged. */
function place(root: unknown, segments: readonly string[], value: string): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return value;
  }
  if (head === "[]") {
    const items = Array.isArray(root) ? (root as unknown[]) : [];
    items[0] = place(items[0], rest, value);
    return items;
  }
  const object = typeof root === "object" && root !== null && !Array.isArray(root) ? (root as Record<string, unknown>) : {};
  object[head] = place(object[head], rest, value);
  return object;
}

function queryString(query: Readonly<Record<string, string | readonly string[]>>): string {
  const pairs = Object.entries(query).flatMap(([name, value]) =>
    (typeof value === "string" ? [value] : value).map((item) => `${encodeURIComponent(name)}=${encodeURIComponent(item)}`),
  );
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/** The query and body of a call carrying the chosen identifiers; path targets are handled apart. */
function carry(combination: ReadonlyMap<Target, string>): {
  query: Record<string, string | readonly string[]>;
  body: unknown;
} {
  const query: Record<string, string | readonly string[]> = {};
  let body: unknown;
  for (const [target, id] of combination) {
    if (target.location === "query") {
      const name = target.segments[0] ?? target.name;
      query[name] = target.segments.length > 1 ? [id] : id;
    } else if (target.location === "body") {
      body = place(body, target.segments, id);
    }
  }
  return { query, body };
}

function bodyText(body: unknown): string {
  if (body === undefined) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  // JSON.stringify answers undefined for a value JSON cannot hold.
  const serialized = JSON.stringify(body) as string | undefined;
  return serialized ?? "";
}

/** The names of B that the response quotes, apart from the ones the request itself carried. */
function leakedNames(body: unknown, names: readonly string[], request: string): string[] {
  const requestUrl = request.toLowerCase();
  const candidates = names.filter((name) => name !== "");
  const requested = candidates.filter((name) => requestUrl.includes(name.toLowerCase()));
  // A problem document may repeat the path it answered for.
  let text = bodyText(body).toLowerCase();
  for (const name of requested) {
    text = text.split(name.toLowerCase()).join(" ");
  }
  return candidates.filter((name) => !requested.includes(name) && text.includes(name.toLowerCase()));
}

export async function runApiMatrix(options: ApiMatrixOptions): Promise<ApiMatrixReport> {
  const mapping = options.mapping ?? PATH_PARAMETER_MAPPING;
  const { fixture, request } = options;
  const classification = classifyOperations(options.document);
  const failures: MatrixFailure[] = classification.problems.map((problem) =>
    failure(problem.subject, "unclassified_operation", problem.detail),
  );
  const names = namesOf(fixture.b);
  let attempts = 0;
  let baseline = await fixture.checksum(fixture.b.id);

  for (const operation of classification.operations) {
    if (operation.kind !== "tenant-scoped") {
      continue;
    }
    const subject = describeOperation(operation);
    const wanted: { name: string; location: Target["location"]; segments: readonly string[] }[] = [
      ...operation.pathParameters.map((name) => ({ name, location: "path" as const, segments: [name] })),
      ...operation.inputs.map(({ name, location, segments }) => ({ name, location, segments })),
    ];
    const targets: Target[] = [];
    let mappable = true;
    for (const reason of operation.unwalkable) {
      failures.push(failure(subject, "unwalkable_input", `${reason}; it cannot be said which identifiers of workspace B it takes`));
      mappable = false;
    }
    for (const { name, location, segments } of wanted) {
      const label = location === "path" ? `the path parameter "${name}"` : `the ${location} input "${name}"`;
      const kind = kindOfParameter(mapping, operation.operationId, name);
      if (kind === undefined) {
        failures.push(failure(subject, "unmapped_parameter", `${label} has no mapping to a fixture identifier`));
        mappable = false;
        continue;
      }
      const candidates = identifiersOf(fixture.b, kind);
      if (candidates.length === 0) {
        failures.push(failure(subject, "no_target", `workspace B of the fixture holds no "${kind}" identifier for ${label}`));
        mappable = false;
        continue;
      }
      targets.push({ name, location, segments, candidates });
    }
    if (!mappable) {
      continue;
    }

    const combinations = product(targets);
    for (const principal of principalsOf(fixture.a)) {
      for (const combination of combinations) {
        const pathTargets: Record<string, string> = {};
        for (const [target, id] of combination) {
          if (target.location === "path") {
            pathTargets[target.name] = id;
          }
        }
        const { query, body } = carry(combination);
        const call: ApiCall = {
          operation,
          principal,
          url: substitute(operation.path, pathTargets) + queryString(query),
          targets: pathTargets,
          query,
          body,
        };
        const where = `as ${principal.role} of A, ${call.url}`;
        attempts += 1;

        let response: ApiResponse | undefined;
        try {
          response = await request(call);
        } catch (error) {
          failures.push(failure(subject, "request_failed", `${where}: ${messageOf(error)}`));
        }

        if (response !== undefined) {
          const expected = expectedStatus(operation.policy, principal.role);
          if (targets.length > 0 && response.status !== expected) {
            const reason =
              expected === 404
                ? "a 403 discloses that the row exists"
                : `the ${operation.policy} policy refuses a ${principal.role} before any lookup`;
            failures.push(
              failure(subject, "unexpected_status", `${where}: answered ${String(response.status)}, expected ${String(expected)} (${reason})`),
            );
          }
          const leaked = leakedNames(response.body, names, `${decodeURIComponent(call.url)} ${bodyText(call.body)}`);
          if (leaked.length > 0) {
            failures.push(failure(subject, "leaked_name", `${where}: the response names ${leaked.join(", ")} of workspace B`));
          }
        }

        const after = await fixture.checksum(fixture.b.id);
        if (after !== baseline) {
          failures.push(failure(subject, "workspace_changed", `${where}: the row-level checksum of workspace B changed`));
          baseline = after;
        }
      }
    }
  }

  return { classified: classification.summary, attempts, failures };
}
