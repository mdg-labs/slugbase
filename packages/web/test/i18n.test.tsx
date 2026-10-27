import { render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../src/i18n/create-i18n.ts";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { CATALOGS, LOCALES } from "../src/i18n/locales.ts";
import { NoTranslate } from "../src/i18n/no-translate.tsx";
import { resolveLanguage } from "../src/i18n/resolve-language.ts";
import { useFormat } from "../src/i18n/use-format.ts";
import "./support.tsx";

function acceptLanguages(...languages: string[]): void {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

beforeEach(() => {
  acceptLanguages("en-US", "en");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("resolveLanguage", () => {
  it("takes the account preference before the browser, the server default and English", () => {
    expect(resolveLanguage({ preference: "de", accepted: ["en-US"], defaultLocale: "en" })).toBe("de");
    expect(resolveLanguage({ preference: "en", accepted: ["de-DE"], defaultLocale: "de" })).toBe("en");
  });

  it("takes the first supported language the browser accepts before the server default", () => {
    expect(resolveLanguage({ accepted: ["fr-CH", "de-AT", "en"], defaultLocale: "en" })).toBe("de");
    expect(resolveLanguage({ preference: null, accepted: ["DE_de"] })).toBe("de");
  });

  it("falls back to the server default when the browser accepts nothing supported, then to English", () => {
    expect(resolveLanguage({ accepted: ["fr", "ja"], defaultLocale: "de" })).toBe("de");
    expect(resolveLanguage({ accepted: ["fr"], defaultLocale: "es" })).toBe("en");
    expect(resolveLanguage({})).toBe("en");
  });

  it("does not take a tag that only starts like a supported language", () => {
    expect(resolveLanguage({ preference: "dex", accepted: ["deu"], defaultLocale: "den" })).toBe("en");
  });
});

describe("the catalogs", () => {
  it("hold the same keys in every language", () => {
    const keys = (value: object, prefix = ""): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "object" && child !== null ? keys(child as object, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    const [first, ...others] = LOCALES.map((locale) => keys(CATALOGS[locale]).sort());
    for (const other of others) {
      expect(other).toEqual(first);
    }
  });

  it("type their keys: a key that is not in the English catalog does not compile", () => {
    function Probe() {
      const { t } = useTranslation();
      // @ts-expect-error #66 an unknown key must be a compile error
      return <p>{t("landing.title")}</p>;
    }
    expect(Probe).toBeTypeOf("function");
  });
});

describe("ICU messages", () => {
  const resources = {
    en: {
      translation: {
        items: "{count, plural, =0 {No bookmarks} one {# bookmark} other {# bookmarks}}",
        kind: "{kind, select, folder {Folder} tag {Tag} other {Item}}",
      },
    },
    de: {
      translation: {
        items: "{count, plural, =0 {Keine Lesezeichen} one {# Lesezeichen} other {# Lesezeichen}}",
        kind: "{kind, select, folder {Ordner} tag {Schlagwort} other {Element}}",
      },
    },
  };
  const translate = (language: "en" | "de", key: string, options: Record<string, unknown>): string => {
    // The ad-hoc catalogs are not the typed one, so keys are passed as plain strings.
    const t = createI18n(language, resources).getFixedT(language) as unknown as (key: string, options: object) => unknown;
    const text = t(key, options);
    if (typeof text !== "string") {
      throw new Error(`"${key}" did not translate to a string`);
    }
    return text;
  };

  it("choose the German plural category", () => {
    expect(translate("de", "items", { count: 0 })).toBe("Keine Lesezeichen");
    expect(translate("de", "items", { count: 1 })).toBe("1 Lesezeichen");
    expect(translate("de", "items", { count: 1234 })).toBe("1.234 Lesezeichen");
  });

  it("choose the English plural category", () => {
    expect(translate("en", "items", { count: 1 })).toBe("1 bookmark");
    expect(translate("en", "items", { count: 2 })).toBe("2 bookmarks");
  });

  it("choose the select branch in both languages", () => {
    expect(translate("de", "kind", { kind: "folder" })).toBe("Ordner");
    expect(translate("de", "kind", { kind: "other-thing" })).toBe("Element");
    expect(translate("en", "kind", { kind: "tag" })).toBe("Tag");
  });
});

describe("I18nProvider", () => {
  function Heading() {
    const { t } = useTranslation();
    return <h1>{t("home.tagline")}</h1>;
  }

  it("sets lang on <html> and translates for the account preference", () => {
    render(
      <I18nProvider preference="de">
        <Heading />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe("de");
    expect(screen.getByRole("heading").textContent).toBe("Lesezeichen mit kurzen, privaten Slugs.");
  });

  it("follows the browser's languages, then the server default", () => {
    acceptLanguages("de-AT");
    const first = render(
      <I18nProvider defaultLocale="en">
        <Heading />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe("de");
    first.unmount();

    acceptLanguages("fr");
    render(
      <I18nProvider defaultLocale="de">
        <Heading />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe("de");
  });

  it("switches the text and lang when the language changes, without remounting", () => {
    const view = render(
      <I18nProvider preference="en">
        <Heading />
      </I18nProvider>,
    );
    const heading = screen.getByRole("heading");
    expect(heading.textContent).toBe("Bookmarks with short, private slugs.");
    expect(document.documentElement.lang).toBe("en");

    view.rerender(
      <I18nProvider preference="de">
        <Heading />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading")).toBe(heading);
    expect(heading.textContent).toBe("Lesezeichen mit kurzen, privaten Slugs.");
    expect(document.documentElement.lang).toBe("de");
  });
});

describe("useFormat", () => {
  const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

  function Formatted() {
    const format = useFormat();
    return (
      <ul>
        <li data-testid="date">{format.date(NOW, { dateStyle: "long", timeZone: "UTC" })}</li>
        <li data-testid="number">{format.number(1234567.5)}</li>
        <li data-testid="hours">{format.relativeTime(NOW - 2 * 3600_000, NOW)}</li>
        <li data-testid="yesterday">{format.relativeTime(NOW - 24 * 3600_000, NOW)}</li>
        <li data-testid="days">{format.relativeTime(NOW + 3 * 24 * 3600_000, NOW)}</li>
        <li data-testid="now">{format.relativeTime(NOW, NOW)}</li>
      </ul>
    );
  }
  const read = (id: string) => screen.getByTestId(id).textContent;

  it("formats in German", () => {
    render(
      <I18nProvider preference="de">
        <Formatted />
      </I18nProvider>,
    );
    expect(read("date")).toBe("13. Oktober 2026");
    expect(read("number")).toBe("1.234.567,5");
    expect(read("hours")).toBe("vor 2 Std.");
    expect(read("yesterday")).toBe("gestern");
    expect(read("days")).toBe("in 3 Tagen");
    expect(read("now")).toBe("jetzt");
  });

  it("formats in English", () => {
    render(
      <I18nProvider preference="en">
        <Formatted />
      </I18nProvider>,
    );
    expect(read("date")).toBe("October 13, 2026");
    expect(read("number")).toBe("1,234,567.5");
    expect(read("hours")).toBe("2 hr. ago");
    expect(read("yesterday")).toBe("yesterday");
    expect(read("days")).toBe("in 3 days");
    expect(read("now")).toBe("now");
  });

  it("follows a language switch", () => {
    const view = render(
      <I18nProvider preference="en">
        <Formatted />
      </I18nProvider>,
    );
    view.rerender(
      <I18nProvider preference="de">
        <Formatted />
      </I18nProvider>,
    );
    expect(read("number")).toBe("1.234.567,5");
  });
});

describe("NoTranslate", () => {
  it("marks its content so browser translation leaves it alone", () => {
    render(
      <p>
        Slug <NoTranslate>docs-home</NoTranslate>
      </p>,
    );
    expect(screen.getByText("docs-home").getAttribute("translate")).toBe("no");
  });
});
