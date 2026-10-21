import { describe, expect, it } from "vitest";
import {
  hashCredentialToken,
  issueInstanceResetLink,
  passwordResetLink,
  requestInstanceAccountVerification,
  resetInstanceAccountMfa,
  type InstanceMfaResetOutcome,
  type InstanceRecoveryStore,
  type InstanceResetLinkStoreOutcome,
  type InstanceVerificationOutcome,
} from "../../src/index.ts";

const TARGET = "0192f3a0-bbbb-7000-8000-0000000000aa";
const ORIGIN = "https://bookmarks.example.com";

let counter = 0;
const newId = (): string => {
  counter += 1;
  return `0192f3a0-bbbb-7000-8000-${counter.toString(16).padStart(12, "0")}`;
};

interface Calls {
  readonly resets: { accountId: string; eventId: string; notify: boolean; ipPrefix: string | null }[];
  readonly links: { accountId: string; eventId: string; token: { id: string; hash: Buffer } | undefined; ipPrefix: string | null }[];
  readonly verifications: { accountId: string; eventId: string; ipPrefix: string | null }[];
}

function stubStore(answers: { reset?: InstanceMfaResetOutcome; link?: InstanceResetLinkStoreOutcome; verification?: InstanceVerificationOutcome } = {}): { store: InstanceRecoveryStore; calls: Calls } {
  const calls: Calls = { resets: [], links: [], verifications: [] };
  const store: InstanceRecoveryStore = {
    resetMfa: (accountId, eventId, notify, ipPrefix) => {
      calls.resets.push({ accountId, eventId, notify, ipPrefix });
      return Promise.resolve(answers.reset ?? "reset");
    },
    issueResetLink: (accountId, eventId, token, ipPrefix) => {
      calls.links.push({ accountId, eventId, token, ipPrefix });
      return Promise.resolve(answers.link ?? "issued");
    },
    requestVerification: (accountId, eventId, ipPrefix) => {
      calls.verifications.push({ accountId, eventId, ipPrefix });
      return Promise.resolve(answers.verification ?? "requested");
    },
  };
  return { store, calls };
}

describe("resetInstanceAccountMfa", () => {
  it("hands the store the account under a fresh event id, whether the account can be told, and the request's network", async () => {
    const { store, calls } = stubStore();
    expect(await resetInstanceAccountMfa({ store, newId }, { accountId: TARGET, notify: true, ipPrefix: "203.0.0.0/16" })).toBe("reset");
    expect(calls.resets).toHaveLength(1);
    expect(calls.resets[0]).toMatchObject({ accountId: TARGET, notify: true, ipPrefix: "203.0.0.0/16" });
  });

  it.each<InstanceMfaResetOutcome>(["mfa_not_enabled", "account_disabled", "self", "unknown_account"])("answers what the store answered: %s", async (answer) => {
    const { store } = stubStore({ reset: answer });
    expect(await resetInstanceAccountMfa({ store, newId }, { accountId: TARGET, notify: false, ipPrefix: null })).toBe(answer);
  });
});

describe("issueInstanceResetLink", () => {
  it("where mail is configured asks for no token and returns no link: the mail job makes the token and the email carries it", async () => {
    const { store, calls } = stubStore();
    const outcome = await issueInstanceResetLink({ store, newId }, { accountId: TARGET, mailAvailable: true, origin: ORIGIN, ipPrefix: null });
    expect(outcome).toEqual({ kind: "mailed" });
    expect(calls.links).toHaveLength(1);
    expect(calls.links[0]?.token).toBeUndefined();
  });

  it("where mail is not configured stores the hash of a fresh token and returns the link that carries that token, once", async () => {
    const { store, calls } = stubStore();
    const outcome = await issueInstanceResetLink({ store, newId }, { accountId: TARGET, mailAvailable: false, origin: `${ORIGIN}/ignored/path`, ipPrefix: null });
    if (outcome.kind !== "link") {
      throw new Error(`expected a link, got ${outcome.kind}`);
    }
    const prefix = `${ORIGIN}/reset-password#token=`;
    expect(outcome.link.startsWith(prefix)).toBe(true);
    const value = outcome.link.slice(prefix.length);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = calls.links[0]?.token;
    expect(stored?.hash.equals(hashCredentialToken(value) ?? Buffer.alloc(0))).toBe(true);
    expect(stored?.id).toEqual(expect.any(String));
    expect(JSON.stringify(calls)).not.toContain(value);
  });

  it("makes a different token for every request", async () => {
    const { store } = stubStore();
    const ask = { accountId: TARGET, mailAvailable: false, origin: ORIGIN, ipPrefix: null };
    expect(await issueInstanceResetLink({ store, newId }, ask)).not.toEqual(await issueInstanceResetLink({ store, newId }, ask));
  });

  it("asks again with a stored token and returns the link when the mail would not reach the account, though mail is configured", async () => {
    const calls: { token: { id: string; hash: Buffer } | undefined }[] = [];
    const store: InstanceRecoveryStore = {
      ...stubStore().store,
      issueResetLink: (_accountId, _eventId, token) => {
        calls.push({ token });
        return Promise.resolve(token === undefined ? "link_required" : "issued");
      },
    };
    const outcome = await issueInstanceResetLink({ store, newId }, { accountId: TARGET, mailAvailable: true, origin: ORIGIN, ipPrefix: null });
    if (outcome.kind !== "link") {
      throw new Error(`expected a link, got ${outcome.kind}`);
    }
    expect(calls.map((call) => call.token === undefined)).toEqual([true, false]);
    const value = outcome.link.slice(outcome.link.indexOf("#token=") + "#token=".length);
    expect(calls[1]?.token?.hash.equals(hashCredentialToken(value) ?? Buffer.alloc(0))).toBe(true);
  });

  it.each<InstanceResetLinkStoreOutcome>(["account_disabled", "email_unverified", "no_password", "unknown_account"])(
    "returns no link when the database refused: %s, with or without mail",
    async (refusal) => {
      for (const mailAvailable of [true, false]) {
        const { store } = stubStore({ link: refusal });
        expect(await issueInstanceResetLink({ store, newId }, { accountId: TARGET, mailAvailable, origin: ORIGIN, ipPrefix: null })).toEqual({ kind: refusal });
      }
    },
  );
});

describe("passwordResetLink", () => {
  it("points to the reset page of the origin, with the token in the fragment", () => {
    expect(passwordResetLink("https://bookmarks.example.com/", "abc")).toBe("https://bookmarks.example.com/reset-password#token=abc");
  });
});

describe("requestInstanceAccountVerification", () => {
  it("asks the store under a fresh event id and answers what it answered", async () => {
    const { store, calls } = stubStore();
    expect(await requestInstanceAccountVerification({ store, newId }, { accountId: TARGET, ipPrefix: null })).toBe("requested");
    expect(calls.verifications).toHaveLength(1);
    for (const answer of ["already_verified", "account_disabled", "unknown_account"] as const) {
      expect(await requestInstanceAccountVerification({ store: stubStore({ verification: answer }).store, newId }, { accountId: TARGET, ipPrefix: null })).toBe(answer);
    }
  });
});
