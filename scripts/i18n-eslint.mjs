// The literal-string rule of D19, shared by `eslint` (eslint.config.js) and
// `pnpm i18n:check` (check-i18n.mjs) so both apply the same policy.
import i18next from "eslint-plugin-i18next";

const upstream = i18next.rules["no-literal-string"];

/** Whether a node sits inside content browser translation must leave alone: `translate="no"` or `<NoTranslate>`. */
function insideNoTranslate(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "JSXElement") {
      continue;
    }
    const { name, attributes } = current.openingElement;
    if (name.type === "JSXIdentifier" && name.name === "NoTranslate") {
      return true;
    }
    const translate = attributes.find((attribute) => attribute.type === "JSXAttribute" && attribute.name.name === "translate");
    const value = translate?.value?.type === "JSXExpressionContainer" ? translate.value.expression : translate?.value;
    if (value?.type === "Literal" && value.value === "no") {
      return true;
    }
  }
  return false;
}

// eslint-plugin-i18next has no way to allow the content of an element by an
// attribute, so reports are filtered here.
const noLiteralString = {
  meta: upstream.meta,
  create(context) {
    const filtered = Object.create(context, {
      report: {
        value: (descriptor) => {
          if (!insideNoTranslate(descriptor.node)) {
            context.report(descriptor);
          }
        },
      },
    });
    return upstream.create(filtered);
  },
};

export const i18nPlugin = { rules: { "no-literal-string": noLiteralString } };

// `jsx-only` checks every literal inside JSX, `{"Save"}` and `{ok ? "Yes" : "No"}`
// as well as text. An attribute is checked unless it is on the list of those
// that never hold words (names, enums, URLs, sizes), so `aria-label`, `title`,
// `placeholder`, `alt` and any attribute not listed here are checked, and so is
// JSX passed through an attribute such as `render`. Anything made of symbols,
// punctuation, digits and spaces needs no translation. The default allowance
// for all-capitals words is dropped: "OK" is a word in JSX.
const NON_TEXT_ATTRIBUTES = [
  "className",
  "class",
  "style",
  "type",
  "key",
  "id",
  "name",
  "value",
  "defaultValue",
  "href",
  "to",
  "src",
  "srcSet",
  "sizes",
  "target",
  "rel",
  "role",
  "variant",
  "size",
  "side",
  "align",
  "orientation",
  "htmlFor",
  "tabIndex",
  "translate",
  "lang",
  "dir",
  "autoComplete",
  "inputMode",
  "loading",
  "as",
  "slot",
  "width",
  "height",
  "viewBox",
  "xmlns",
  "d",
  "fill",
  "stroke",
  "strokeWidth",
  "data-.*",
  "aria-(?!label$|description$|placeholder$|roledescription$|valuetext$).*",
];

export const LITERAL_STRING_OPTIONS = {
  mode: "jsx-only",
  "should-validate-template": true,
  "jsx-components": { exclude: ["Trans"] },
  "jsx-attributes": { exclude: NON_TEXT_ATTRIBUTES },
  words: { exclude: [/^[\p{S}\p{P}\p{N}\p{Z}]+$/u] },
  message: "Move this text into the i18n catalogs (D19)",
};

/**
 * The coss ui components vendored into @slugbase/ui (packages/ui/src/components/ui)
 * are third-party sources, changed only by re-adding them with the shadcn CLI,
 * and several carry English text of their own ("Close", "Toggle Sidebar").
 * They are outside the rule; the patterns of @slugbase/ui itself are inside it.
 */
export const VENDORED_UI = "packages/ui/src/components/ui/**";

/**
 * The flat-config block that makes a literal string in the JSX of `files` an
 * error. Test files hold fixtures, not UI. `vendored` is the vendored-component
 * pattern relative to the directory ESLint runs in, or null for none.
 */
export function literalStringConfig(files, vendored = VENDORED_UI) {
  return {
    files,
    ignores: vendored === null ? ["**/*.test.tsx"] : ["**/*.test.tsx", vendored],
    plugins: { i18next: i18nPlugin },
    rules: { "i18next/no-literal-string": ["error", LITERAL_STRING_OPTIONS] },
  };
}
