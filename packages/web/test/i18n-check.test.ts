import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../../scripts/check-i18n.mjs");
const TIMEOUT_MS = 60_000;

const scratch = mkdtempSync(join(tmpdir(), "slugbase-i18n-check-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const EN = {
  save: "Save",
  items: "{count, plural, =0 {No bookmarks} one {# bookmark} other {# bookmarks}}",
  greeting: "Hello {name}",
};
const DE = {
  save: "Speichern",
  items: "{count, plural, =0 {Keine Lesezeichen} one {# Lesezeichen} other {# Lesezeichen}}",
  greeting: "Hallo {name}",
};
const APP = `
import { useTranslation } from "react-i18next";
export function App() {
  const { t } = useTranslation();
  return (
    <main>
      <button>{t("save")}</button>
      <p>{t("items", { count: 2 })}</p>
      <p>{t("greeting", { name: "x" })}</p>
    </main>
  );
}
`;

let counter = 0;

/** Writes a package of `files` (path to content) into the scratch directory and runs the check on it. */
function check(files: Record<string, string>, args: string[] = []) {
  counter += 1;
  const dir = join(scratch, `pkg-${String(counter)}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args, dir], { encoding: "utf8", timeout: TIMEOUT_MS });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const catalogs = (en: object = EN, de: object = DE) => ({
  "src/i18n/locales/en.json": JSON.stringify(en),
  "src/i18n/locales/de.json": JSON.stringify(de),
});

describe("pnpm i18n:check", { timeout: TIMEOUT_MS }, () => {
  it("passes catalogs that agree, are all used, and JSX without literal text", () => {
    const result = check({ ...catalogs(), "src/app.tsx": APP }, ["--require-catalogs"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("fails when a key is removed from de.json", () => {
    const result = check({ ...catalogs(EN, { items: DE.items, greeting: DE.greeting }), "src/app.tsx": APP });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('de.json: "save" is in en.json but missing here');
  });

  it("fails when de.json has a key en.json lacks", () => {
    const result = check({ ...catalogs(EN, { ...DE, extra: "Zusatz" }), "src/app.tsx": APP });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"extra" is not in src/i18n/locales/en.json');
  });

  it("fails on a key no t() call uses", () => {
    const result = check({ ...catalogs({ ...EN, spare: "Spare" }, { ...DE, spare: "Reserve" }), "src/app.tsx": APP });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"spare" is not used by any t() call');
  });

  it("fails on a key used in code but missing from the catalogs", () => {
    const result = check({
      ...catalogs(),
      "src/app.tsx": APP.replace('t("save")', 't("cancel")') + 'export const again = (t: (key: string) => string) => t("save");\n',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/app.tsx:7: "cancel" is used but is not in src/i18n/locales/en.json');
  });

  it("fails on a malformed ICU message", () => {
    const result = check({ ...catalogs({ ...EN, greeting: "Hello {name" }), "src/app.tsx": APP });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/en\.json: "greeting" is not a valid ICU message/);
  });

  it("fails on a plural without the required other clause", () => {
    const result = check({ ...catalogs(EN, { ...DE, items: "{count, plural, one {# Lesezeichen}}" }), "src/app.tsx": APP });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/de\.json: "items" is not a valid ICU message/);
  });

  it("fails when the languages use other placeholders for a key", () => {
    const result = check({ ...catalogs(EN, { ...DE, greeting: "Hallo {user}" }), "src/app.tsx": APP });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/de\.json: "greeting" has other placeholders than en\.json \(en: \{name\}; de: \{user\}\)/);
  });

  it("fails when the languages use other plural categories for a key", () => {
    const result = check({
      ...catalogs(EN, { ...DE, items: "{count, plural, =0 {Keine Lesezeichen} other {# Lesezeichen}}" }),
      "src/app.tsx": APP,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/de\.json: "items" has other plural or select options than en\.json/);
  });

  it("fails on a key that is not a string literal", () => {
    const result = check({
      ...catalogs(),
      "src/app.tsx": APP + 'export const dynamic = (t: (key: string) => string, name: string) => t(`status.${name}`);\n',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/src\/app\.tsx:\d+: the key of t\(\) must be a string literal/);
  });

  it("fails on keyPrefix, which hides the full key", () => {
    const result = check({
      ...catalogs(),
      "src/app.tsx": APP + 'export const prefixed = { keyPrefix: "landing" };\n',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/keyPrefix hides the full key/);
  });

  it("requires catalogs when asked to", () => {
    const result = check({ "src/app.tsx": "export const x = 1;\n" }, ["--require-catalogs"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no catalogs found");
  });

  it("finds the catalogs of the email package next to src/i18n", () => {
    const result = check({
      "src/i18n/en.json": JSON.stringify({ subject: "Welcome" }),
      "src/i18n/de.json": JSON.stringify({}),
      "src/mail.tsx": 'export const subject = (t: (key: string) => string) => t("subject");\n',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/i18n/de.json: "subject" is in en.json but missing here');
  });

  it("fails on a literal string in JSX in every form a reader can see", () => {
    const result = check({
      ...catalogs(),
      "src/app.tsx":
        APP +
        `
export const Bad = () => (
  <div>
    <p>Save</p>
    <p>{"Cancel"}</p>
    <p>{\`Delete\`}</p>
    <p>{ok ? "Yes" : "No"}</p>
    <button aria-label="Close" title="Close" />
    <Frame render={<span>Open</span>} />
  </div>
);
`,
    });
    expect(result.code).toBe(1);
    const flagged = result.stderr.split("\n").filter((line) => line.includes("Move this text into the i18n catalogs"));
    for (const text of ["Save", "Cancel", "Delete", "Yes", "No", 'aria-label="Close"', 'title="Close"', "Open"]) {
      expect(flagged.some((line) => line.includes(text)), text).toBe(true);
    }
  });

  it("passes the JSX that carries no words of its own", () => {
    const result = check({
      ...catalogs(),
      "src/app.tsx":
        APP +
        `
export const Fine = ({ slug }: { slug: string }) => (
  <div className="flex gap-2" role="status" data-testid="fine" aria-hidden="true">
    <span translate="no">docs-home</span>
    <code translate="no">https://example.com/go/docs-home</code>
    <NoTranslate>{slug}</NoTranslate>
    <NoTranslate>literal-slug</NoTranslate>
    <span>{"·"}</span>
    <span>—</span>
    <span>12 / 40</span>
  </div>
);
`,
      "src/app.test.tsx": "export const Fixture = () => <p>Save</p>;\n",
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("leaves the vendored coss ui components alone but checks the rest of @slugbase/ui", () => {
    const ui = {
      "package.json": JSON.stringify({ name: "@slugbase/ui" }),
      "src/components/ui/close.tsx": 'export const Close = () => <button aria-label="Close" />;\n',
    };
    const vendoredOnly = check(ui);
    expect(vendoredOnly.stderr).toBe("");
    expect(vendoredOnly.code).toBe(0);

    const own = check({ ...ui, "src/patterns/banner.tsx": "export const Banner = () => <p>Heads up</p>;\n" });
    expect(own.code).toBe(1);
    expect(own.stderr).toContain("src/patterns/banner.tsx");
    expect(own.stderr).not.toContain("components/ui");
  });
});
