import { generateKeyPairSync, sign } from "node:crypto";
import { EgressError, type EgressPort, type EgressRequest, type EgressResponse, type IdentityProviderConfig } from "@slugbase/core";
import { describe, expect, it, vi } from "vitest";
import { createOidcIdentity } from "../src/index.ts";
import { createFifoLimiter } from "../src/identity/limiter.ts";

// The OIDC adapter runs at most three egress requests at once, the number of host-name lookups the egress
// instance it is given allows, and makes the rest wait their turn in order. The egress here refuses a request
// that finds three running, as the real one does, so a request the adapter let through unthrottled is refused.

const ISSUER = "https://idp.example.test";
const CLIENT_ID = "client-id-qx86";
const NOW = 1_700_000_000_000;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });

const providers = (...slugs: string[]): IdentityProviderConfig[] =>
  slugs.map((slug) => ({ slug, name: slug, clientId: CLIENT_ID, clientSecret: "client-secret-qx87", issuerUrl: ISSUER, scopes: ["openid"], autoCreate: false, allowedDomains: [] }));

function idToken(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { iss: ISSUER, aud: CLIENT_ID, sub: "subject-1", nonce: "nonce-1", iat: NOW / 1000 - 10, exp: NOW / 1000 + 300, email: "person@example.test", email_verified: true };
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "k1" })}.${encode(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}

const answer = (url: string, body: unknown): EgressResponse => ({
  url,
  status: 200,
  contentType: "application/json",
  body: new TextEncoder().encode(JSON.stringify(body)),
});

type Fault = "throw" | "reject" | "egress_error";

class CappedEgress implements EgressPort {
  readonly available = true;
  readonly started: string[] = [];
  running = 0;
  maxRunning = 0;
  refused = 0;
  /** What the first requests do instead of answering. */
  faults: Fault[] = [];

  request(request: EgressRequest): Promise<EgressResponse> {
    this.started.push(request.url);
    const fault = this.faults.shift();
    if (fault === "throw") {
      throw new Error("thrown before a promise");
    }
    if (fault === "reject") {
      return Promise.reject(new Error("rejected"));
    }
    if (fault === "egress_error") {
      return Promise.reject(new EgressError());
    }
    if (this.running >= 3) {
      this.refused += 1;
      return Promise.reject(new EgressError());
    }
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    return new Promise<EgressResponse>((resolve) => {
      setTimeout(() => {
        this.running -= 1;
        resolve(this.route(request.url));
      }, 10);
    });
  }

  private route(url: string): EgressResponse {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return answer(url, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
    }
    if (url === `${ISSUER}/keys`) {
      return answer(url, { keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] });
    }
    return answer(url, { id_token: idToken() });
  }
}

function setup(egress: CappedEgress, ...slugs: string[]) {
  const lines: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];
  const identity = createOidcIdentity({ providers: providers(...slugs), egress, logger: { warn: (message, fields) => void lines.push({ message, fields }) }, now: () => NOW });
  return { identity, lines };
}

describe("the egress requests of the OIDC adapter", () => {
  it("lists every provider of a list longer than the lookup cap, with at most three requests running", async () => {
    const egress = new CappedEgress();
    const { identity, lines } = setup(egress, "a", "b", "c", "d", "e");
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(lines).toEqual([]);
    expect(egress.refused).toBe(0);
    expect(egress.maxRunning).toBe(3);
    expect(egress.started).toHaveLength(10);
  });

  it("exchanges a code while a listing holds every slot", async () => {
    const egress = new CappedEgress();
    const { identity } = setup(egress, "a", "b", "c", "d", "e");
    await identity.metadata("a");
    egress.started.length = 0;
    const listing = identity.listProviders();
    await vi.waitFor(() => {
      expect(egress.running).toBe(3);
    });
    const claims = await identity.complete({ providerId: "a", redirectUri: "https://app.example.test/callback", code: "code-1", nonce: "nonce-1", codeVerifier: "verifier-1" });
    expect(claims).toMatchObject({ providerId: "a", subject: "subject-1" });
    expect(egress.started.filter((url) => url.endsWith("/token"))).toHaveLength(1);
    expect((await listing).map((info) => info.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(egress.refused).toBe(0);
    expect(egress.maxRunning).toBe(3);
  });

  it("frees the slot of a request that threw, rejected or failed, so the ones waiting behind it run", async () => {
    const egress = new CappedEgress();
    egress.faults = ["throw", "reject", "egress_error"];
    const { identity, lines } = setup(egress, "a", "b", "c", "d", "e");
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["d", "e"]);
    expect(lines.map((line) => line.fields?.["provider"])).toEqual(["a", "b", "c"]);
    expect(egress.refused).toBe(0);
  });
});

describe("the first-in, first-out limiter", () => {
  it("starts tasks in the order they asked and never runs more than the cap", async () => {
    const limited = createFifoLimiter(2);
    const started: number[] = [];
    let running = 0;
    let most = 0;
    const task = (index: number) => () => {
      started.push(index);
      running += 1;
      most = Math.max(most, running);
      return new Promise<number>((resolve) => {
        setTimeout(() => {
          running -= 1;
          resolve(index);
        }, 5);
      });
    };
    expect(await Promise.all([0, 1, 2, 3, 4].map((index) => limited(task(index))))).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(most).toBe(2);
  });

  it("passes on what a task rejects with and runs the next one", async () => {
    const limited = createFifoLimiter(1);
    const failing = limited(() => Promise.reject(new Error("first")));
    const thrown = limited((): Promise<never> => {
      throw new Error("second");
    });
    const after = limited(() => Promise.resolve("third"));
    await expect(failing).rejects.toThrow("first");
    await expect(thrown).rejects.toThrow("second");
    await expect(after).resolves.toBe("third");
  });
});
