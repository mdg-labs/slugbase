import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_PASSWORD,
  COMPOSE_FILE,
  COMPOSE_PG17_FILE,
  type ComposeConfig,
  type ServiceConfig,
  exampleKeys,
  interpolate,
  loadCompose,
  MIGRATOR_PASSWORD,
  OPERATOR_VALUES,
  operatorEnv,
  SUPERUSER_PASSWORD,
} from "./compose-support.ts";

// The self-hosting stack (doc 01 section 2.1, doc 05 section 3.1, Q56) is what
// holds the migrator credentials away from the worker and the database away from
// the network. This file reads compose.yml, and compose.pg17.yml merged over it,
// with a YAML parser and needs no Docker CLI, so it runs wherever the integration
// tests do. That Docker Compose accepts the files and what it prints are checked
// in compose-cli.integration.test.ts.

describe("interpolation of compose.yml", () => {
  const env = new Map([["SET", "value"], ["EMPTY", ""]]);

  it("resolves the two forms the file uses", () => {
    expect(interpolate("a-${SET:-d}-b", env)).toBe("a-value-b");
    expect(interpolate("${MISSING:-d}${EMPTY:-e}", env)).toBe("de");
    expect(interpolate("${SET:?needed}", env)).toBe("value");
  });

  it("refuses a required key that is unset or empty, naming it", () => {
    expect(() => interpolate("${MISSING:?needed}", env)).toThrow(/MISSING.*needed/);
    expect(() => interpolate("${EMPTY:?needed}", env)).toThrow(/EMPTY/);
  });

  it.each(["${SET}", "${SET-d}", "${SET?m}", "${SET:+alt}", "$SET", "$$", "${SET:-${EMPTY}}"])("rejects the form %s, which this resolver does not implement", (form) => {
    expect(() => interpolate(form, env)).toThrow(/unsupported interpolation/);
  });

  it("finds no other form anywhere in compose.yml or compose.pg17.yml", () => {
    expect(() => loadCompose(operatorEnv())).not.toThrow();
    expect(() => loadCompose(operatorEnv(), [COMPOSE_PG17_FILE])).not.toThrow();
  });
});

describe("compose.yml", () => {
  const services = () => loadCompose(operatorEnv()).services;

  it("defines exactly postgres, the server and the worker", () => {
    expect(Object.keys(services()).sort()).toEqual(["postgres", "slugbase", "slugbase-worker"]);
  });

  it("runs PostgreSQL 18 with a volume, a health check and the role script, and publishes nothing", () => {
    const { postgres } = services();
    expect(postgres.image).toBe("postgres:18");
    expect(postgres.ports).toBeUndefined();
    expect(postgres.healthcheck?.test.join(" ")).toContain("pg_isready");
    expect(postgres.volumes).toContain("postgres-data:/var/lib/postgresql");
    expect(postgres.volumes).toContain("./packages/db/provision/roles.sql:/docker-entrypoint-initdb.d/10-roles.sql:ro");
    expect(postgres.environment).toMatchObject({
      POSTGRES_PASSWORD: SUPERUSER_PASSWORD,
      PROVISION_APP_PASSWORD: APP_PASSWORD,
      PROVISION_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD,
    });
  });

  it("mounts the file that provisions the roles", () => {
    expect(readFileSync(COMPOSE_FILE, "utf8")).toContain("./packages/db/provision/roles.sql:");
    const roles = readFileSync(new URL("../../../packages/db/provision/roles.sql", import.meta.url), "utf8");
    expect(roles).toContain("PROVISION_APP_PASSWORD");
    expect(roles).toContain("PROVISION_MIGRATOR_PASSWORD");
  });

  it("runs the server and the worker from one image, built from the repository's Dockerfile as a fallback", () => {
    const { slugbase, "slugbase-worker": worker } = services();
    expect(slugbase.image).toBe("ghcr.io/mdg-labs/slugbase:latest");
    expect(worker.image).toBe(slugbase.image);
    expect(slugbase.build).toMatchObject({ context: ".", dockerfile: "apps/slugbase/Dockerfile" });
    expect(worker.build).toEqual(slugbase.build);
    expect(slugbase.command).toEqual(["server"]);
    expect(worker.command).toEqual(["worker"]);
  });

  it("takes the image from SLUGBASE_IMAGE", () => {
    const env = operatorEnv();
    env.set("SLUGBASE_IMAGE", "registry.example/slugbase:1.2.3");
    const { slugbase, "slugbase-worker": worker } = loadCompose(env).services;
    expect(slugbase.image).toBe("registry.example/slugbase:1.2.3");
    expect(worker.image).toBe("registry.example/slugbase:1.2.3");
  });

  it.each(["slugbase", "slugbase-worker"] as const)("runs %s unprivileged on a read-only root filesystem", (name) => {
    const service = services()[name];
    expect(service.user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
    expect(service.read_only).toBe(true);
    expect(service.tmpfs).toEqual(["/tmp"]);
    expect(service.restart).toBe("unless-stopped");
  });

  it("starts the server once the database is healthy, and the worker once the server is", () => {
    const { slugbase, "slugbase-worker": worker } = services();
    expect(slugbase.depends_on?.["postgres"]?.condition).toBe("service_healthy");
    expect(worker.depends_on?.["slugbase"]?.condition).toBe("service_healthy");
    expect(slugbase.healthcheck?.test.join(" ")).toContain("/ready");
  });

  it("publishes the server's port on the loopback address and the worker's nothing", () => {
    const { slugbase, "slugbase-worker": worker } = services();
    expect(slugbase.ports).toEqual(["127.0.0.1:3000:3000"]);
    expect(worker.ports).toBeUndefined();
  });

  it("passes slugbase_app's URL to both services and slugbase_migrator's to the server only", () => {
    const { slugbase, "slugbase-worker": worker } = services();
    const app = `postgres://slugbase_app:${APP_PASSWORD}@postgres:5432/slugbase`;
    expect(slugbase.environment["DATABASE_URL"]).toBe(app);
    expect(worker.environment["DATABASE_URL"]).toBe(app);
    expect(slugbase.environment["DATABASE_MIGRATE_URL"]).toBe(`postgres://slugbase_migrator:${MIGRATOR_PASSWORD}@postgres:5432/slugbase`);
    expect(worker.environment).not.toHaveProperty("DATABASE_MIGRATE_URL");
    expect(worker.environment).not.toHaveProperty("MIGRATE_ON_START");
    expect(JSON.stringify(worker.environment)).not.toContain(MIGRATOR_PASSWORD);
  });

  it("reads an optional .env.oidc for the server alone, so that OIDC_<SLUG>_* keys of the operator's own slug reach it", () => {
    const { slugbase, "slugbase-worker": worker } = services();
    expect(slugbase.env_file).toEqual([{ path: ".env.oidc", required: false }]);
    expect(worker.env_file).toBeUndefined();
  });

  it("gives neither service the database superuser's password, nor any key of its own", () => {
    for (const name of ["slugbase", "slugbase-worker"] as const) {
      const environment = services()[name].environment;
      expect(JSON.stringify(environment)).not.toContain(SUPERUSER_PASSWORD);
      for (const key of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "MIGRATOR_DB_PASSWORD", "SLUGBASE_IMAGE", "SLUGBASE_BIND"]) {
        expect(environment, `${name} ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it("runs in production whatever the environment file says, and keeps the development database out", () => {
    const env = operatorEnv();
    env.set("NODE_ENV", "development");
    env.set("DATABASE_URL", "postgres://slugbase_app:slugbase_app_dev_only@localhost:54329/slugbase_dev");
    env.set("DATABASE_MIGRATE_URL", "postgres://slugbase_migrator:slugbase_migrator_dev_only@localhost:54329/slugbase_dev");
    const { slugbase, "slugbase-worker": worker } = loadCompose(env).services;
    for (const service of [slugbase, worker]) {
      expect(JSON.stringify(service.environment)).not.toContain("dev_only");
      expect(service.environment["NODE_ENV"]).toBe("production");
    }
  });

  it("passes every other key of .env.example to the server and the worker", () => {
    const env = operatorEnv();
    const { slugbase, "slugbase-worker": worker } = loadCompose(env).services;
    // Set by compose.yml itself: it runs in production, builds both URLs from the role passwords, and its
    // roles are the two of doc 05 section 3.1, so the owner-connection override of Q56 has no use in it.
    const fixed = new Set(["NODE_ENV", "DATABASE_URL", "DATABASE_MIGRATE_URL", "SLUGBASE_ALLOW_OWNER_CONNECTION"]);
    const serverOnly = new Set(["PORT", "TRUSTED_PROXY_HOPS", "API_DOCS_ENABLED", "DOCS_BASE_URL", "MIGRATE_ON_START", "SETUP_ENABLED", "SETUP_TOKEN_REQUIRED", "PUBLIC_REGISTRATION", "EMAIL_VERIFICATION_REQUIRED", "BREACHED_PASSWORD_CHECK", "TOTP_ISSUER"]);
    for (const key of exampleKeys().keys()) {
      if (fixed.has(key)) {
        continue;
      }
      expect(slugbase.environment[key], `slugbase ${key}`).toBe(env.get(key));
      if (serverOnly.has(key)) {
        expect(worker.environment, `worker ${key}`).not.toHaveProperty(key);
      } else {
        expect(worker.environment[key], `worker ${key}`).toBe(env.get(key));
      }
    }
    expect(slugbase.environment).not.toHaveProperty("SLUGBASE_ALLOW_OWNER_CONNECTION");
    expect(worker.environment).not.toHaveProperty("SLUGBASE_ALLOW_OWNER_CONNECTION");
  });

  it.each([...OPERATOR_VALUES.keys()])("refuses to resolve without %s", (key) => {
    const env = operatorEnv();
    env.delete(key);
    expect(() => loadCompose(env)).toThrow(new RegExp(`required ${key} is not set`));
  });
});

const POSTGRES_18_DATA = "postgres-data:/var/lib/postgresql";
const POSTGRES_17_DATA = "postgres-data:/var/lib/postgresql/data";
const ROLES_MOUNT = "./packages/db/provision/roles.sql:/docker-entrypoint-initdb.d/10-roles.sql:ro";

/** Throws unless the database of `config` is PostgreSQL 17 with its data volume at the path that image keeps its data in. */
function assertPostgres17(config: ComposeConfig): void {
  const { postgres } = config.services;
  expect(postgres.image).toBe("postgres:17");
  // Exactly these two mounts: the PostgreSQL 18 mount, kept beside the 17 one, would nest the volume in itself.
  expect(postgres.volumes).toEqual([POSTGRES_17_DATA, ROLES_MOUNT]);
}

describe("compose.pg17.yml", () => {
  const scratch = mkdtempSync(join(tmpdir(), "slugbase-compose-pg17-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A copy of compose.pg17.yml with `mutate` applied to its text. */
  function mutated(name: string, mutate: (text: string) => string): string {
    const original = readFileSync(COMPOSE_PG17_FILE, "utf8");
    const changed = mutate(original);
    expect(changed, `the mutation "${name}" changed nothing`).not.toBe(original);
    const file = join(scratch, `${name}.yml`);
    writeFileSync(file, changed);
    return file;
  }

  it("runs the database on PostgreSQL 17 with its data volume at the path of that image", () => {
    assertPostgres17(loadCompose(operatorEnv(), [COMPOSE_PG17_FILE]));
  });

  it("changes nothing but the image and the volumes of the database", () => {
    const env = operatorEnv();
    const base = loadCompose(env).services;
    const over = loadCompose(env, [COMPOSE_PG17_FILE]).services;
    const withoutImageAndVolumes = (service: ServiceConfig) => Object.fromEntries(Object.entries(service).filter(([key]) => key !== "image" && key !== "volumes"));
    expect(withoutImageAndVolumes(over.postgres)).toEqual(withoutImageAndVolumes(base.postgres));
    expect(over.slugbase).toEqual(base.slugbase);
    expect(over["slugbase-worker"]).toEqual(base["slugbase-worker"]);
  });

  it("leaves compose.yml alone on PostgreSQL 18 with the data volume under /var/lib/postgresql", () => {
    const { postgres } = loadCompose(operatorEnv()).services;
    expect(postgres.image).toBe("postgres:18");
    expect(postgres.volumes).toEqual([POSTGRES_18_DATA, ROLES_MOUNT]);
  });

  // The assertion above is only worth something if it fails for an override that does not do the job.
  it.each([
    ["an image that is not changed", (text: string) => text.replace("image: postgres:17", "image: postgres:18")],
    ["an image that is dropped", (text: string) => text.replace("    image: postgres:17\n", "")],
    ["a data path that is not changed", (text: string) => text.replace("postgres-data:/var/lib/postgresql/data", POSTGRES_18_DATA)],
    ["volumes that are added to those of compose.yml", (text: string) => text.replace("volumes: !override", "volumes:")],
    ["a role script that is dropped", (text: string) => text.replace(/\s+- \.\/packages\/db\/provision\/roles\.sql[^\n]*/, "")],
  ])("is not accepted as the PostgreSQL 17 selection with %s", (name, mutate) => {
    const file = mutated(name.replaceAll(" ", "-"), mutate);
    expect(() => {
      assertPostgres17(loadCompose(operatorEnv(), [file]));
    }).toThrow();
  });
});
