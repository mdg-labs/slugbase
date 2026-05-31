/** Static Tolgee catalog (en/de) — synced to Tolgee project 4 in later tasks. */
export const staticMessages = {
  en: {
    "app.shell.brand": "SlugBase",
    "app.shell.workspace_default": "Personal workspace",
    "app.home.welcome": "Welcome to your workspace.",
    "theme.switcher.group": "Theme",
    "theme.switcher.light": "Light",
    "theme.switcher.dark": "Dark",
    "theme.switcher.auto": "Auto",
    "error.boundary.title": "Something went wrong",
    "error.boundary.message": "An unexpected error occurred. You can try again.",
    "error.boundary.retry": "Try again",
  },
  de: {
    "app.shell.brand": "SlugBase",
    "app.shell.workspace_default": "Persönlicher Arbeitsbereich",
    "app.home.welcome": "Willkommen in deinem Arbeitsbereich.",
    "theme.switcher.group": "Design",
    "theme.switcher.light": "Hell",
    "theme.switcher.dark": "Dunkel",
    "theme.switcher.auto": "Automatisch",
    "error.boundary.title": "Etwas ist schiefgelaufen",
    "error.boundary.message": "Ein unerwarteter Fehler ist aufgetreten. Du kannst es erneut versuchen.",
    "error.boundary.retry": "Erneut versuchen",
  },
} as const;

export type MessageKey = keyof (typeof staticMessages)["en"];
