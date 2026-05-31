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
    // Auth — login
    "auth.login.title": "Sign in to SlugBase",
    "auth.login.subtitle": "Welcome back. Enter your credentials to continue.",
    "auth.login.email_label": "Email",
    "auth.login.email_placeholder": "you@company.com",
    "auth.login.password_label": "Password",
    "auth.login.password_forgot_link": "Forgot password?",
    "auth.login.password_show": "Show password",
    "auth.login.password_hide": "Hide password",
    "auth.login.submit": "Sign in",
    "auth.login.submit_loading": "Signing in…",
    "auth.login.error_invalid": "Incorrect email or password.",
    "auth.login.error_generic": "Something went wrong. Please try again.",
    // Auth — brand rail
    "auth.brand.headline": "Every bookmark, one short link away.",
    "auth.brand.subline":
      "Save, organize, and forward your links from a single keyboard-driven workspace.",
    "auth.brand.footer": "Self-hosted · Open source",
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
    "error.boundary.message":
      "Ein unerwarteter Fehler ist aufgetreten. Du kannst es erneut versuchen.",
    "error.boundary.retry": "Erneut versuchen",
    // Auth — login
    "auth.login.title": "Bei SlugBase anmelden",
    "auth.login.subtitle":
      "Willkommen zurück. Gib deine Zugangsdaten ein, um fortzufahren.",
    "auth.login.email_label": "E-Mail",
    "auth.login.email_placeholder": "du@unternehmen.de",
    "auth.login.password_label": "Passwort",
    "auth.login.password_forgot_link": "Passwort vergessen?",
    "auth.login.password_show": "Passwort anzeigen",
    "auth.login.password_hide": "Passwort verbergen",
    "auth.login.submit": "Anmelden",
    "auth.login.submit_loading": "Wird angemeldet…",
    "auth.login.error_invalid": "E-Mail oder Passwort ist falsch.",
    "auth.login.error_generic":
      "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    // Auth — brand rail
    "auth.brand.headline": "Jedes Lesezeichen, ein kurzer Link entfernt.",
    "auth.brand.subline":
      "Speichere, organisiere und leite deine Links aus einem tastaturgesteuerten Arbeitsbereich weiter.",
    "auth.brand.footer": "Self-hosted · Open Source",
  },
} as const;

export type MessageKey = keyof (typeof staticMessages)["en"];
