import type { Config } from "tailwindcss";
import { slugbaseTailwindPreset } from "./src/tailwind/token-theme.js";

/** Shared Tailwind preset - consume via `presets` in app packages. */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [slugbaseTailwindPreset],
};

export default config;
export { slugbaseTailwindPreset, resolveTokenColor, slugbaseCssVarColors } from "./src/tailwind/token-theme.js";
