import { describe, expect, it } from "vitest";
import { REDACTED_FIELDS, createLogger, type LogDestination } from "../../src/http/logger.ts";

function capture(): { readonly destination: LogDestination; readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  };
}

describe("the logger's redaction", () => {
  it("censors a field name the composition adds, at the top level and up to three objects deep", () => {
    const { destination, lines } = capture();
    const logger = createLogger({ level: "info", destination, redactFields: ["billingApiKey", "signingSecret"] });
    logger.info("Billing call", {
      billingApiKey: "top-billing-key-qx01",
      signingSecret: "top-signing-qx02",
      billing: { billingApiKey: "nested-key-qx03", deeper: { signingSecret: "nested-signing-qx04", deepest: { billingApiKey: "third-level-qx05" } } },
      note: "kept",
    });
    const line = lines.join("");
    for (const secret of ["top-billing-key-qx01", "top-signing-qx02", "nested-key-qx03", "nested-signing-qx04", "third-level-qx05"]) {
      expect(line).not.toContain(secret);
    }
    expect(JSON.parse(line)).toMatchObject({
      billingApiKey: "[Redacted]",
      signingSecret: "[Redacted]",
      billing: { billingApiKey: "[Redacted]", deeper: { signingSecret: "[Redacted]", deepest: { billingApiKey: "[Redacted]" } } },
      note: "kept",
    });
  });

  it("writes a composition-named field as it is when the composition adds nothing", () => {
    const { destination, lines } = capture();
    createLogger({ level: "info", destination }).info("Billing call", { billingApiKey: "visible-qx06" });
    expect(lines.join("")).toContain("visible-qx06");
  });

  it("keeps censoring the built-in fields whatever the composition adds, even a built-in name again", () => {
    const { destination, lines } = capture();
    const logger = createLogger({ level: "info", destination, redactFields: ["signingSecret", "password"] });
    logger.info("Both", { password: "builtin-pw-qx07", nested: { apiKey: "builtin-key-qx08" }, signingSecret: "added-qx09" });
    const line = lines.join("");
    for (const secret of ["builtin-pw-qx07", "builtin-key-qx08", "added-qx09"]) {
      expect(line).not.toContain(secret);
    }
    expect(REDACTED_FIELDS).toContain("password");
  });

  it("refuses a field name the logger will not take rather than starting without it", () => {
    const refused = [
      "",
      'quo"te',
      "back\\slash",
      "a]b",
      "a[b",
      "*",
      "a\nb",
      "a\rb",
      "a\u2028b",
      "a\u2029b",
      "a\u0000b",
      "a\tb",
      "a\u001fb",
      "a\u007fb",
      "a\u0085b",
      "a\u009fb",
    ];
    for (const bad of refused) {
      expect(() => createLogger({ level: "info", destination: capture().destination, redactFields: [bad] })).toThrow(/redactFields/);
    }
  });

  it("censors every accepted name at the top level and one, two and three objects deep", () => {
    const names = ["BILLING_API_KEY", "x-api-key-2", "$secret", "a b", "a.b", "a'b", "a`b", "a/b", "a:b", "__proto__", "constructor", "clé", "日本語", "a\u{1F600}b", "a\u00a0b"];
    for (const name of names) {
      for (let depth = 0; depth <= 3; depth += 1) {
        const { destination, lines } = capture();
        const logger = createLogger({ level: "info", destination, redactFields: [name] });
        let fields: Record<string, unknown> = Object.fromEntries([[name, "SECRET-qx10"]]);
        for (let level = 0; level < depth; level += 1) fields = { wrapper: fields };
        logger.info("Probe", fields);
        expect(lines.join(""), `${JSON.stringify(name)} at depth ${String(depth)}`).not.toContain("SECRET-qx10");
      }
    }
  });

  it("censors, at every depth, each name it accepts and refuses the rest, across the Basic Multilingual Plane", () => {
    const uncensored: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const name = `a${String.fromCharCode(code)}b`;
      let logger;
      const { destination, lines } = capture();
      try {
        logger = createLogger({ level: "info", destination, redactFields: [name] });
      } catch {
        continue;
      }
      for (let depth = 0; depth <= 3; depth += 1) {
        let fields: Record<string, unknown> = Object.fromEntries([[name, "SECRET-qx11"]]);
        for (let level = 0; level < depth; level += 1) fields = { wrapper: fields };
        logger.info("Probe", fields);
      }
      if (lines.join("").includes("SECRET-qx11")) uncensored.push(`U+${code.toString(16).padStart(4, "0")}`);
    }
    expect(uncensored).toEqual([]);
  }, 120_000);
});
