# Privacy Policy / Datenschutzerklärung

> **Zur anwaltlichen Freigabe vor Veröffentlichung. / For legal review prior to publication.**
> [DATUM / DATE] nach Freigabe eintragen.
> Prüfpunkte für den Anwalt:
> - Transfer Impact Assessments (TIA) für OpenAI (USA) und Postmark (USA) vor Veröffentlichung vorlegen
> - SKV/SCCs für alle US-Anbieter: Aktualität prüfen (post-Schrems-II-Konformität)
> - OpenAI-Anbieter: bei Wechsel zu EU-Anbieter (z. B. Infomaniak Euphoria) §§ 3.3 und 7 aktualisieren und US-Transfer-Hinweis entfernen
> - Einwilligungs-Banner: Implementierung auf TKG 2021 § 165 Abs. 3 prüfen (technisch notwendige Cookies vs. einwilligungspflichtige Cookies)
> - Aufbewahrungsfristen: auf Konformität mit BAO § 132 / UGB § 212 prüfen

---

## English

### Privacy Policy

_Last updated: [DATE]_

#### 1. Controller

The controller within the meaning of Article 4(7) GDPR is:

Michael David Guggenbichler (Einzelunternehmer / Sole Proprietor)
Linzer Straße 17
4100 Ottensheim
Austria
VAT UID: ATU82945789
hello@slugbase.app

#### 2. About SlugBase

SlugBase is a web-based bookmark management platform that enables users to save, organise, and retrieve bookmarks. The Service includes optional link-forwarding functionality and optional AI-assisted suggestions for slugs, titles, and tags. AI suggestions can be disabled at workspace level or by individual users.

#### 3. Personal Data We Process and Why

**3.1 Account Data**

Data: name or username, email address, hashed password or third-party identity token, preferred language, account creation date.

Purpose: Creating and securing access to your account; sending essential service communications.

Legal basis: Art. 6(1)(b) GDPR — necessary for the performance of a contract.

**3.2 Bookmark and Workspace Data**

Data: URLs, slugs, titles, tags, notes, folder structures, and any other content you save to the Service.

Purpose: Providing the core functionality of the Service.

Legal basis: Art. 6(1)(b) GDPR — necessary for the performance of a contract.

**3.3 AI-Assisted Suggestions**

Data sent to OpenAI: When you request AI-assisted suggestions, we submit the bookmark URL together with page metadata retrieved by our servers from the target page: page title, meta description, and site name. We do not send full page content, your bookmark notes, or your existing tags to OpenAI.

Purpose: Generating AI-assisted slug, title, and tag suggestions when the feature is enabled by you or your workspace administrator.

Legal basis: Art. 6(1)(b) GDPR — performance of a contract (where enabled as part of the subscribed plan); Art. 6(1)(a) GDPR — consent (where opt-in beyond the contracted scope).

Third-party processor: OpenAI, L.L.C. (USA). Data is transferred to the United States on the basis of Standard Contractual Clauses pursuant to Art. 46(2)(c) GDPR. See Section 7 for full details.

Suggestion cache: To avoid redundant calls to OpenAI, we store suggestion results in a server-side cache keyed by workspace, user, canonical URL, and output language. Cached entries contain the canonical URL, output language, and the generated suggestion result (slug, title, and tags). Purpose of the cache: serving repeat requests without contacting OpenAI again. Legal basis for the cache: Art. 6(1)(b) GDPR — necessary for the performance of a contract. Retention: 30 days from creation; entries expire automatically. See Section 5.

Note: AI suggestions can be disabled at workspace level or per user in account settings.

**3.4 Payment Data**

Data: Subscription plan, billing period, payment status. Full payment card data is not processed or stored by the Operator.

Purpose: Processing subscription payments; fulfilling accounting and tax obligations.

Legal basis: Art. 6(1)(b) GDPR — performance of a contract; Art. 6(1)(c) GDPR — compliance with a legal obligation.

Third-party processor: Stripe, Inc. See Section 7.

**3.5 Communication Data**

Data: Email address and message content when you contact us.

Purpose: Responding to support requests and administrative communications.

Legal basis: Art. 6(1)(b) GDPR — performance of a contract; Art. 6(1)(f) GDPR — legitimate interest in providing support.

**3.6 Technical and Log Data**

Data: IP address (anonymised where technically feasible), browser type and version, operating system, referrer URL, request timestamps, HTTP status codes, and error codes.

Purpose: Operating, securing, and improving the Service; diagnosing technical issues.

Legal basis: Art. 6(1)(f) GDPR — legitimate interest in the secure and reliable operation of the Service.

**3.7 Analytics Data (Consent Required)**

Data: Aggregated, anonymised page-view and interaction data. No cross-site tracking, no fingerprinting, and no persistent advertising identifiers are used.

Purpose: Understanding how the Service is used in order to improve it.

Legal basis: Art. 6(1)(a) GDPR — **consent**. Analytics are activated only after you have given explicit consent via the consent banner. See also Section 4 (Cookies).

Tool: Umami Analytics, self-hosted on SlugBase infrastructure (Fly.io, Frankfurt). No data is shared with third parties for analytics purposes.

**3.8 Error Reporting — Server-Side (Always Active When Configured)**

Data: Server-side error stack traces, request path, HTTP status code, and application environment metadata. Email addresses, IP addresses, session tokens, authorization headers, and cookies are actively stripped from all error events before transmission via a `beforeSend` hook in `instrument.ts` and the PII scrubbing layer in `error-reporting-pii.ts`. No personally identifying data is included in server-side error reports.

Purpose: Detecting, diagnosing, and resolving server-side software errors to maintain the security and reliability of the Service.

Legal basis: Art. 6(1)(f) GDPR — **legitimate interests** in operating a secure and stable service. Server-side error capturing is active whenever `SENTRY_DSN` is configured, independent of user consent, because it operates on anonymised infrastructure-level data only.

Third-party processor: Sentry (Functional Software, Inc., USA), hosted in the EU (Germany region). See Section 7.

**3.8a Error Reporting — Client-Side Browser SDK (Consent Required)**

Data: JavaScript error stack traces, browser environment metadata, and the URL at the time of the error. Reports may incidentally include brief fragments of page content visible at the moment the error occurred.

Purpose: Detecting, diagnosing, and resolving client-side software errors.

Legal basis: Art. 6(1)(a) GDPR — **consent**. The browser-side Sentry SDK is loaded only after you have given explicit consent via the consent banner. See also Section 4.3 (Cookies).

**3.9 Bot Protection**

Data: Interaction signals (mouse movement patterns, event timing) used to distinguish human users from automated requests. No persistent personal profile is created.

Purpose: Preventing abuse of authentication endpoints and public-facing forms.

Legal basis: Art. 6(1)(f) GDPR — legitimate interest in the security and integrity of the Service.

Tool: Cloudflare Turnstile. See Section 7.

**3.10 Identity Provider Data (Where Configured)**

Data: Where you choose to sign in via a third-party identity provider (e.g. Google, GitHub), we receive the user ID, email address, and display name provided by that provider.

Purpose: Authenticating your account without requiring a separate password.

Legal basis: Art. 6(1)(b) GDPR — performance of a contract; Art. 6(1)(a) GDPR — consent as expressed through your choice to use the identity provider.

**3.11 Audit Log**

Data: For each significant action within a workspace, we record the actor's user ID (and, when displayed in the audit log interface, the actor's email address resolved from the account record), the workspace ID, the action type, the affected entity type, the entity ID (where applicable), a timestamp, and optional supplementary metadata as a JSON object. Events are recorded for all workspaces regardless of plan; access to view the audit log is restricted to workspace administrators on workspaces with the Team plan entitlement (or on self-hosted instances where the feature is enabled by default).

Purpose: Providing workspace administrators with a read-only, paginated record of significant actions within the workspace (e.g. member changes, team operations, and bookmark creations, updates, and deletions) in accordance with the audit log feature of the Service.

Legal basis: Art. 6(1)(b) GDPR — necessary for the performance of a contract (provision of the Team plan audit log feature to entitled workspace administrators).

Scope: Event recording occurs for all plans; viewing the audit log requires the Team plan entitlement on the hosted service and workspace administrator privileges. On self-hosted installations, the audit log is available to workspace administrators without plan restriction.

Note: Audit log data is retained for the duration of the account plus 30 days after account deletion (see Section 5). A dedicated automated purge job for audit events is not yet implemented; events are removed when associated workspace and account data is deleted.

**3.12 Multi-Factor Authentication (MFA / TOTP)**

Data: MFA enrolment state (e.g. not enrolled, enrolment pending, or enrolled) and, where MFA is enabled or enrolment is in progress, an encrypted TOTP shared secret stored in the account record. The TOTP secret is never stored or transmitted in plain text after enrolment is confirmed. During the one-time enrolment step, the secret is disclosed to you only (e.g. via QR code or text display) so you can configure your authenticator application.

Purpose: Securing account access via two-factor authentication.

Legal basis: Art. 6(1)(b) GDPR — necessary for the performance of a contract; Art. 6(1)(f) GDPR — legitimate interest in the security of your account.

Note: MFA enrolment state and the encrypted TOTP secret are deleted when you disable MFA or when your account is deleted (see Section 5).

**3.13 Workspace Invitation Emails**

Data: Email address of the invitee (third-party data — the invitee may not yet have a SlugBase account). The invitation email may also include the inviting member's display name, the workspace name, and the assigned role.

Purpose: Sending workspace invitations on behalf of the workspace member who initiated the invitation (typically the workspace owner or an administrator).

Legal basis: Art. 6(1)(b) GDPR — necessary for the performance of a contract (provision of team workspace functionality to the inviting member); Art. 6(1)(f) GDPR — legitimate interest in enabling workspace administrators to invite collaborators.

Third-party processor: Postmark (ActiveCampaign, LLC). See Section 7.

Note: Invitation records (including the invitee email address and a hashed invitation token) are retained for up to 7 days from creation. They are deleted when the invitation is declined, revoked, or expires. Upon acceptance, the invitee's email address becomes account data (see Section 3.1). See also Section 5.

#### 4. Cookies and Local Storage

**4.1 Strictly Necessary Cookies**

The following cookies are technically necessary for the Service to operate. They are set without consent pursuant to § 165(3) Telekommunikationsgesetz 2021 (TKG 2021).

| Cookie / Token | Type | Purpose | Duration |
|---|---|---|---|
| `slb_session` | HTTP cookie — httpOnly, Secure, SameSite=Lax | Maintains your authenticated session so you remain logged in across page loads | Duration of session; expires on logout or after configured idle timeout |
| CSRF token | HTTP cookie or request header | Prevents cross-site request forgery attacks on state-changing operations | Session; regenerated on each authenticated session |

These cookies cannot be disabled without breaking core functionality. They do not contain any information that uniquely identifies you beyond your session and are never used for advertising or tracking purposes.

**4.2 Analytics Cookies and Scripts (Consent Required)**

| Technology | Type | Purpose | Duration |
|---|---|---|---|
| Umami Analytics tracking script | First-party JavaScript (self-hosted) | Counts page views and user interactions in aggregate; no cross-site tracking; no fingerprinting | Session-based only. Umami does not set a persistent tracking cookie by default; data is collected in-session and aggregated server-side |

Umami Analytics is hosted entirely on SlugBase infrastructure (Fly.io, Frankfurt, Germany) and does not transmit any data to third parties. Aggregate statistics are retained for internal use only.

This script is only loaded after you have given explicit consent via the consent banner. You may withdraw consent at any time via the consent settings accessible in the footer of the Service. Withdrawal of consent takes effect immediately; no further data is collected from that point forward.

**4.3 Error Reporting (Consent Required)**

| Technology | Type | Purpose | Duration |
|---|---|---|---|
| Sentry browser SDK | Third-party JavaScript (loaded conditionally) | Captures JavaScript error stack traces, browser environment metadata, and the URL at time of error to assist with debugging | In-memory only during the session; no persistent cookie is set by Sentry. Reports are transmitted to Sentry's EU servers and retained for 90 days |

The Sentry SDK is only loaded after you have given explicit consent via the consent banner. You may withdraw consent at any time via the consent settings in the footer.

**4.4 Infrastructure Cookies (Cloudflare)**

Cloudflare, which powers the CDN and DDoS protection layer of the Service, may set cookies for performance and security purposes (e.g. `__cf_bm` for bot management). These are strictly necessary for the safe delivery of the Service and are set by Cloudflare's infrastructure independently of our application code. They do not identify you personally and do not serve advertising purposes. For details, refer to Cloudflare's Privacy Policy at https://www.cloudflare.com/privacypolicy/.

**4.5 No Advertising Cookies**

We do not use advertising cookies, tracking pixels, or any technology designed to build behavioural profiles for advertising purposes.

**4.6 Managing Your Cookie Preferences**

You can review and change your consent choices at any time via the consent settings in the footer of the Service. In addition, most browsers allow you to block or delete cookies through their settings. Note that disabling strictly necessary cookies (Section 4.1) will prevent the Service from functioning correctly.

#### 5. Data Retention

| Data Category | Retention Period |
|---|---|
| Account data | Duration of the account plus 30 days after account deletion |
| Bookmark and workspace data | Duration of the account plus 30 days after account deletion |
| Payment records | 7 years (§ 132 Bundesabgabenordnung (BAO) / § 212 Unternehmensgesetzbuch (UGB)) |
| Technical log data | Rolling 30 days |
| Analytics data (Umami) | Aggregated; no personal data retained beyond the session |
| Error reports (Sentry) | 90 days from creation |
| Support and communication records | 3 years from the date of last contact |
| Audit log data | Duration of the account plus 30 days after account deletion |
| MFA data (enrolment state and encrypted TOTP secret) | Deleted upon MFA unenrolment or account deletion |
| Workspace invitation data | Up to 7 days from creation; deleted on decline, revocation, or expiry; becomes account data on acceptance |
| AI suggestion cache | 30 days from creation (automatic expiry) |

After the applicable retention period, data is deleted or irreversibly anonymised.

#### 6. Data Location

The Service is operated predominantly within the **European Economic Area (EEA)**:

| Component | Location |
|---|---|
| Application servers | Fly.io — Frankfurt, Germany (eu-central) |
| Database | Neon Postgres — aws-eu-central-1, Frankfurt, Germany |
| CDN and edge network | Cloudflare — EU edge nodes (contractual EU data processing agreement in place) |
| Analytics | Umami Analytics — self-hosted on Fly.io, Frankfurt, Germany |
| Error reporting | Sentry — EU region (Germany) |

Transfers outside the EEA occur only to the extent described in Section 7 (Subprocessors) and are safeguarded by Standard Contractual Clauses (SCCs) pursuant to Art. 46(2)(c) GDPR.

#### 7. Subprocessors

We engage the following processors to deliver the Service. Each processor is bound by a data processing agreement (DPA) meeting the requirements of Art. 28 GDPR.

| Processor | Country | Role | Data Location | Transfer Basis |
|---|---|---|---|---|
| Fly.io, Inc. | USA | Application hosting (API, background workers) | Frankfurt, Germany | SCCs (Art. 46(2)(c) GDPR) |
| Neon, Inc. | USA | PostgreSQL database | aws-eu-central-1, Frankfurt, Germany | SCCs (Art. 46(2)(c) GDPR) |
| Cloudflare, Inc. | USA | CDN, DDoS protection, edge workers, marketing site delivery | EU edge nodes (global network) | SCCs + EU DPA |
| Stripe, Inc. | USA | Subscription payment processing | EU (Stripe Payments Europe Ltd., Ireland) | SCCs + EU DPA |
| Cloudflare, Inc. (Turnstile) | USA | Bot protection on authentication forms | EU edge nodes | SCCs + EU DPA |
| OpenAI, L.L.C. | USA | AI-assisted suggestions (when enabled) | USA | SCCs (Art. 46(2)(c) GDPR) |
| Functional Software, Inc. dba Sentry | USA | Server-side error reporting (always active, PII scrubbed); client-side browser SDK (consent-gated) | Germany (EU region) | SCCs + EU DPA |
| Postmark (ActiveCampaign, LLC) | USA | Transactional email delivery (hosted version) | USA / EU | SCCs (Art. 46(2)(c) GDPR) |
| Identity providers (e.g. Google, GitHub) | Varies | Third-party authentication (where configured by user) | Per provider | Per provider's applicable transfer mechanism |

Self-hosted installations do not use Fly.io, Neon, Postmark, or Sentry unless separately configured by the operator of that instance.

We will notify you of any material changes to the subprocessor list via the Privacy Policy update mechanism described in Section 10.

#### 8. Your Rights Under the GDPR

As a data subject under the GDPR and the Austrian Datenschutzgesetz (DSG), you have the following rights:

**Right of access (Art. 15 GDPR):** You may request confirmation of whether we process personal data about you and, if so, obtain a copy of that data together with supplementary information.

**Right to rectification (Art. 16 GDPR):** You may request correction of inaccurate personal data we hold about you.

**Right to erasure (Art. 17 GDPR):** You may request deletion of your personal data where it is no longer necessary for the purposes for which it was collected, where you withdraw consent (and no other legal basis applies), or where processing is unlawful.

**Right to restriction of processing (Art. 18 GDPR):** You may request that we restrict the processing of your data in certain circumstances, for example while the accuracy of the data is contested.

**Right to data portability (Art. 20 GDPR):** You may request that we provide your personal data in a structured, commonly used, machine-readable format and, where technically feasible, transmit it directly to another controller.

**Right to object (Art. 21 GDPR):** You may object at any time to processing based on legitimate interests (Art. 6(1)(f) GDPR). We will then cease processing unless we can demonstrate compelling legitimate grounds that override your interests, rights, and freedoms.

**Right to withdraw consent (Art. 7(3) GDPR):** Where processing is based on your consent, you may withdraw that consent at any time. Withdrawal does not affect the lawfulness of processing carried out prior to withdrawal.

**How to exercise your rights:** Send a written request to hello@slugbase.app. We will respond within 30 days; in complex cases this period may be extended by a further two months, in which case we will notify you within the initial 30 days.

#### 9. Right to Lodge a Complaint

You have the right to lodge a complaint with the competent data protection supervisory authority. The authority responsible for the Operator is:

**Österreichische Datenschutzbehörde (DSB)**
Barichgasse 40–42
1030 Vienna, Austria
https://www.dsb.gv.at

You may also lodge a complaint with the supervisory authority of your country of habitual residence within the EEA.

#### 10. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. We will notify you of material changes by email and/or by a prominent notice within the Service. The date at the top of this document reflects the most recent revision. We recommend reviewing this Policy periodically.

#### 11. Contact

For all data protection enquiries: hello@slugbase.app

---

## Deutsch

### Datenschutzerklärung

_Stand: [DATUM]_

#### 1. Verantwortlicher

Verantwortlicher im Sinne von Art. 4 Nr. 7 DSGVO ist:

Michael David Guggenbichler (Einzelunternehmer)
Linzer Straße 17
4100 Ottensheim
Österreich
UID-Nummer: ATU82945789
hello@slugbase.app

#### 2. Über SlugBase

SlugBase ist eine webbasierte Plattform für Lesezeichen-Verwaltung, mit der Nutzer:innen Lesezeichen speichern, organisieren und abrufen können. Der Dienst umfasst optionales Link-Forwarding sowie optional KI-gestützte Vorschläge für Slugs, Titel und Tags. KI-Vorschläge können auf Arbeitsbereichsebene oder durch einzelne Nutzer:innen deaktiviert werden.

#### 3. Welche personenbezogenen Daten wir verarbeiten und warum

**3.1 Kontodaten**

Daten: Name oder Benutzername, E-Mail-Adresse, gehashtes Passwort oder Drittanbieter-Identity-Token, bevorzugte Sprache, Erstellungsdatum des Kontos.

Zweck: Einrichtung und Sicherung des Kontozugangs; Versand wesentlicher Dienstkommunikationen.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung.

**3.2 Lesezeichen- und Arbeitsbereichsdaten**

Daten: URLs, Slugs, Titel, Tags, Notizen, Ordnerstrukturen und sonstige von Ihnen gespeicherte Inhalte.

Zweck: Bereitstellung der Kernfunktionalität des Dienstes.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung.

**3.3 KI-gestützte Vorschläge**

An OpenAI übermittelte Daten: Wenn Sie KI-gestützte Vorschläge anfordern, übermitteln wir die Lesezeichen-URL zusammen mit von unseren Servern von der Zielseite abgerufenen Seitenmetadaten: Seitentitel, Meta-Beschreibung und Seitenname. Vollständige Seiteninhalte, Ihre Lesezeichen-Notizen oder vorhandene Tags werden nicht an OpenAI übermittelt.

Zweck: Generierung von KI-gestützten Vorschlägen für Slug, Titel und Tags, wenn die Funktion von Ihnen oder Ihrer Arbeitsbereichsadministration aktiviert wurde.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung (soweit als Bestandteil des gebuchten Plans aktiviert); Art. 6 Abs. 1 lit. a DSGVO — Einwilligung (soweit opt-in über den Vertragsumfang hinaus).

Drittanbieter: OpenAI, L.L.C. (USA). Daten werden auf Grundlage von Standardvertragsklauseln gemäß Art. 46 Abs. 2 lit. c DSGVO in die USA übermittelt. Details siehe Abschnitt 7.

Vorschlags-Cache: Um redundante Anfragen an OpenAI zu vermeiden, speichern wir Vorschlagsergebnisse in einem serverseitigen Cache, der nach Arbeitsbereich, Nutzer:in, kanonischer URL und Ausgabesprache verknüpft ist. Cache-Einträge enthalten die kanonische URL, die Ausgabesprache und das generierte Vorschlagsergebnis (Slug, Titel und Tags). Zweck des Caches: wiederholte Anfragen ohne erneute Kontaktaufnahme mit OpenAI zu bedienen. Rechtsgrundlage für den Cache: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung. Aufbewahrung: 30 Tage ab Erstellung; Einträge verfallen automatisch. Siehe Abschnitt 5.

Hinweis: KI-Vorschläge können in den Kontoeinstellungen auf Arbeitsbereichsebene oder je Nutzer:in deaktiviert werden.

**3.4 Zahlungsdaten**

Daten: Abonnementplan, Abrechnungszeitraum, Zahlungsstatus. Vollständige Zahlungskarteninformationen werden vom Betreiber nicht verarbeitet oder gespeichert.

Zweck: Abwicklung von Abonnementzahlungen; Erfüllung buchhalterischer und steuerrechtlicher Pflichten.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung; Art. 6 Abs. 1 lit. c DSGVO — Erfüllung rechtlicher Verpflichtungen.

Drittanbieter: Stripe, Inc. Siehe Abschnitt 7.

**3.5 Kommunikationsdaten**

Daten: E-Mail-Adresse und Nachrichteninhalt bei Kontaktaufnahme.

Zweck: Bearbeitung von Support-Anfragen und administrativen Mitteilungen.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung; Art. 6 Abs. 1 lit. f DSGVO — berechtigte Interessen an der Support-Bereitstellung.

**3.6 Technische Daten und Protokolldaten**

Daten: IP-Adresse (soweit technisch möglich anonymisiert), Browsertyp und -version, Betriebssystem, Referrer-URL, Zeitstempel von Anfragen, HTTP-Statuscodes und Fehlercodes.

Zweck: Betrieb, Sicherung und Verbesserung des Dienstes; Diagnose technischer Probleme.

Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO — berechtigte Interessen am sicheren und zuverlässigen Betrieb des Dienstes.

**3.7 Analysedaten (Einwilligung erforderlich)**

Daten: Aggregierte, anonymisierte Seitenaufruf- und Interaktionsdaten. Es findet kein Cross-Site-Tracking, kein Fingerprinting und keine Nutzung persistenter Werbe-IDs statt.

Zweck: Verständnis der Dienstnutzung zur kontinuierlichen Verbesserung.

Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO — **Einwilligung**. Analysefunktionen werden ausschließlich nach ausdrücklicher Einwilligung über das Consent-Banner aktiviert. Siehe auch Abschnitt 4 (Cookies).

Tool: Umami Analytics, selbst gehostet auf der SlugBase-Infrastruktur (Fly.io, Frankfurt). Es werden keine Daten zu Analysezwecken an Dritte übermittelt.

**3.8 Fehlerprotokollierung — Server-seitig (aktiv wenn konfiguriert)**

Daten: Serverseitige Fehler-Stacktraces, Anfragepfad, HTTP-Statuscode und Anwendungsumgebungsmetadaten. E-Mail-Adressen, IP-Adressen, Session-Tokens, Autorisierungs-Header und Cookies werden über einen `beforeSend`-Hook (`instrument.ts`) und die PII-Scrubbing-Schicht (`error-reporting-pii.ts`) aktiv aus allen Fehlerereignissen entfernt, bevor diese übermittelt werden. Serverseitige Fehlerberichte enthalten keine personenidentifizierenden Daten.

Zweck: Erkennung, Diagnose und Behebung serverseitiger Softwarefehler zur Aufrechterhaltung der Sicherheit und Stabilität des Dienstes.

Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO — **berechtigte Interessen** am Betrieb eines sicheren und stabilen Dienstes. Die serverseitige Fehlererfassung ist aktiv, wenn `SENTRY_DSN` konfiguriert ist — unabhängig von der Nutzereinwilligung, da ausschließlich anonymisierte infrastrukturelle Daten verarbeitet werden.

Drittanbieter: Sentry (Functional Software, Inc., USA), gehostet in der EU (Deutschland). Siehe Abschnitt 7.

**3.8a Fehlerprotokollierung — Client-seitiges Browser-SDK (Einwilligung erforderlich)**

Daten: JavaScript-Fehler-Stacktraces, Browser-Umgebungsmetadaten und die URL zum Fehlerzeitpunkt. Fehlerberichte können vereinzelt kurze Fragmente des zum Fehlerzeitpunkt sichtbaren Seiteninhalts enthalten.

Zweck: Erkennung, Diagnose und Behebung clientseitiger Softwarefehler.

Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO — **Einwilligung**. Das browser-seitige Sentry-SDK wird ausschließlich nach ausdrücklicher Einwilligung über das Consent-Banner geladen. Siehe auch Abschnitt 4.3 (Cookies).

**3.9 Bot-Schutz**

Daten: Interaktionssignale (Mausbewegungsmuster, Event-Timing) zur Unterscheidung menschlicher Nutzer:innen von automatisierten Anfragen. Es wird kein persistentes persönliches Profil erstellt.

Zweck: Verhinderung des Missbrauchs von Authentifizierungs-Endpunkten und öffentlichen Formularen.

Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO — berechtigte Interessen an der Sicherheit und Integrität des Dienstes.

Tool: Cloudflare Turnstile. Siehe Abschnitt 7.

**3.10 Identity-Provider-Daten (soweit konfiguriert)**

Daten: Sofern Sie sich über einen Drittanbieter-Identity-Provider (z. B. Google, GitHub) anmelden, erhalten wir die von diesem Anbieter übermittelten Informationen: Benutzer-ID, E-Mail-Adresse und Anzeigename.

Zweck: Kontenauthentifizierung ohne separates Passwort.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung; Art. 6 Abs. 1 lit. a DSGVO — Einwilligung, die durch die Wahl des Identity Providers zum Ausdruck gebracht wird.

**3.11 Audit Log**

Daten: Für jede wesentliche Aktion innerhalb eines Arbeitsbereichs speichern wir die Benutzer-ID der handelnden Person (sowie, wenn in der Audit-Log-Oberfläche angezeigt, die aus dem Konto aufgelöste E-Mail-Adresse), die Arbeitsbereichs-ID, den Aktionstyp, den betroffenen Entitätstyp, die Entitäts-ID (sofern zutreffend), einen Zeitstempel sowie optionale ergänzende Metadaten als JSON-Objekt. Ereignisse werden für alle Arbeitsbereiche unabhängig vom Plan erfasst; der Zugriff auf die Anzeige des Audit Logs ist auf Arbeitsbereichsadministrator:innen bei Arbeitsbereichen mit Team-Plan-Berechtigung beschränkt (bzw. bei selbst gehosteten Installationen, wo die Funktion standardmäßig verfügbar ist).

Zweck: Bereitstellung eines schreibgeschützten, paginierten Protokolls wesentlicher Aktionen innerhalb des Arbeitsbereichs (z. B. Mitgliederverwaltung, Team-Operationen sowie Erstellung, Aktualisierung und Löschung von Lesezeichen) für Arbeitsbereichsadministrator:innen gemäß der Audit-Log-Funktion des Dienstes.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung (Bereitstellung der Audit-Log-Funktion im Rahmen des Team-Plans für berechtigte Arbeitsbereichsadministrator:innen).

Umfang: Die Erfassung von Ereignissen erfolgt für alle Pläne; die Einsicht in das Audit Log erfordert die Team-Plan-Berechtigung im gehosteten Dienst sowie Arbeitsbereichsadministrator-Rechte. Bei selbst gehosteten Installationen steht das Audit Log Arbeitsbereichsadministrator:innen ohne Planbeschränkung zur Verfügung.

Hinweis: Audit-Log-Daten werden für die Dauer des Kontos zzgl. 30 Tage nach Kontolöschung aufbewahrt (siehe Abschnitt 5). Ein dedizierter automatisierter Löschvorgang für Audit-Ereignisse ist derzeit nicht implementiert; Ereignisse werden entfernt, wenn die zugehörigen Arbeitsbereichs- und Kontodaten gelöscht werden.

**3.12 Zwei-Faktor-Authentifizierung (MFA / TOTP)**

Daten: MFA-Registrierungsstatus (z. B. nicht registriert, Registrierung ausstehend oder registriert) und, sofern MFA aktiviert ist oder die Registrierung läuft, ein verschlüsseltes TOTP-Shared-Secret im Kontodatensatz. Das TOTP-Secret wird nach abgeschlossener Registrierung nie im Klartext gespeichert oder übertragen. Im einmaligen Registrierungsschritt wird das Secret ausschließlich Ihnen mitgeteilt (z. B. per QR-Code oder Klartextanzeige), damit Sie Ihre Authenticator-App einrichten können.

Zweck: Absicherung des Kontozugangs durch Zwei-Faktor-Authentifizierung.

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung; Art. 6 Abs. 1 lit. f DSGVO — berechtigte Interessen an der Sicherheit Ihres Kontos.

Hinweis: MFA-Registrierungsstatus und das verschlüsselte TOTP-Secret werden gelöscht, wenn Sie MFA deaktivieren oder Ihr Konto gelöscht wird (siehe Abschnitt 5).

**3.13 Arbeitsbereichs-Einladungs-E-Mails**

Daten: E-Mail-Adresse der eingeladenen Person (Drittparteiendaten — die eingeladene Person verfügt ggf. noch über kein SlugBase-Konto). Die Einladungs-E-Mail kann außerdem den Anzeigenamen der einladenden Person, den Arbeitsbereichsnamen und die zugewiesene Rolle enthalten.

Zweck: Versand von Arbeitsbereichs-Einladungen im Auftrag der einladenden Person (in der Regel Arbeitsbereichsinhaber:in oder Administrator:in).

Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO — Vertragserfüllung (Bereitstellung der Team-Arbeitsbereichsfunktionalität für die einladende Person); Art. 6 Abs. 1 lit. f DSGVO — berechtigte Interessen an der Einladung von Mitarbeitenden durch Arbeitsbereichsadministrator:innen.

Auftragsverarbeiter: Postmark (ActiveCampaign, LLC). Siehe Abschnitt 7.

Hinweis: Einladungsdatensätze (einschließlich der E-Mail-Adresse der eingeladenen Person und eines gehashten Einladungstokens) werden höchstens 7 Tage ab Erstellung aufbewahrt. Sie werden gelöscht, wenn die Einladung abgelehnt, widerrufen oder abgelaufen ist. Mit Annahme werden die E-Mail-Daten der eingeladenen Person zu Kontodaten (siehe Abschnitt 3.1). Siehe auch Abschnitt 5.

#### 4. Cookies und lokaler Speicher

**4.1 Technisch notwendige Cookies**

Die folgenden Cookies sind für den Betrieb des Dienstes technisch erforderlich. Sie werden ohne Einwilligung gesetzt, da sie unter die Ausnahme des § 165 Abs. 3 Telekommunikationsgesetz 2021 (TKG 2021) fallen.

| Cookie / Token | Typ | Zweck | Dauer |
|---|---|---|---|
| `slb_session` | HTTP-Cookie — httpOnly, Secure, SameSite=Lax | Aufrechterhaltung der authentifizierten Sitzung, damit Sie über Seitenwechsel hinweg eingeloggt bleiben | Dauer der Sitzung; erlischt bei Abmeldung oder nach konfiguriertem Inaktivitäts-Timeout |
| CSRF-Token | HTTP-Cookie oder Request-Header | Schutz vor Cross-Site-Request-Forgery-Angriffen bei zustandsverändernden Operationen | Sitzung; wird bei jeder authentifizierten Sitzung neu generiert |

Diese Cookies können nicht deaktiviert werden, ohne die Kernfunktionalität des Dienstes zu beeinträchtigen. Sie enthalten keine Informationen, die Sie über Ihre Sitzung hinaus identifizieren, und werden nie zu Werbe- oder Tracking-Zwecken eingesetzt.

**4.2 Analyse-Cookies und -Scripts (Einwilligung erforderlich)**

| Technologie | Typ | Zweck | Dauer |
|---|---|---|---|
| Umami Analytics Tracking-Script | First-Party-JavaScript (selbst gehostet) | Aggregierte Zählung von Seitenaufrufen und Nutzerinteraktionen; kein Cross-Site-Tracking; kein Fingerprinting | Ausschließlich sitzungsbasiert. Umami setzt standardmäßig kein persistentes Tracking-Cookie; Daten werden in der Sitzung erfasst und serverseitig aggregiert |

Umami Analytics wird vollständig auf der SlugBase-Infrastruktur (Fly.io, Frankfurt, Deutschland) betrieben und übermittelt keine Daten an Dritte. Aggregierte Statistiken werden ausschließlich intern genutzt.

Dieses Script wird ausschließlich nach ausdrücklicher Einwilligung über das Consent-Banner geladen. Die Einwilligung kann jederzeit über die Consent-Einstellungen im Footer des Dienstes widerrufen werden. Der Widerruf wirkt sofort; ab diesem Zeitpunkt werden keine weiteren Daten erfasst.

**4.3 Fehlerprotokollierung (Einwilligung erforderlich)**

| Technologie | Typ | Zweck | Dauer |
|---|---|---|---|
| Sentry Browser SDK | Drittanbieter-JavaScript (bedingt geladen) | Erfassung von JavaScript-Fehler-Stacktraces, Browser-Umgebungsmetadaten und der URL zum Fehlerzeitpunkt zur Unterstützung der Fehlerdiagnose | Ausschließlich In-Memory während der Sitzung; Sentry setzt kein persistentes Cookie. Fehlerberichte werden an die EU-Server von Sentry übermittelt und dort 90 Tage aufbewahrt |

Das Sentry-SDK wird ausschließlich nach ausdrücklicher Einwilligung über das Consent-Banner geladen. Die Einwilligung kann jederzeit über die Consent-Einstellungen im Footer widerrufen werden.

**4.4 Infrastruktur-Cookies (Cloudflare)**

Cloudflare, das die CDN- und DDoS-Schutzschicht des Dienstes betreibt, kann Cookies für Performance- und Sicherheitszwecke setzen (z. B. `__cf_bm` für Bot-Management). Diese sind für die sichere Auslieferung des Dienstes technisch notwendig und werden von der Cloudflare-Infrastruktur unabhängig von unserem Anwendungscode gesetzt. Sie identifizieren Sie nicht persönlich und dienen keinen Werbezwecken. Einzelheiten entnehmen Sie der Datenschutzerklärung von Cloudflare: https://www.cloudflare.com/privacypolicy/

**4.5 Keine Werbe-Cookies**

Wir verwenden keine Werbe-Cookies, Tracking-Pixel oder sonstige Technologien, die zur Erstellung von Verhaltensprofilen für Werbezwecke dienen.

**4.6 Verwaltung Ihrer Cookie-Einstellungen**

Ihre Einwilligungsoptionen können Sie jederzeit über die Consent-Einstellungen im Footer des Dienstes einsehen und ändern. Darüber hinaus können Sie Cookies über die Einstellungen Ihres Browsers blockieren oder löschen. Bitte beachten Sie, dass die Deaktivierung technisch notwendiger Cookies (Abschnitt 4.1) den Betrieb des Dienstes beeinträchtigt.

#### 5. Speicherdauer

| Datenkategorie | Aufbewahrungsdauer |
|---|---|
| Kontodaten | Für die Dauer des Kontos zzgl. 30 Tage nach Kontolöschung |
| Lesezeichen- und Arbeitsbereichsdaten | Für die Dauer des Kontos zzgl. 30 Tage nach Kontolöschung |
| Zahlungsbelege | 7 Jahre (§ 132 Bundesabgabenordnung (BAO) / § 212 Unternehmensgesetzbuch (UGB)) |
| Technische Protokolldaten | Rollierende 30 Tage |
| Analysedaten (Umami) | Aggregiert; keine personenbezogenen Daten über die Sitzung hinaus |
| Fehlerberichte (Sentry) | 90 Tage ab Erstellung |
| Support- und Kommunikationsaufzeichnungen | 3 Jahre ab letztem Kontakt |
| Audit-Log-Daten | Für die Dauer des Kontos zzgl. 30 Tage nach Kontolöschung |
| MFA-Daten (Registrierungsstatus und verschlüsseltes TOTP-Secret) | Löschung bei MFA-Abmeldung oder Kontolöschung |
| Arbeitsbereichs-Einladungsdaten | Höchstens 7 Tage ab Erstellung; Löschung bei Ablehnung, Widerruf oder Ablauf; wird bei Annahme zu Kontodaten |
| KI-Vorschlags-Cache | 30 Tage ab Erstellung (automatischer Verfall) |

Nach Ablauf der jeweiligen Aufbewahrungsfrist werden Daten gelöscht oder unwiderruflich anonymisiert.

#### 6. Datenspeicherort

Der Dienst wird überwiegend innerhalb des **Europäischen Wirtschaftsraums (EWR)** betrieben:

| Komponente | Standort |
|---|---|
| Anwendungsserver | Fly.io — Frankfurt, Deutschland (eu-central) |
| Datenbank | Neon Postgres — aws-eu-central-1, Frankfurt, Deutschland |
| CDN und Edge-Netzwerk | Cloudflare — EU-Edge-Knoten (vertraglicher EU-Datenverarbeitungsvertrag) |
| Analytics | Umami Analytics — selbst gehostet auf Fly.io, Frankfurt, Deutschland |
| Fehlerprotokollierung | Sentry — EU-Region (Deutschland) |

Übermittlungen außerhalb des EWR erfolgen ausschließlich in dem in Abschnitt 7 (Auftragsverarbeiter) beschriebenen Umfang und sind durch Standardvertragsklauseln (SKV) gemäß Art. 46 Abs. 2 lit. c DSGVO abgesichert.

#### 7. Auftragsverarbeiter

Wir setzen folgende Drittanbieter als Auftragsverarbeiter ein. Alle Auftragsverarbeiter sind durch Auftragsverarbeitungsverträge (AVV) gebunden, die den Anforderungen des Art. 28 DSGVO entsprechen.

| Auftragsverarbeiter | Land | Funktion | Datenspeicherort | Übermittlungsgrundlage |
|---|---|---|---|---|
| Fly.io, Inc. | USA | Anwendungs-Hosting (API, Worker) | Frankfurt, Deutschland | SKV (Art. 46 Abs. 2 lit. c DSGVO) |
| Neon, Inc. | USA | PostgreSQL-Datenbank | aws-eu-central-1, Frankfurt, Deutschland | SKV (Art. 46 Abs. 2 lit. c DSGVO) |
| Cloudflare, Inc. | USA | CDN, DDoS-Schutz, Edge-Worker, Marketing-Site | EU-Edge-Knoten (globales Netzwerk) | SKV + EU-DPA |
| Stripe, Inc. | USA | Zahlungsabwicklung | EU (Stripe Payments Europe Ltd., Irland) | SKV + EU-DPA |
| Cloudflare, Inc. (Turnstile) | USA | Bot-Schutz bei Authentifizierungsformularen | EU-Edge-Knoten | SKV + EU-DPA |
| OpenAI, L.L.C. | USA | KI-gestützte Vorschläge (wenn aktiviert) | USA | SKV (Art. 46 Abs. 2 lit. c DSGVO) |
| Functional Software, Inc. dba Sentry | USA | Serverseitige Fehlerprotokollierung (immer aktiv, PII bereinigt); clientseitiges Browser-SDK (einwilligungspflichtig) | Deutschland (EU-Region) | SKV + EU-DPA |
| Postmark (ActiveCampaign, LLC) | USA | Versand von Transaktions-E-Mails (gehostete Version) | USA / EU | SKV (Art. 46 Abs. 2 lit. c DSGVO) |
| Identity Provider (z. B. Google, GitHub) | Variiert | Drittanbieter-Authentifizierung (wenn vom Nutzer konfiguriert) | Gemäß Datenschutzerklärung des Anbieters | Gemäß anwendbarem Übermittlungsmechanismus des Anbieters |

Selbst gehostete Installationen verwenden Fly.io, Neon, Postmark und Sentry nicht, sofern diese nicht gesondert vom Betreiber der jeweiligen Instanz konfiguriert wurden.

Über wesentliche Änderungen an der Auftragsverarbeiterliste werden wir Sie über den in Abschnitt 10 beschriebenen Mechanismus zur Aktualisierung der Datenschutzerklärung informieren.

#### 8. Ihre Rechte nach der DSGVO

Als betroffene Person nach DSGVO und Datenschutzgesetz (DSG) stehen Ihnen folgende Rechte zu:

**Auskunftsrecht (Art. 15 DSGVO):** Sie können Auskunft darüber verlangen, ob wir personenbezogene Daten über Sie verarbeiten, und — sofern dies der Fall ist — eine Kopie dieser Daten sowie ergänzende Informationen erhalten.

**Recht auf Berichtigung (Art. 16 DSGVO):** Sie können die Berichtigung unrichtiger personenbezogener Daten verlangen.

**Recht auf Löschung (Art. 17 DSGVO):** Sie können die Löschung Ihrer personenbezogenen Daten verlangen, soweit diese für die Zwecke, für die sie erhoben wurden, nicht mehr erforderlich sind, eine Einwilligung widerrufen wurde und keine andere Rechtsgrundlage besteht oder die Verarbeitung rechtswidrig ist.

**Recht auf Einschränkung der Verarbeitung (Art. 18 DSGVO):** Sie können in bestimmten Fällen — etwa wenn die Richtigkeit der Daten bestritten wird — die Einschränkung der Verarbeitung verlangen.

**Recht auf Datenübertragbarkeit (Art. 20 DSGVO):** Sie können verlangen, dass wir Ihre personenbezogenen Daten in einem strukturierten, gängigen, maschinenlesbaren Format bereitstellen und — soweit technisch machbar — direkt an einen anderen Verantwortlichen übermitteln.

**Widerspruchsrecht (Art. 21 DSGVO):** Sie können jederzeit der Verarbeitung auf Grundlage berechtigter Interessen (Art. 6 Abs. 1 lit. f DSGVO) widersprechen. Wir stellen die Verarbeitung dann ein, sofern wir keine zwingenden schutzwürdigen Gründe nachweisen können, die Ihre Interessen, Rechte und Freiheiten überwiegen.

**Recht auf Widerruf der Einwilligung (Art. 7 Abs. 3 DSGVO):** Soweit die Verarbeitung auf einer Einwilligung beruht, können Sie diese jederzeit mit Wirkung für die Zukunft widerrufen. Der Widerruf berührt nicht die Rechtmäßigkeit der bis dahin erfolgten Verarbeitung.

**Geltendmachung Ihrer Rechte:** Senden Sie eine schriftliche Anfrage an hello@slugbase.app. Wir antworten innerhalb von 30 Tagen; in komplexen Fällen kann diese Frist um weitere zwei Monate verlängert werden, worüber wir Sie innerhalb der ersten 30 Tage informieren.

#### 9. Beschwerderecht

Sie haben das Recht, eine Beschwerde bei der zuständigen Datenschutzbehörde einzureichen. Für den Betreiber zuständige Behörde ist:

**Österreichische Datenschutzbehörde (DSB)**
Barichgasse 40–42
1030 Wien
https://www.dsb.gv.at

Sie können auch bei der Datenschutzbehörde Ihres gewöhnlichen Aufenthaltsortes innerhalb des EWR Beschwerde einlegen.

#### 10. Änderungen dieser Datenschutzerklärung

Wir können diese Datenschutzerklärung von Zeit zu Zeit aktualisieren. Über wesentliche Änderungen informieren wir Sie per E-Mail und/oder durch einen deutlichen Hinweis im Dienst. Das Datum am Anfang dieses Dokuments gibt den Stand der letzten Aktualisierung an. Wir empfehlen, diese Erklärung regelmäßig zu überprüfen.

#### 11. Kontakt

Für alle datenschutzrechtlichen Anfragen: hello@slugbase.app
