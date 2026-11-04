import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnvFile, parseSetCookie, redact, secretValues, shippedMigrations } from "./restore-drill.ts";

void describe("the env file of the drill's stack", () => {
  const env = parseEnvFile(
    ["APP_ORIGIN=https://smoke.example.test", "SESSION_SECRET=s3", "ENCRYPTION_KEY=k=ey", "ENCRYPTION_KEY_ID=smoke-1", "APP_DB_PASSWORD=p1", "PORT=2345", ""].join("\n"),
  );

  void it("is read key by key, keeping a value that holds an equals sign", () => {
    assert.equal(env.get("ENCRYPTION_KEY"), "k=ey");
    assert.equal(env.get("PORT"), "2345");
  });

  void it("has as secrets the passwords, the secret and the key, and not the key's id or an address", () => {
    assert.deepEqual(secretValues(env).sort(), ["k=ey", "p1", "s3"]);
  });

  void it("is redacted wherever a secret appears, and a text without one is unchanged", () => {
    assert.equal(redact("failed with p1 and k=ey, then p1", secretValues(env)), "failed with [redacted] and [redacted], then [redacted]");
    assert.equal(redact("nothing to hide", secretValues(env)), "nothing to hide");
    assert.equal(redact("an empty secret hides nothing", [""]), "an empty secret hides nothing");
  });
});

void describe("a Set-Cookie header", () => {
  void it("gives the name and the value of a session cookie", () => {
    assert.deepEqual(parseSetCookie("__Host-sb=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax"), { name: "__Host-sb", value: "abc.def", ends: false });
  });

  void it("ends the cookie when its value is empty or its Max-Age is not positive", () => {
    assert.equal(parseSetCookie("sb=; Path=/")?.ends, true);
    assert.equal(parseSetCookie("sb=x; Max-Age=0")?.ends, true);
    assert.equal(parseSetCookie("sb=x; max-age=-1")?.ends, true);
    assert.equal(parseSetCookie("sb=x; Max-Age=60")?.ends, false);
  });

  void it("ignores a header that is no cookie", () => {
    assert.equal(parseSetCookie("garbage"), undefined);
  });
});

void describe("the level of migrations the checkout ships", () => {
  void it("is the number of entries of the journal, at least one", () => {
    assert.ok(shippedMigrations() > 0);
  });
});
