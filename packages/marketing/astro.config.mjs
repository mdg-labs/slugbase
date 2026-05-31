import { defineConfig } from "astro/config";

export default defineConfig({
  i18n: {
    defaultLocale: "en",
    locales: ["en", "de"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  vite: {
    envPrefix: ["PUBLIC_"],
  },
});
