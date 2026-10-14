import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { posix, relative, resolve, sep } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");

// The boundary table of doc 09 section 2.1: the workspace packages each
// package may import. The `testing` row is the development package: it may
// import every other package, because it holds the harness code that wraps
// them. `testing-ports` holds the in-memory ports and imports no workspace
// package, so @slugbase/core can take it as a development dependency without a
// package cycle. Who may import `testing` or `testing-ports` is a separate rule,
// not a row: the testing check in checkWorkspaceImport limits both, and TESTING_ENTRIES
// lists the subpaths of other packages (such as @slugbase/db/testing) that
// follow it. Widening a row needs an edit to doc 09 first.
export const WORKSPACE_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  contracts: [],
  core: ["contracts"],
  db: ["core", "contracts"],
  adapters: ["core", "contracts", "db"],
  server: ["core", "db", "contracts"],
  web: ["contracts", "ui"],
  ui: [],
  email: [],
  testing: ["contracts", "core", "db", "adapters", "server", "web", "ui", "email", "testing-ports"],
  "testing-ports": [],
};

const TESTING = "testing";
const TESTING_PACKAGES = new Set([TESTING, "testing-ports"]);
// Subpath entries of other packages that hold test harness code. They carry the
// raw database handle and the superuser connection, so they follow the same
// rule as @slugbase/testing, and packages/testing itself wraps them.
const TESTING_ENTRIES = new Set(["db/testing"]);
const EGRESS_DIR = "packages/adapters/src/egress/";
const DB_DIR = "packages/db/";

// Node built-ins and client libraries that open connections. Only the egress
// adapter may use the HTTP ones (doc 01 section 10, T6). The socket and DNS
// built-ins, the module loader built-in (the way to `createRequire`, which
// reaches any module by a name the import rules cannot read) and the
// dynamic-load and browser-socket globals follow the same rule, except for the
// path-scoped exemptions of SOCKET_EXEMPTIONS and in test and development code.
const HTTP_BUILTINS = new Set(["http", "https", "http2"]);
const HTTP_PACKAGES = new Set([
  "undici",
  "axios",
  "node-fetch",
  "cross-fetch",
  "isomorphic-fetch",
  "got",
  "ky",
  "superagent",
  "needle",
  "request",
  "phin",
  "bent",
  "@hapi/wreck",
  "ws",
  "isomorphic-ws",
  "websocket",
  "faye-websocket",
  "socket.io-client",
  "engine.io-client",
  "eventsource",
  "@microsoft/fetch-event-source",
]);
const SOCKET_BUILTINS = new Set(["net", "tls", "dns", "dgram"]);
const LOADER_BUILTINS = new Set(["module"]);

/** Browser socket globals that Node also provides. */
export const SOCKET_GLOBALS = ["WebSocket", "WebSocketStream", "WebTransport", "EventSource"] as const;
/** The loader that reaches any built-in by a name the import rules cannot read. */
export const DYNAMIC_LOADER = "getBuiltinModule";

/** A module, or a global, that is reachable outside the egress folder only where an exemption names it. */
export interface SocketExemption {
  /** Repository-relative path of the one file the exemption covers. */
  path: string;
  /** What the file may reach: a built-in name (`net`, `module`) or a global name. */
  names: readonly string[];
  why: string;
}

/**
 * The files outside the egress folder, other than test and development code,
 * that may reach a socket, DNS or module-loader built-in. Each entry names its
 * file and the built-ins it may use; anything else in the file is still
 * reported. SMTP and the database speak their own protocols through their
 * drivers, which no source file here imports as a socket module.
 */
export const SOCKET_EXEMPTIONS: readonly SocketExemption[] = [
  {
    path: "packages/server/src/http/trusted-proxy.ts",
    names: ["net"],
    why: "classifies addresses of the trusted-proxy list and the client IP; it opens no connection",
  },
  {
    path: "packages/server/src/migrate/pgboss.ts",
    names: ["module"],
    why: "reads the pg-boss package manifest to learn its schema version; it opens no connection",
  },
];

// The database drivers and the query builder. Only packages/db may hold a raw
// database handle (doc 01 section 5.3).
const DB_PACKAGES = new Set([
  "drizzle-orm",
  "drizzle-kit",
  "postgres",
  "pg",
  "pg-pool",
  "pg-native",
  "@electric-sql/pglite",
  "mysql2",
  "better-sqlite3",
  "sqlite3",
]);

export type Area = "package" | "app" | "other";

export interface Location {
  area: Area;
  name: string;
  /** The path inside the package or app directory. */
  inner: string;
}

/** Repository-relative POSIX path of an absolute file, or undefined outside the repository. */
export function repoPath(absolute: string): string | undefined {
  const rel = relative(ROOT, absolute).split(sep).join("/");
  return rel.startsWith("..") || rel === "" ? undefined : rel;
}

export function locate(rel: string): Location {
  const match = /^(packages|apps)\/([^/]+)\/(.*)$/.exec(rel);
  if (match === null) {
    return { area: "other", name: "", inner: rel };
  }
  return { area: match[1] === "packages" ? "package" : "app", name: match[2] ?? "", inner: match[3] ?? "" };
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Test files and test folders; in an app also anything outside src/ (development tooling). */
export function isTestingContext(loc: Location): boolean {
  if (TEST_FILE.test(loc.inner)) {
    return true;
  }
  const segments = loc.inner.split("/");
  if (segments.slice(0, -1).some((segment) => segment === "test" || segment === "tests" || segment === "__tests__")) {
    return true;
  }
  return loc.area === "app" && segments[0] !== "src";
}

function builtinRoot(specifier: string): string | undefined {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const root = bare.split("/")[0] ?? bare;
  return specifier.startsWith("node:") || builtinModules.includes(bare) ? root : undefined;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const exportCache = new Map<string, ReadonlySet<string> | undefined>();

// The entry points a workspace package declares in its exports map; anything
// else is an internal (doc 09 section 3.1).
function exportedEntries(pkg: string): ReadonlySet<string> | undefined {
  if (exportCache.has(pkg)) {
    return exportCache.get(pkg);
  }
  let entries: ReadonlySet<string> | undefined;
  try {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "packages", pkg, "package.json"), "utf8")) as {
      exports?: unknown;
    };
    entries = new Set(
      typeof manifest.exports === "object" && manifest.exports !== null ? Object.keys(manifest.exports) : ["."],
    );
  } catch {
    entries = undefined;
  }
  exportCache.set(pkg, entries);
  return entries;
}

function isTestingPackage(loc: Location): boolean {
  return loc.area === "package" && loc.name === TESTING;
}

function checkWorkspaceImport(loc: Location, specifier: string): string | undefined {
  const [, target = "", ...rest] = specifier.split("/");
  const entry = rest.length === 0 ? "." : `./${rest.join("/")}`;
  const importer = `@slugbase/${loc.name}`;

  if (TESTING_PACKAGES.has(target)) {
    // packages/testing re-exports testing-ports from its src/.
    if (!isTestingContext(loc) && !(target !== TESTING && isTestingPackage(loc))) {
      return `${importer} must not import @slugbase/${target}: it is importable only from test files, test/ folders and apps/* development tooling${target === TESTING ? "" : " (and packages/testing, which re-exports it)"} (doc 09 section 2.1).`;
    }
  } else if (TESTING_ENTRIES.has(`${target}/${rest.join("/")}`) && !isTestingContext(loc) && !isTestingPackage(loc)) {
    return `${importer} must not import ${specifier}: it is importable only from test files, test/ folders, apps/* development tooling and packages/testing (doc 09 section 2.1, T1).`;
  } else if (loc.area === "package") {
    const allowed = WORKSPACE_ALLOWED[loc.name];
    if (allowed === undefined) {
      return `packages/${loc.name} is not in the boundary table of doc 09 section 2.1; add its row there and in tooling/boundaries/policy.ts before it imports a workspace package.`;
    }
    if (!allowed.includes(target)) {
      const may = allowed.length === 0 ? "no workspace package" : allowed.map((name) => `@slugbase/${name}`).join(", ");
      return `${importer} must not import @slugbase/${target}; it may import ${may} (doc 09 section 2.1).`;
    }
  } else if (WORKSPACE_ALLOWED[target] === undefined) {
    return `@slugbase/${target} is not a workspace package of the boundary table (doc 09 section 2.1).`;
  }

  const entries = exportedEntries(target);
  if (entries === undefined || !entries.has(entry)) {
    return `${specifier} is not an entry point of @slugbase/${target}; import its public entry only, never its internals (doc 09 section 3.1).`;
  }
  return undefined;
}

function checkRelativeImport(rel: string, loc: Location, specifier: string): string | undefined {
  const target = posix.normalize(posix.join(posix.dirname(rel), specifier));
  const targetLoc = locate(target);
  if (targetLoc.area !== "other" && (targetLoc.area !== loc.area || targetLoc.name !== loc.name)) {
    return `${specifier} reaches into ${targetLoc.area === "app" ? "apps" : "packages"}/${targetLoc.name}; packages import each other by package name through the boundary table, never by path (doc 09 section 2.1).`;
  }
  if (loc.area === "package" && loc.name === "contracts" && isContractsSource(loc) && targetLoc.area === "other") {
    return `${specifier} leaves packages/contracts; contracts imports nothing from the repository (doc 09 section 2.1).`;
  }
  return undefined;
}

function isContractsSource(loc: Location): boolean {
  return loc.area === "package" && loc.name === "contracts" && loc.inner.startsWith("src/") && !isTestingContext(loc);
}

/**
 * The message for an import the boundary table, the I/O bans or the testing
 * rule forbid, or undefined when the import is allowed. `rel` is the importing
 * file relative to the repository root.
 */
export function checkImport(rel: string, specifier: string): string | undefined {
  const loc = locate(rel);
  if (loc.area === "other") {
    return undefined;
  }
  if (specifier.startsWith(".")) {
    return checkRelativeImport(rel, loc, specifier);
  }

  const builtin = builtinRoot(specifier);
  const pkg = builtin ?? packageName(specifier);

  if (builtin === undefined && specifier.startsWith("@slugbase/")) {
    return checkWorkspaceImport(loc, specifier);
  }
  if (isContractsSource(loc) && (builtin !== undefined || (pkg !== "zod"))) {
    return `${specifier} is imported by packages/contracts; contracts may import zod only (doc 09 section 2.1).`;
  }
  if (loc.area === "package" && loc.name === "core") {
    const isSocket = builtin !== undefined && (SOCKET_BUILTINS.has(builtin) || HTTP_BUILTINS.has(builtin));
    if (isSocket || (builtin === undefined && (HTTP_PACKAGES.has(pkg) || DB_PACKAGES.has(pkg)))) {
      return `${specifier} is an I/O module; packages/core has no I/O imports: the network and the database sit behind its ports (doc 09 section 2.1).`;
    }
  }
  const confined = confinedModule(specifier);
  if (confined !== undefined && isHttpModule(confined) && !inEgressDir(rel)) {
    return `${specifier} is importable only inside packages/adapters/src/egress/: every outbound request goes through the egress adapter (doc 01 section 10, T6).`;
  }
  if (confined !== undefined && !isHttpModule(confined) && !networkAccessAllowed(rel, confined)) {
    return `${specifier} is importable only inside packages/adapters/src/egress/, in test and development code, and in the files SOCKET_EXEMPTIONS lists in tooling/boundaries/policy.ts: sockets, DNS and dynamic module loading stay behind the egress adapter (doc 01 section 10, T6).`;
  }
  if (builtin === undefined && DB_PACKAGES.has(pkg) && !rel.startsWith(DB_DIR)) {
    return `${specifier} is importable only inside packages/db: the raw database handle never leaves it (doc 01 section 5.3, T1).`;
  }
  return undefined;
}

/**
 * The name under which a module specifier is confined: the built-in's root
 * (`net`, `http`, `module`) or the package name; undefined for a module no rule
 * confines to the egress folder.
 */
export function confinedModule(specifier: string): string | undefined {
  const builtin = builtinRoot(specifier);
  if (builtin !== undefined) {
    return HTTP_BUILTINS.has(builtin) || SOCKET_BUILTINS.has(builtin) || LOADER_BUILTINS.has(builtin) ? builtin : undefined;
  }
  const pkg = packageName(specifier);
  return HTTP_PACKAGES.has(pkg) ? pkg : undefined;
}

/** Whether a name returned by confinedModule is an HTTP client (always egress-only, tests included). */
export function isHttpModule(name: string): boolean {
  return HTTP_BUILTINS.has(name) || HTTP_PACKAGES.has(name);
}

/**
 * Whether the file may reach a socket, DNS, module-loader or other
 * network-opening name: a built-in from SOCKET_BUILTINS or LOADER_BUILTINS,
 * `getBuiltinModule`, or a browser socket global. True in the egress folder, in
 * test and development code, and in a file whose SOCKET_EXEMPTIONS entry names it.
 */
export function networkAccessAllowed(rel: string, name: string): boolean {
  if (inEgressDir(rel)) {
    return true;
  }
  if (isTestingContext(locate(rel))) {
    return true;
  }
  return SOCKET_EXEMPTIONS.some((exemption) => exemption.path === rel && exemption.names.includes(name));
}

export function inEgressDir(rel: string): boolean {
  return rel.startsWith(EGRESS_DIR);
}

export function inDbPackage(rel: string): boolean {
  return rel.startsWith(DB_DIR);
}
