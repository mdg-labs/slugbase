import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  freePort,
  guideConfigs,
  GUIDE,
  headerValues,
  PROXY_LABEL,
  remainingOf,
  selfSignedCertificate,
  startCaddy,
  startNginx,
  validateCaddyBehindProxy,
  docker,
  type GuideConfigs,
  type Ports,
  type ProxyClient,
  type ProxyReply,
  type RunningProxy,
  type TlsMaterial,
} from "./support/reverse-proxy.ts";
import { compose, DRILL_SETUP_MS, Session, startDrillStack, waitForReady, type DrillStack } from "./support/restore-drill.ts";

// The reverse proxy drill (doc 08 section 5.1, doc 10 T4, T5 and T9): it proves docs/self-hosting/reverse-proxy.md on the
// built image. The nginx file and the Caddyfile are taken from the guide itself and run, in front of the image, as the guide
// says: over https, with the number of hops the files' own comments give. Behind each of them it checks what depends on the
// proxy being right:
//
//   - signing in works at the https origin, and the session cookie keeps its `__Host-` prefix, `Secure`, `HttpOnly` and
//     `SameSite=Lax` (T4);
//   - a mutation whose Origin is not the app's own, or that has none, is refused, with or without a session (T5);
//   - the per-address sign-in limit counts the address the proxy saw: a client that writes X-Forwarded-For itself gets no
//     bucket of its own, and another client gets a bucket of its own (T9);
//   - with TRUSTED_PROXY_HOPS=0 every client shares one bucket, one client can use up the sign-in limit for all of them,
//     the server logs the warning the guide promises, and the guide says what the drill saw.
//
// The stack is the restore drill's script (e2e/restore-drill-stack.sh): a compose project of its own with the image as an
// operator runs it, configured with the https origin the proxy serves. The proxies run on the host's network, so each client
// of the drill connects from an address of its own (127.0.0.0/8) and the proxy sees that address.

/** The wrong password of an account that does not exist: a sign-in that is refused with 401 until the limit answers 429. */
const WRONG_PASSWORD = "not-a-real-password";
/** The origin of another site, which a browser would send from a page that is not the app's. */
const FOREIGN_ORIGIN = "https://evil.example.test";

interface Owner {
  email: string;
  password: string;
}

interface Kind {
  name: "nginx" | "caddy";
  start: (context: Context) => Promise<RunningProxy>;
}

interface Context {
  stack: DrillStack;
  configs: GuideConfigs;
  guide: string;
  ports: Ports;
  tls: TlsMaterial;
  owner: Owner;
}

const KINDS: Kind[] = [
  { name: "nginx", start: ({ stack, configs, ports, tls }) => startNginx({ directory: stack.workDir, ports, tls, configs }) },
  { name: "caddy", start: ({ stack, configs, ports }) => startCaddy({ directory: stack.workDir, ports, configs }) },
];

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** The text of the guide without its line breaks, so that a sentence the guide wraps is still one sentence. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Sign-in attempts per minute and address that the guide says the default allows. */
function guideLimit(guide: string): number {
  const found = /Sign-in allows (\d+) attempts a minute/.exec(flat(guide));
  if (found === null) {
    throw new Error("the guide does not say how many sign-in attempts a minute are allowed");
  }
  return Number(found[1]);
}

/** A sign-in with a password that is wrong, for an address nobody has, as the guide's check sends it; the client writes the header X-Forwarded-For itself. */
function refusedSignIn(client: ProxyClient, from: string, forwardedFor: string): Promise<ProxyReply> {
  return client.send({
    method: "POST",
    path: "/api/v1/auth/login",
    from,
    headers: { origin: client.origin, "x-forwarded-for": forwardedFor },
    data: { email: `nobody-${randomBytes(4).toString("hex")}@example.test`, password: WRONG_PASSWORD },
  });
}

function signIn(client: ProxyClient, from: string, owner: Owner): Promise<ProxyReply> {
  return client.send({ method: "POST", path: "/api/v1/auth/login", from, headers: { origin: client.origin }, data: owner });
}

const SERVER_RESTART_ARGUMENTS = ["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "slugbase"];

let configuredHops: number | undefined;

/** Sets TRUSTED_PROXY_HOPS in the stack's env file and starts the server again, as the guide says to, then waits until it is ready. */
async function setHops(stack: DrillStack, hops: number): Promise<void> {
  if (configuredHops === hops) {
    return;
  }
  const lines = readFileSync(stack.envFile, "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("TRUSTED_PROXY_HOPS="));
  const file = join(stack.workDir, `hops-${String(hops)}.env`);
  writeFileSync(file, `${[...lines, `TRUSTED_PROXY_HOPS=${String(hops)}`].join("\n")}\n`, { mode: 0o600 });
  compose(stack, SERVER_RESTART_ARGUMENTS, { envFile: file });
  await waitForReady(stack.baseUrl);
  configuredHops = hops;
}

function serverLog(stack: DrillStack): string {
  return compose(stack, ["logs", "--no-color", "--no-log-prefix", "slugbase"]).stdout;
}

/** Runs the body with the proxy started and removes the proxy however the body ends. */
async function behind<T>(kind: Kind, context: Context, body: (proxy: RunningProxy) => Promise<T>): Promise<T> {
  const proxy = await kind.start(context);
  try {
    return await body(proxy);
  } finally {
    proxy.stop();
  }
}

function attributesOf(setCookie: string): string[] {
  return setCookie.split(";").map((part) => part.trim());
}

// The time the sign-in bucket of the address the server sees behind a proxy that is trusted for no hops was last emptied: it is the
// same bucket for every proxy, and the next run that needs it full waits for it to refill.
let lastEmptied = 0;
const REFILL_MS = 62_000;

test.describe("the documented proxy configurations", () => {
  test.describe.configure({ mode: "serial" });

  let context: Context | undefined;
  let healthy = true;

  test.beforeAll(async () => {
    test.setTimeout(DRILL_SETUP_MS);
    let stack: DrillStack | undefined;
    try {
      const guide = readFileSync(GUIDE, "utf8");
      const configs = guideConfigs(guide);
      // The origin of the stack is the proxy's, so its port is chosen first and the stack is told to keep clear of it.
      const tls = await freePort();
      stack = await startDrillStack({ ...process.env, SMOKE_APP_ORIGIN: `https://127.0.0.1:${String(tls)}`, SMOKE_AVOID_PORT: String(tls) });
      const upstream = Number(new URL(stack.baseUrl).port);
      const ports: Ports = { tls, http: await freePort([tls, upstream]), upstream };
      const owner: Owner = { email: `owner-${randomBytes(4).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url") };
      stack.secrets.push(owner.password);
      // The first account is claimed at the server's own port, as an operator does before the proxy is there to try.
      const direct = new Session(stack.baseUrl, stack.appOrigin);
      await direct.expect("POST", "/api/v1/setup", 201, {
        displayName: "Proxy Owner",
        email: owner.email,
        password: owner.password,
        workspaceName: "Proxy",
        setupToken: stack.setupToken,
      });
      context = { stack, configs, guide, ports, tls: selfSignedCertificate(stack.workDir), owner };
    } catch (error) {
      healthy = false;
      await stack?.finish(false);
      throw error;
    }
  });

  test.afterEach(({}, info) => {
    if (info.status !== info.expectedStatus) {
      healthy = false;
    }
  });

  test.afterAll(async () => {
    // A container a failed test left behind is removed by its label; the stack's script removes the rest.
    const left = docker(["ps", "--all", "--quiet", "--filter", `label=${PROXY_LABEL}`], { allowFailure: true }).stdout.split("\n").filter((id) => id !== "");
    if (left.length > 0) {
      docker(["rm", "--force", "--volumes", ...left], { allowFailure: true });
    }
    await context?.stack.finish(healthy);
  });

  function started(): Context {
    if (context === undefined) {
      throw new Error("the stack of the drill did not start");
    }
    return context;
  }

  test("takes both files and the number of hops from the guide, and the Caddyfile for a Caddy behind another proxy is valid", () => {
    const { configs, stack } = started();
    expect(configs.hops, "the TRUSTED_PROXY_HOPS that the guide's files name for one proxy").toBe(1);
    const validated = validateCaddyBehindProxy(stack.workDir, configs);
    expect(validated.status, `caddy validate of the guide's global options block and Caddyfile:\n${validated.output}`).toBe(0);
  });

  for (const [index, kind] of KINDS.entries()) {
    test(`behind ${kind.name}, over https, with the hops the guide gives: sign-in, the cookie, the origin check and the client address`, async () => {
      const instance = started();
      const { stack, configs, guide, owner } = instance;
      const limit = guideLimit(guide);
      await setHops(stack, configs.hops);
      // Each proxy has addresses of its own, so the buckets of one run are not the ones of the next.
      const session = `127.0.${String(index + 1)}.1`;
      const clientA = `127.0.${String(index + 1)}.2`;
      const clientB = `127.0.${String(index + 1)}.3`;

      await behind(kind, instance, async (proxy) => {
        const { client } = proxy;
        let cookie = "";

        await test.step("a member signs in at the https origin, and the session cookie keeps its attributes", async () => {
          const reply = await signIn(client, session, owner);
          expect(reply.status, "the sign-in through the proxy").toBe(200);
          expect(record(JSON.parse(reply.body), "the sign-in answer").next, "a sign-in with the password alone").toBe("done");
          const cookies = headerValues(reply.headers, "set-cookie");
          expect(cookies, "the cookies the sign-in sets").toHaveLength(1);
          const attributes = attributesOf(cookies[0] ?? "");
          cookie = attributes[0] ?? "";
          expect(cookie, "the session cookie").toMatch(/^__Host-slugbase_session=\S+$/);
          expect(attributes, "the attributes of the session cookie").toEqual(expect.arrayContaining(["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]));
          expect(attributes.filter((attribute) => /^domain=/i.test(attribute)), "a Domain attribute, which would make the cookie visible to subdomains").toEqual([]);
          expect(client.origin, "the origin the member signed in at").toBe(stack.appOrigin);

          const me = await client.send({ path: "/api/v1/me", from: session, headers: { cookie } });
          expect(me.status, "the account of the session, read through the proxy").toBe(200);
          expect(headerValues(me.headers, "strict-transport-security"), "the Strict-Transport-Security header, which the proxy leaves alone").toHaveLength(1);
          expect(me.headers["cache-control"], "the Cache-Control of an API answer, which the proxy leaves alone").toBe("no-store");
        });

        await test.step("a mutation whose Origin is not the app's is refused, with a session and without one", async () => {
          const refused = async (headers: Record<string, string>, withSession: boolean, what: string): Promise<void> => {
            const reply = await client.send({
              method: "POST",
              path: "/api/v1/auth/logout",
              from: session,
              headers: withSession ? { ...headers, cookie } : headers,
              data: {},
            });
            expect(reply.status, what).toBe(403);
            expect(record(JSON.parse(reply.body), what).code, what).toBe("cross_site_request");
          };
          await refused({ origin: FOREIGN_ORIGIN }, true, "a sign-out from another site's origin");
          await refused({ origin: client.origin.replace("https:", "http:") }, true, "a sign-out from the app's host over http");
          await refused({}, true, "a sign-out with no Origin at all, as a proxy that strips it would send");
          const foreignSignIn = await client.send({
            method: "POST",
            path: "/api/v1/auth/login",
            from: session,
            headers: { origin: FOREIGN_ORIGIN },
            data: owner,
          });
          expect(foreignSignIn.status, "a sign-in from another site's origin, with the right password").toBe(403);
          expect(headerValues(foreignSignIn.headers, "set-cookie"), "the cookies a refused sign-in sets").toEqual([]);

          const still = await client.send({ path: "/api/v1/me", from: session, headers: { cookie } });
          expect(still.status, "the session after the refused sign-outs").toBe(200);
          const out = await client.send({ method: "POST", path: "/api/v1/auth/logout", from: session, headers: { origin: client.origin, cookie }, data: {} });
          expect(out.status, "a sign-out from the app's own origin").toBeLessThan(300);
          const gone = await client.send({ path: "/api/v1/me", from: session, headers: { cookie } });
          expect(gone.status, "the session after the sign-out").toBe(401);
        });

        await test.step("the sign-in limit counts the address the proxy saw, and a client's own X-Forwarded-For buys nothing", async () => {
          // Client A writes a different X-Forwarded-For on every attempt, as a client that dodges the limit would. If the server
          // read that header past the proxy's own entry each attempt would have a bucket of its own and none would be refused.
          const answers: ProxyReply[] = [];
          for (let attempt = 1; attempt <= limit + 2; attempt += 1) {
            answers.push(await refusedSignIn(client, clientA, `198.51.100.${String(attempt)}, 203.0.113.${String(attempt)}`));
          }
          expect(
            answers.map((reply) => reply.status),
            `the answers to ${String(limit + 2)} sign-ins from one address`,
          ).toEqual([...Array<number>(limit).fill(401), 429, 429]);
          expect(remainingOf(answers[0]?.headers ?? {}, "login"), "the tokens left in the bucket of the address after its first attempt").toBe(limit - 1);
          expect(headerValues(answers[limit]?.headers ?? {}, "retry-after"), "the Retry-After of the refusal").toHaveLength(1);

          // Client B is another address behind the same proxy: its bucket is its own, even when it writes the very header A wrote.
          const other = await refusedSignIn(client, clientB, "198.51.100.1, 203.0.113.1");
          expect(other.status, "the first sign-in of another address").toBe(401);
          expect(remainingOf(other.headers, "login"), "the tokens left in the bucket of the other address").toBe(limit - 1);
        });

        await test.step("the server does not warn about the number of hops", () => {
          expect(serverLog(stack), "the log of a server that trusts the proxy in front of it").not.toContain("trusts no proxy");
        });
      });
    });
  }

  for (const [index, kind] of KINDS.entries()) {
    test(`behind ${kind.name}, with TRUSTED_PROXY_HOPS=0: every client shares one bucket, as the guide warns`, async () => {
      test.setTimeout(5 * 60_000);
      const instance = started();
      const { stack, guide, owner } = instance;
      const limit = guideLimit(guide);
      await setHops(stack, 0);
      const wait = lastEmptied + REFILL_MS - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      const clientA = `127.0.${String(index + 3)}.2`;
      const clientB = `127.0.${String(index + 3)}.3`;
      const clientC = `127.0.${String(index + 3)}.4`;

      await behind(kind, instance, async ({ client }) => {
        await test.step("one client uses up the sign-in limit", async () => {
          const answers: ProxyReply[] = [];
          for (let attempt = 1; attempt <= limit + 2; attempt += 1) {
            answers.push(await refusedSignIn(client, clientA, `198.51.100.${String(attempt)}`));
          }
          lastEmptied = Date.now();
          expect(
            answers.map((reply) => reply.status),
            `the answers to ${String(limit + 2)} sign-ins from one address`,
          ).toEqual([...Array<number>(limit).fill(401), 429, 429]);
        });

        await test.step("another client, which has not tried once, is refused too, even for the right password", async () => {
          const other = await refusedSignIn(client, clientB, "198.51.100.200");
          expect(other.status, "the first sign-in of another address").toBe(429);
          expect(remainingOf(other.headers, "login"), "the tokens left in the bucket that every client shares").toBe(0);
          const member = await signIn(client, clientC, owner);
          expect(member.status, "the sign-in of the account's owner, from a third address, with the right password").toBe(429);
          expect(headerValues(member.headers, "set-cookie"), "the cookies of a refused sign-in").toEqual([]);
        });
      });

      await test.step("the server logs the warning the guide promises for a production start with 0", () => {
        const log = serverLog(stack);
        expect(log, "the warning at the start of the server").toContain("TRUSTED_PROXY_HOPS");
        expect(log, "the warning at the start of the server").toContain("trusts no proxy");
      });
    });
  }

  test("the guide says what the drill saw with TRUSTED_PROXY_HOPS=0", () => {
    const { guide } = started();
    const text = flat(guide);
    const warning = [
      "**Too low, or `0`.** At the default of `0` SlugBase ignores `X-Forwarded-For` and sees only the proxy's address.",
      "Every client then shares one bucket for each per-IP limit, so one client can use up the sign-in limit for everyone.",
      "A production start with `0` logs a warning.",
    ];
    for (const sentence of warning) {
      expect(text, "the guide's warning about TRUSTED_PROXY_HOPS=0").toContain(sentence);
    }
    expect(text, "the symptom in the guide's troubleshooting").toContain("**Everyone is told `429` after a few sign-ins.** Every client shares one address.");
    expect(text, "the guide's own check of the value").toContain("The answers turn from `401` to `429` after about 10.");
  });
});
