/** @type {import("@ladle/react").UserConfig} */
export default {
  stories: "stories/**/*.stories.tsx",
  // Ladle looks for a Vite config in the working directory unless told where it is.
  viteConfig: ".ladle/vite.config.mjs",
  // Dark is the designed default (doc 03 "Theme tokens"); the toolbar switches to light.
  addons: {
    theme: { enabled: true, defaultState: "dark" },
    a11y: { enabled: true },
  },
};
