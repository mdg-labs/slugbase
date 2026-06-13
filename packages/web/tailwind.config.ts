import type { Config } from "tailwindcss";
import { slugbaseTailwindPreset } from "@slugbase/ui/tailwind";

export default {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "../ui/src/**/*.{js,jsx,ts,tsx}"],
  presets: [slugbaseTailwindPreset],
} satisfies Config;
