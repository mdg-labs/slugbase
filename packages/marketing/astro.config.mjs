import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

const marketingOrigin =
  process.env.PUBLIC_MARKETING_ORIGIN?.trim() ||
  process.env.MARKETING_ORIGIN?.trim();

export default defineConfig({
  site: marketingOrigin || "http://localhost:4321",
  integrations: [mdx()],
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
