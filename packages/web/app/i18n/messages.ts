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
    "auth.login.no_account_prompt": "Don't have an account?",
    "auth.login.no_account_link": "Create account",
    // Auth — login extras
    "auth.login.forgot_password_link": "Forgot password?",
    "auth.login.reset_success":
      "Your password has been updated. You can now sign in with your new password.",
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
    // Auth — register
    "register.title": "Create your account",
    "register.subtitle": "Start managing your bookmarks and short links.",
    "register.name_label": "Full name",
    "register.name_placeholder": "Ada Lovelace",
    "register.email_label": "Email",
    "register.email_placeholder": "you@company.com",
    "register.password_label": "Password",
    "register.password_show": "Show password",
    "register.password_hide": "Hide password",
    "register.password_strength.very_weak": "Very weak",
    "register.password_strength.weak": "Weak",
    "register.password_strength.fair": "Fair",
    "register.password_strength.strong": "Strong",
    "register.submit": "Create account",
    "register.submit_loading": "Creating account…",
    "register.sign_in_prompt": "Already have an account?",
    "register.sign_in_link": "Sign in",
    "register.error_disabled":
      "Registration is not open on this instance.",
    "register.error_email_taken":
      "An account with that email already exists.",
    "register.error_generic":
      "Something went wrong. Please try again.",
    "register.error_invalid_email": "Please enter a valid email address.",
    "register.error_password_too_short":
      "Password must be at least 8 characters.",
    "register.verify_email_title": "Check your email",
    "register.verify_email_message":
      "We sent a verification link to your email address. Please check your inbox to activate your account.",
    // Setup — first-run
    "setup.title": "Set up your instance",
    "setup.subtitle":
      "Create the initial admin account and your first workspace.",
    "setup.name_label": "Your name",
    "setup.name_placeholder": "Ada Lovelace",
    "setup.email_label": "Email",
    "setup.email_placeholder": "admin@company.com",
    "setup.password_label": "Password",
    "setup.password_show": "Show password",
    "setup.password_hide": "Hide password",
    "setup.password_strength.very_weak": "Very weak",
    "setup.password_strength.weak": "Weak",
    "setup.password_strength.fair": "Fair",
    "setup.password_strength.strong": "Strong",
    "setup.workspace_name_label": "Workspace name",
    "setup.workspace_name_placeholder": "Acme Inc.",
    "setup.workspace_slug_label": "Workspace slug",
    "setup.workspace_slug_placeholder": "acme",
    "setup.workspace_slug_hint":
      "Lowercase letters, digits, and hyphens only.",
    "setup.submit": "Finish setup",
    "setup.submit_loading": "Setting up…",
    "setup.error_already_done": "This instance is already configured.",
    "setup.error_generic": "Something went wrong. Please try again.",
    "setup.error_invalid_email": "Please enter a valid email address.",
    "setup.error_password_too_short":
      "Password must be at least 8 characters.",
    "setup.error_invalid_slug":
      "Slug may only contain lowercase letters, digits, and hyphens.",
    // Password reset — forgot password screen
    "password_reset.forgot.title": "Reset your password",
    "password_reset.forgot.subtitle":
      "Enter your email and we'll send you a link to set a new password.",
    "password_reset.forgot.email_label": "Email",
    "password_reset.forgot.email_placeholder": "you@company.com",
    "password_reset.forgot.submit": "Send reset link",
    "password_reset.forgot.submit_loading": "Sending…",
    "password_reset.forgot.back_to_sign_in": "Back to sign in",
    "password_reset.forgot.success_title": "Check your email",
    "password_reset.forgot.success_message":
      "If an account exists for that email address, you'll receive a reset link shortly. It expires in 30 minutes.",
    "password_reset.forgot.non_enumerating_note":
      "We always respond the same way, whether or not an account matches — this never reveals who has an account.",
    "password_reset.forgot.error_generic": "Something went wrong. Please try again.",
    // Password reset — set new password screen
    "password_reset.set.title": "Set a new password",
    "password_reset.set.subtitle": "Choose a new password. This reset link is single-use.",
    "password_reset.set.new_password_label": "New password",
    "password_reset.set.new_password_placeholder": "New password",
    "password_reset.set.confirm_password_label": "Confirm password",
    "password_reset.set.confirm_password_placeholder": "Re-enter password",
    "password_reset.set.password_show": "Show password",
    "password_reset.set.password_hide": "Hide password",
    "password_reset.set.submit": "Update password",
    "password_reset.set.submit_loading": "Updating…",
    "password_reset.set.back_to_sign_in": "Back to sign in",
    "password_reset.set.error_token_invalid":
      "This reset link is invalid or has expired. Please request a new one.",
    "password_reset.set.error_missing_token":
      "No reset token found. Please request a new reset link.",
    "password_reset.set.error_generic": "Something went wrong. Please try again.",
    "password_reset.set.error_passwords_mismatch": "Passwords do not match.",
    "password_reset.set.passwords_match": "Passwords match",
    "password_reset.set.passwords_mismatch": "Passwords don't match yet",
    "password_reset.set.strength_too_short": "Too short",
    "password_reset.set.strength_weak": "Weak",
    "password_reset.set.strength_fair": "Fair",
    "password_reset.set.strength_good": "Good",
    "password_reset.set.strength_strong": "Strong",
    "password_reset.set.strength_empty": "Password strength",
    "password_reset.set.strength_requirements": "12+ chars · mixed case · number",
    // Command palette
    "command_palette.dialog_label": "Command palette",
    "command_palette.input_placeholder": "Search bookmarks or type a command…",
    "command_palette.clear_query": "Clear search",
    "command_palette.search_loading": "Searching…",
    "command_palette.no_results": 'No results for "{query}"',
    "command_palette.no_results_hint": "Try a different search, or press C to create a new bookmark.",
    "command_palette.see_all_bookmarks": 'See all {count} bookmarks matching "{query}"',
    "command_palette.bookmark_count": "{count} bookmarks",
    "command_palette.group.create": "Create",
    "command_palette.group.go_to": "Go to",
    "command_palette.group.workspace": "Workspace",
    "command_palette.group.bookmarks": "Bookmarks",
    "command_palette.group.folders": "Folders",
    "command_palette.group.tags": "Tags",
    "command_palette.action.new_bookmark": "New bookmark",
    "command_palette.action.new_folder": "New folder",
    "command_palette.action.new_tag": "New tag",
    "command_palette.action.go_bookmarks": "Go to Bookmarks",
    "command_palette.action.go_folders": "Go to Folders",
    "command_palette.action.go_tags": "Go to Tags",
    "command_palette.action.go_settings": "Go to Settings",
    "command_palette.action.switch_workspace": "Switch workspace",
    "command_palette.footer.navigate": "navigate",
    "command_palette.footer.select": "select",
    "command_palette.footer.open_new_tab": "open in new tab",
    "command_palette.footer.close": "close",
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
    "auth.login.no_account_prompt": "Noch kein Konto?",
    "auth.login.no_account_link": "Konto erstellen",
    // Auth — login extras
    "auth.login.forgot_password_link": "Passwort vergessen?",
    "auth.login.reset_success":
      "Dein Passwort wurde aktualisiert. Du kannst dich jetzt mit deinem neuen Passwort anmelden.",
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
    // Auth — register
    "register.title": "Konto erstellen",
    "register.subtitle":
      "Verwalte deine Lesezeichen und Kurzlinks.",
    "register.name_label": "Vollständiger Name",
    "register.name_placeholder": "Ada Lovelace",
    "register.email_label": "E-Mail",
    "register.email_placeholder": "du@unternehmen.de",
    "register.password_label": "Passwort",
    "register.password_show": "Passwort anzeigen",
    "register.password_hide": "Passwort verbergen",
    "register.password_strength.very_weak": "Sehr schwach",
    "register.password_strength.weak": "Schwach",
    "register.password_strength.fair": "Mittel",
    "register.password_strength.strong": "Stark",
    "register.submit": "Konto erstellen",
    "register.submit_loading": "Konto wird erstellt…",
    "register.sign_in_prompt": "Bereits ein Konto vorhanden?",
    "register.sign_in_link": "Anmelden",
    "register.error_disabled":
      "Registrierung ist auf dieser Instanz nicht geöffnet.",
    "register.error_email_taken":
      "Ein Konto mit dieser E-Mail-Adresse existiert bereits.",
    "register.error_generic":
      "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    "register.error_invalid_email":
      "Bitte gib eine gültige E-Mail-Adresse ein.",
    "register.error_password_too_short":
      "Das Passwort muss mindestens 8 Zeichen lang sein.",
    "register.verify_email_title": "Prüfe deine E-Mails",
    "register.verify_email_message":
      "Wir haben einen Bestätigungslink an deine E-Mail-Adresse gesendet. Bitte überprüfe deinen Posteingang, um dein Konto zu aktivieren.",
    // Setup — first-run
    "setup.title": "Instanz einrichten",
    "setup.subtitle":
      "Erstelle das initiale Admin-Konto und deinen ersten Arbeitsbereich.",
    "setup.name_label": "Dein Name",
    "setup.name_placeholder": "Ada Lovelace",
    "setup.email_label": "E-Mail",
    "setup.email_placeholder": "admin@unternehmen.de",
    "setup.password_label": "Passwort",
    "setup.password_show": "Passwort anzeigen",
    "setup.password_hide": "Passwort verbergen",
    "setup.password_strength.very_weak": "Sehr schwach",
    "setup.password_strength.weak": "Schwach",
    "setup.password_strength.fair": "Mittel",
    "setup.password_strength.strong": "Stark",
    "setup.workspace_name_label": "Name des Arbeitsbereichs",
    "setup.workspace_name_placeholder": "Muster GmbH",
    "setup.workspace_slug_label": "Slug des Arbeitsbereichs",
    "setup.workspace_slug_placeholder": "muster",
    "setup.workspace_slug_hint":
      "Nur Kleinbuchstaben, Ziffern und Bindestriche.",
    "setup.submit": "Einrichtung abschließen",
    "setup.submit_loading": "Wird eingerichtet…",
    "setup.error_already_done": "Diese Instanz ist bereits konfiguriert.",
    "setup.error_generic":
      "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    "setup.error_invalid_email":
      "Bitte gib eine gültige E-Mail-Adresse ein.",
    "setup.error_password_too_short":
      "Das Passwort muss mindestens 8 Zeichen lang sein.",
    "setup.error_invalid_slug":
      "Der Slug darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten.",
    // Password reset — forgot password screen
    "password_reset.forgot.title": "Passwort zurücksetzen",
    "password_reset.forgot.subtitle":
      "Gib deine E-Mail ein und wir senden dir einen Link zum Festlegen eines neuen Passworts.",
    "password_reset.forgot.email_label": "E-Mail",
    "password_reset.forgot.email_placeholder": "du@unternehmen.de",
    "password_reset.forgot.submit": "Zurücksetzen-Link senden",
    "password_reset.forgot.submit_loading": "Wird gesendet…",
    "password_reset.forgot.back_to_sign_in": "Zurück zur Anmeldung",
    "password_reset.forgot.success_title": "Prüfe deine E-Mail",
    "password_reset.forgot.success_message":
      "Falls ein Konto mit dieser E-Mail-Adresse existiert, erhältst du in Kürze einen Zurücksetzen-Link. Er läuft in 30 Minuten ab.",
    "password_reset.forgot.non_enumerating_note":
      "Wir antworten immer auf die gleiche Weise, unabhängig davon, ob ein Konto gefunden wurde — so wird nie verraten, wer ein Konto hat.",
    "password_reset.forgot.error_generic": "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    // Password reset — set new password screen
    "password_reset.set.title": "Neues Passwort festlegen",
    "password_reset.set.subtitle":
      "Wähle ein neues Passwort. Dieser Zurücksetzen-Link kann nur einmal verwendet werden.",
    "password_reset.set.new_password_label": "Neues Passwort",
    "password_reset.set.new_password_placeholder": "Neues Passwort",
    "password_reset.set.confirm_password_label": "Passwort bestätigen",
    "password_reset.set.confirm_password_placeholder": "Passwort erneut eingeben",
    "password_reset.set.password_show": "Passwort anzeigen",
    "password_reset.set.password_hide": "Passwort verbergen",
    "password_reset.set.submit": "Passwort aktualisieren",
    "password_reset.set.submit_loading": "Wird aktualisiert…",
    "password_reset.set.back_to_sign_in": "Zurück zur Anmeldung",
    "password_reset.set.error_token_invalid":
      "Dieser Zurücksetzen-Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.",
    "password_reset.set.error_missing_token":
      "Kein Zurücksetzen-Token gefunden. Bitte fordere einen neuen Zurücksetzen-Link an.",
    "password_reset.set.error_generic": "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    "password_reset.set.error_passwords_mismatch": "Passwörter stimmen nicht überein.",
    "password_reset.set.passwords_match": "Passwörter stimmen überein",
    "password_reset.set.passwords_mismatch": "Passwörter stimmen noch nicht überein",
    "password_reset.set.strength_too_short": "Zu kurz",
    "password_reset.set.strength_weak": "Schwach",
    "password_reset.set.strength_fair": "Mittel",
    "password_reset.set.strength_good": "Gut",
    "password_reset.set.strength_strong": "Stark",
    "password_reset.set.strength_empty": "Passwortstärke",
    "password_reset.set.strength_requirements": "12+ Zeichen · Groß-/Kleinschreibung · Zahl",
    // Command palette
    "command_palette.dialog_label": "Befehls-Palette",
    "command_palette.input_placeholder": "Lesezeichen suchen oder Befehl eingeben…",
    "command_palette.clear_query": "Suche löschen",
    "command_palette.search_loading": "Suche läuft…",
    "command_palette.no_results": 'Keine Ergebnisse für „{query}"',
    "command_palette.no_results_hint": "Versuche eine andere Suche oder drücke C, um ein neues Lesezeichen zu erstellen.",
    "command_palette.see_all_bookmarks": 'Alle {count} Lesezeichen anzeigen, die „{query}" entsprechen',
    "command_palette.bookmark_count": "{count} Lesezeichen",
    "command_palette.group.create": "Erstellen",
    "command_palette.group.go_to": "Gehe zu",
    "command_palette.group.workspace": "Arbeitsbereich",
    "command_palette.group.bookmarks": "Lesezeichen",
    "command_palette.group.folders": "Ordner",
    "command_palette.group.tags": "Tags",
    "command_palette.action.new_bookmark": "Neues Lesezeichen",
    "command_palette.action.new_folder": "Neuer Ordner",
    "command_palette.action.new_tag": "Neuer Tag",
    "command_palette.action.go_bookmarks": "Gehe zu Lesezeichen",
    "command_palette.action.go_folders": "Gehe zu Ordnern",
    "command_palette.action.go_tags": "Gehe zu Tags",
    "command_palette.action.go_settings": "Gehe zu Einstellungen",
    "command_palette.action.switch_workspace": "Arbeitsbereich wechseln",
    "command_palette.footer.navigate": "navigieren",
    "command_palette.footer.select": "auswählen",
    "command_palette.footer.open_new_tab": "in neuem Tab öffnen",
    "command_palette.footer.close": "schließen",
  },
} as const;

export type MessageKey = keyof (typeof staticMessages)["en"];
