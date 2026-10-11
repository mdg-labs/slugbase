import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { posix, relative, resolve, sep } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");

// The boundary table of doc 09 section 2.1: the workspace packages each
// package may import. The `testing` row is the development package: it may
// import every other package, because it holds the harness code that wraps
// them. Who may import `testing` is a separate rule, not a row: the testing
// check in checkWorkspaceImport limits @slugbase/testing, and TESTING_ENTRIES
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
  testing: ["contracts", "core", "db", "adapters", "server", "web", "ui", "email"],
};

const TESTING = "testing";
// Subpath entries of other packages that hold test harness code. They carry the
// raw database handle and the superuser connection, so they follow the same
// rule as @slugbase/testing, and packages/testing itself wraps them.
const TESTING_ENTRIES = new Set(["db/testing"]);
const EGRESS_DIR = "packages/adapters/src/egress/";
const DB_DIR = "packages/db/";

// Node built-ins that open sockets or speak HTTP, and the client libraries that
// do the same. Only the egress adapter may use the HTTP ones (doc 01 section 10).
const HTTP_BUILTINS = new Set(["http", "https", "http2"]);
const HTTP_PACKAGES = new Set(["undici"]);
const SOCKET_BUILTINS = new Set(["net", "tls", "dns", "dgram"]);

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

  if (target === TESTING) {
    if (!isTestingContext(loc)) {
      return `${importer} must not import @slugbase/testing: it is importable only from test files, test/ folders and apps/* development tooling (doc 09 section 2.1).`;
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
  const isHttp = builtin !== undefined ? HTTP_BUILTINS.has(builtin) : HTTP_PACKAGES.has(pkg);
  if (isHttp && !rel.startsWith(EGRESS_DIR)) {
    return `${specifier} is importable only inside packages/adapters/src/egress/: every outbound request goes through the egress adapter (doc 01 section 10, T6).`;
  }
  if (builtin === undefined && DB_PACKAGES.has(pkg) && !rel.startsWith(DB_DIR)) {
    return `${specifier} is importable only inside packages/db: the raw database handle never leaves it (doc 01 section 5.3, T1).`;
  }
  return undefined;
}

export function inEgressDir(rel: string): boolean {
  return rel.startsWith(EGRESS_DIR);
}

export function inDbPackage(rel: string): boolean {
  return rel.startsWith(DB_DIR);
}
