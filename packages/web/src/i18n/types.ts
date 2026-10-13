import type { Catalog } from "./locales.ts";

// Keys passed to `t()` are checked against the English catalog, so an unknown
// key is a compile error.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Catalog };
  }
}
