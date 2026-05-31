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
    // Auth — MFA challenge
    "mfa.challenge.title": "Two-factor authentication",
    "mfa.challenge.subtitle_totp":
      "Enter the 6-digit code from your authenticator app to finish signing in.",
    "mfa.challenge.subtitle_backup":
      "Enter one of your single-use backup codes. Each code works only once.",
    "mfa.challenge.label_code": "Authentication code",
    "mfa.challenge.label_backup_code": "Backup code",
    "mfa.challenge.placeholder_backup": "XXXX-XXXX-XXXX",
    "mfa.challenge.submit": "Verify and continue",
    "mfa.challenge.submit_loading": "Verifying…",
    "mfa.challenge.toggle_use_backup": "Use a backup code instead",
    "mfa.challenge.toggle_use_totp": "Use your authenticator app instead",
    "mfa.challenge.back_to_signin": "Back to sign in",
    "mfa.challenge.error_invalid":
      "Verification failed. Please check your code and try again.",
    "mfa.challenge.error_generic": "Something went wrong. Please try again.",
    "mfa.challenge.code_input_aria": "Authentication code input",
    "mfa.challenge.digit_aria": "Digit {n}",
    // Auth — MFA enrollment
    "mfa.enroll.title": "Set up two-factor authentication",
    "mfa.enroll.subtitle":
      "Scan this QR code with your authenticator app, then enter the 6-digit confirmation code.",
    "mfa.enroll.qr_alt": "QR code for authenticator app",
    "mfa.enroll.text_secret_label": "Can\u2019t scan? Enter this code manually:",
    "mfa.enroll.label_confirm_code": "Confirmation code",
    "mfa.enroll.submit_confirm": "Activate MFA",
    "mfa.enroll.submit_loading": "Activating\u2026",
    "mfa.enroll.error_invalid": "Code is incorrect. Please try again.",
    "mfa.enroll.error_generic": "Something went wrong. Please try again.",
    // Auth — MFA backup codes
    "mfa.backup_codes.title": "Save your backup codes",
    "mfa.backup_codes.warning":
      "These codes are shown only once. Save them somewhere safe \u2014 you will need them if you lose access to your authenticator app.",
    "mfa.backup_codes.copy": "Copy all codes",
    "mfa.backup_codes.copied": "Copied!",
    "mfa.backup_codes.confirm_label":
      "I have saved my backup codes in a safe place",
    "mfa.backup_codes.submit": "Continue",
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
    // Auth — MFA challenge
    "mfa.challenge.title": "Zwei-Faktor-Authentifizierung",
    "mfa.challenge.subtitle_totp":
      "Gib den 6-stelligen Code aus deiner Authentifizierungs-App ein, um die Anmeldung abzuschlie\u00dfen.",
    "mfa.challenge.subtitle_backup":
      "Gib einen deiner Einmal-Backup-Codes ein. Jeder Code ist nur einmal verwendbar.",
    "mfa.challenge.label_code": "Authentifizierungscode",
    "mfa.challenge.label_backup_code": "Backup-Code",
    "mfa.challenge.placeholder_backup": "XXXX-XXXX-XXXX",
    "mfa.challenge.submit": "Verifizieren und fortfahren",
    "mfa.challenge.submit_loading": "Wird verifiziert\u2026",
    "mfa.challenge.toggle_use_backup":
      "Stattdessen einen Backup-Code verwenden",
    "mfa.challenge.toggle_use_totp":
      "Stattdessen die Authentifizierungs-App verwenden",
    "mfa.challenge.back_to_signin": "Zur\u00fcck zur Anmeldung",
    "mfa.challenge.error_invalid":
      "Verifizierung fehlgeschlagen. Bitte \u00fcberpr\u00fcfe deinen Code und versuche es erneut.",
    "mfa.challenge.error_generic":
      "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    "mfa.challenge.code_input_aria": "Authentifizierungscode-Eingabe",
    "mfa.challenge.digit_aria": "Ziffer {n}",
    // Auth — MFA enrollment
    "mfa.enroll.title": "Zwei-Faktor-Authentifizierung einrichten",
    "mfa.enroll.subtitle":
      "Scanne diesen QR-Code mit deiner Authentifizierungs-App und gib dann den 6-stelligen Best\u00e4tigungscode ein.",
    "mfa.enroll.qr_alt": "QR-Code f\u00fcr die Authentifizierungs-App",
    "mfa.enroll.text_secret_label": "Kein Scan m\u00f6glich? Gib diesen Code manuell ein:",
    "mfa.enroll.label_confirm_code": "Best\u00e4tigungscode",
    "mfa.enroll.submit_confirm": "MFA aktivieren",
    "mfa.enroll.submit_loading": "Wird aktiviert\u2026",
    "mfa.enroll.error_invalid": "Code ist falsch. Bitte versuche es erneut.",
    "mfa.enroll.error_generic":
      "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    // Auth — MFA backup codes
    "mfa.backup_codes.title": "Backup-Codes speichern",
    "mfa.backup_codes.warning":
      "Diese Codes werden nur einmal angezeigt. Bewahre sie an einem sicheren Ort auf \u2014 du ben\u00f6tigst sie, wenn du keinen Zugriff mehr auf deine Authentifizierungs-App hast.",
    "mfa.backup_codes.copy": "Alle Codes kopieren",
    "mfa.backup_codes.copied": "Kopiert!",
    "mfa.backup_codes.confirm_label":
      "Ich habe meine Backup-Codes an einem sicheren Ort gespeichert",
    "mfa.backup_codes.submit": "Fortfahren",
  },
} as const;

export type MessageKey = keyof (typeof staticMessages)["en"];
