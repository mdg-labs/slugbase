# SlugBase — Threat Model

This is the written reference every security judgement in the project is made against: `/security-audit`, the task verifier's risk review, CodeRabbit triage and a human reading a report. A finding is measured against the assets (§1), the attackers (§2), the entry points (§3), the invariants (§4), the accepted residuals (§5) and the severity rubric (§6) below, and nothing else. The controls themselves are designed in doc 01 §4, §5 and §10; this document names who and what they protect against and where each one is enforced.

It covers CE as deployed by an operator, and everything SlugBase Cloud takes from CE. It lives in the public CE repository as `docs/internal/10-threat-model.md`, the `threatModel` path in CE's `.claude/workflow.json` (doc 09 §5.2). The assets, attackers, entry points, invariants and residuals that exist only in SlugBase Cloud are recorded in the Cloud threat model in the private Cloud repository, under the same numbers; this document keeps a one-line stub in their place, so numbers are never reused.

Code anchors name a package, directory or file and are checked against `dev`. Until the code exists they are the planned locations from doc 09 §2; when code moves, the anchor moves with it in the same change.

---

## 1. Assets

| Asset | Why it matters | Where it lives |
|---|---|---|
| **Workspace content** — bookmarks (URLs, titles, slugs), folders, tags, teams, sharing grants, audit log | The product's reason to exist. Link libraries reveal internal tools, private documents, customers and habits; a leak across workspaces ends trust in a privacy-positioned product. | `public` schema tables, every one carrying `workspace_id` (doc 05) |
| **Tenant isolation** | The property that makes multi-tenancy acceptable at all: no workspace can read or change another's rows. | Enforced in `packages/db` (`withTenant`, repositories, RLS policies) |
| **Accounts and credentials** | Password hashes, TOTP secrets, backup codes, API tokens, sessions, invitation/reset/verification tokens. A stolen credential is a stolen workspace. | `accounts`, `sessions`, `api_tokens`, `mfa_*`, `credential_tokens` tables; `packages/server/src/auth/`, `packages/adapters/src/identity/` |
| **Secrets at rest and deployment secrets** | `ENCRYPTION_KEY` (unlocks every encrypted column), `SESSION_SECRET`, SMTP/AI/OIDC credentials, database credentials (`DATABASE_URL`, `DATABASE_MIGRATE_URL`), registry push credentials. Cloud's additional secrets are listed in the Cloud threat model. | Environment of each process: the operator's compose/env file (CE); GitHub Actions secrets for the release job (registry push) |
| **Billing state** (Cloud) | Cloud — see the Cloud threat model. | — |
| **Availability of `/go`** | Slugs are muscle memory; a member's address-bar workflow depends on `/go` resolving quickly and correctly. | `server` processes, Postgres |
| **The server's network position** | The server can reach internal addresses (the deployment's internal container networks, the database, cloud metadata services, the operator's LAN on CE). An attacker who steers its outbound requests inherits that position. | `packages/adapters/src/egress/` |
| **Build and release integrity** | The CE image is run by operators who trust it, and SlugBase Cloud is built from the same packages and runs them with production secrets. | CI workflows, GHCR, the lockfiles |
| **Operator console data** (Cloud) | Cloud — see the Cloud threat model. | — |

---

## 2. Attackers

The realistic threats, in order of likelihood: a **member of one workspace probing another's data** through the API (2.2) — the class of bug a multi-tenant product is most likely to ship; **credential stuffing and phishing** against sign-in (2.1, 2.12); a **malicious destination URL** turning the metadata/favicon fetcher into an SSRF probe (2.7); and **a hostile web page** a signed-in member visits trying to act through their session (2.6).

Each attacker has a **capability**, a thing it is **trusted with**, and a thing it **must never reach**. A finding names the attacker it relies on; a finding that needs a capability the named attacker does not have is not a finding of that kind.

### 2.1 Anonymous internet client

- **Capability:** sends arbitrary HTTP to any public origin: the app origin (`/api/*`, `/go/*`, static assets). Cloud's additional public endpoints are listed in the Cloud threat model. Can create accounts where public registration is on (Cloud by default). Can guess credentials subject to rate limits, and can automate at scale from many IPs.
- **Trusted with:** static assets, `/api/config`, `/opensearch.xml`, `/health`, `/version`, sign-in, registration (where enabled), password-reset request, email verification and invitation-acceptance endpoints, the first-run setup endpoint **only while the instance has no account**.
- **Must never reach:** any workspace content, whether a slug or bookmark exists (`/go` for an anonymous client always redirects to sign-in, with no response difference for existing and non-existing slugs), whether an email has an account (T8), the setup endpoint after setup completed, any account's session.

### 2.2 Signed-in account outside the target workspace — the cross-tenant attacker

- **Capability:** a valid session or API token for an account that is a member (any role, including owner) of one or more workspaces, **but not of the target workspace**. Knows or can guess the target's identifiers (UUIDs leak through shared screenshots, URLs or exports). Can send any request the API accepts, with any parameters, headers and bodies.
- **Trusted with:** everything in its own workspaces according to its role there.
- **Must never reach:** any row of the target workspace — read, existence, count or timing signal, write or delete — through any operation, filter, sort, search, export, `/go`, favicon or AI suggestion path (T1). Not even by switching the active workspace to one it is not a member of (T1, doc 01 §4 step 7).

### 2.3 Workspace member

- **Capability:** the `member` role in the target workspace: creates and edits its own bookmarks, folders and tags, uses slugs and `/go`, sees what is shared with it, uses the palette and search, creates API tokens for itself.
- **Trusted with:** its own content and content shared with it (directly, via a team it belongs to, via a shared folder) — read-only for shared content.
- **Must never reach:** another member's unshared bookmarks, folders or tags (including through slug collision on `/go`, search, counts, folder membership or export); modification of content it does not own (T2); member/team/workspace administration; another member's tags (tags are private); content after it has left or been removed from the workspace.

### 2.4 Invitee

- **Capability:** received an invitation link for an email address; may or may not have an account; may forward the link.
- **Trusted with:** accepting that one invitation, once, into the workspace and role it names, as the account whose verified email matches the invitation (T19).
- **Must never reach:** the workspace before acceptance; a different role than invited; acceptance after expiry, revocation or use; acceptance under an account whose email does not match.

### 2.5 Workspace admin or owner

- **Capability:** the `admin` or `owner` role in a workspace: manages members, invitations, teams, workspace settings, the AI toggle, reads the audit log; owners delete the workspace and (Cloud) manage billing.
- **Trusted with:** everything inside its workspace that the role allows by design — including removing members, which makes their authored content stay with the workspace (doc 02).
- **Must never reach:** another workspace (that is 2.2); another member's **unshared** private content (admins administer membership, they do not read members' private bookmarks — doc 02 §10); another account's credentials, sessions or MFA; instance-wide administration (CE); billing of another workspace.
- **What is not a finding:** an admin removing a member, changing roles, revoking invitations, disabling AI, deleting their own workspace after confirmation.

### 2.6 Hostile web page in a signed-in member's browser

- **Capability:** any page a member visits — another site, an ad, a compromised marketing page, an HTML email preview — can make the browser navigate to, submit forms to, or embed the app origin, and can open popups. It cannot read responses from the app origin (same-origin policy), cannot set `__Host-` cookies for it, and cannot add custom headers to cross-site navigations.
- **Trusted with:** nothing. Top-level `GET` navigations (e.g. to `/go/<slug>`) are allowed by design (§5.3).
- **Must never reach:** any state change performed with the member's session (T5); framing of the app (clickjacking); reading app data through a misconfigured CORS or JSONP-like surface (there is no CORS, doc 01 §2.3); script execution in the app origin (T14); an open redirect through `/go` or a `returnTo` parameter to a destination the member did not save (T12).

### 2.7 Malicious destination site and content source

- **Capability:** controls a URL a member saves as a bookmark, and therefore what the server receives when it fetches metadata or the favicon, what the AI provider sees, and what the member is forwarded to. Controls DNS for its domain (can rebind), HTTP redirects, response size and timing, `Content-Type`, HTML and SVG content. Also covers a compromised or malicious **AI provider response** and a malicious **OIDC provider discovery document** the operator configured.
- **Trusted with:** being fetched through the egress path, within its limits, and having title/description text stored as plain text.
- **Must never reach:** an internal address through the server's fetch — private, loopback, link-local, CGNAT, unique-local IPv6, cloud metadata, the database, the deployment platform's internals, the operator's LAN — directly, via redirect, via DNS rebinding or via IPv4-mapped IPv6 (T6); the server's memory or disk through oversized or slow responses (T6); script execution in the app through stored metadata, favicons (SVG) or AI output (T13, T14).

### 2.8 Hostile import file

- **Capability:** the content of a JSON or Netscape-HTML bookmark file a member (or a member tricked into it) uploads: arbitrary size up to the cap, nesting, encodings, URL schemes, HTML, very long strings, duplicate and colliding slugs, folder names that look like paths.
- **Trusted with:** being parsed as data, in memory, within caps, into the importing member's own workspace and ownership.
- **Must never reach:** another member's or workspace's data; the server's resources beyond the caps; storage of non-`http(s)` destinations (`javascript:`, `data:`, `file:`); script execution when titles are rendered; slugs or folder associations that bypass validation (T13).

### 2.9 Billing-event spoofer (Cloud)

Cloud — see the Cloud threat model. The number is kept so it is never reused.

### 2.10 Operator — the trust ceiling

The operator owns the deployment. Two shapes, one ceiling:

- **CE instance admin.** An account with the instance-admin flag in a CE deployment (the first account, and any account it promotes), plus whoever holds the host, the environment and the database. Can create and delete workspaces, manage accounts, reset another account's MFA (doc 02), read the database directly, change configuration.
- **Cloud operator.** The operator of SlugBase Cloud holds its deployment platform (including every runtime secret value), the database, the CI secrets and the billing service. What that covers in detail, including the Cloud operator console, is in the Cloud threat model.
- **Trusted with:** everything in their deployment. The operator is the data controller (CE) or the processor/controller described in the Cloud privacy policy (Cloud).
- **Must never reach, through the product:** a member's **password** or **TOTP secret** in plaintext (hashes and encrypted values only, T4, T7); a session token value; a way to act as a member **through the application** without an audited, member-visible action (no silent impersonation endpoint exists, T15).
- **What is not a finding:** anything an operator can already do by design or by holding the host — reading the database, changing environment variables, deleting a workspace, resetting MFA through the documented recovery, reading logs. A finding about operator capabilities is a finding only when it crosses the line above, or when a lower attacker can reach an operator capability.

### 2.11 Compromised dependency, CI step or build input

- **Capability:** an npm package, GitHub Action, base image or build script that executes attacker-chosen code during install, build, test or at runtime; a malicious pull request to the public CE repository; documentation content (`docs/user/**`, `docs/self-hosting/**`, `docs/releases/**`) that a site build consumes is untrusted build input: MDX is limited to an allow-list of components with no `import`/`export`, checked by `pnpm docs:check`, and a deployment that builds from it keeps the build job free of deployment secrets (doc 09 §3.5).
- **Trusted with:** what its step was given.
- **Must never reach:** deployment secrets from a pull-request workflow (fork PRs never get secrets, `pull_request_target` is not used); the registry push credentials outside the release/deploy jobs; a published image that differs from what CI built from the reviewed commit (T16); the production database from CI (a managed deployment that runs `migrate` as a separate CI step confines it to that gated step; Cloud — see the Cloud threat model, T21).

### 2.12 Holder of a leaked credential artefact

- **Capability:** obtained one artefact belonging to someone else: an API token (from a script, a log, a screenshot), a password-reset or verification link (from a forwarded email, a mail scanner), an invitation link, a backup-codes printout, a stolen-but-expired session cookie, or a password from another site's breach (credential stuffing).
- **Trusted with:** nothing beyond what the artefact itself grants **while valid**: an API token acts as its account within its workspace and scope (Q16) and cannot reach the interactive surfaces (no cookie session, no MFA changes, no token creation — T18).
- **Must never reach:** more than the artefact's scope; use after expiry, revocation or first use (single-use links); escalation from an API token to a session, to MFA changes, to email/password change, or to new tokens (T18); a password login of an MFA-enrolled account without the second factor (T17).

---

## 3. Entry points, mapped to code

Everything an attacker can send something to, with the package that owns the check. A finding names an entry point from this list.

| Entry point | Reachable by | Owner (planned, in `dev`) |
|---|---|---|
| **HTTP chain** — request context, trusted proxies, security headers, body limits, authentication, cross-site checks, rate limits, tenant resolution, validation, authorization (doc 01 §4) | 2.1–2.6, 2.12 | `packages/server/src/http/` (`chain.ts`, `trusted-proxy.ts`, `headers.ts`, `cross-site.ts`, `rate-limit.ts`, `tenant.ts`, `authorize.ts`) |
| **Operation declarations** — every route's auth policy, role, entitlement and schemas | 2.2–2.5 | `packages/contracts/src/operations/`, `packages/server/src/routes/` (route registration rejects an operation without a policy) |
| **Sign-in, MFA, sessions, API tokens** | 2.1, 2.12 | `packages/server/src/auth/` (`login.ts`, `mfa.ts`, `sessions.ts`, `api-tokens.ts`, `reauth.ts`), `packages/core/src/auth/` |
| **Registration, verification, password reset, email change** (including the "this wasn't me" link of an email-change notice, which cancels the change and revokes sessions) | 2.1, 2.12 | `packages/server/src/routes/auth/`, `packages/core/src/auth/credential-tokens.ts` |
| **First-run setup** | 2.1 | `packages/server/src/routes/setup/` (refuses once any account exists, in a transaction with an advisory lock) |
| **Invitations** | 2.4, 2.5, 2.12 | `packages/core/src/workspaces/invitations.ts`, `packages/server/src/routes/invitations/` |
| **OIDC sign-in** — start, callback, account linking | 2.1, 2.7, 2.12 | `packages/adapters/src/identity/oidc.ts`, `packages/core/src/auth/federated.ts` |
| **Tenant data access** — `withTenant`, repositories, RLS policies, system operations | 2.2, 2.3, 2.5 | `packages/db/src/tenant.ts`, `packages/db/src/repositories/`, `packages/db/src/rls/`, `packages/db/src/system/` |
| **Sharing and record-level authorization** | 2.3, 2.5 | `packages/core/src/sharing/`, `packages/core/src/authz/` |
| **`/go/<slug>` resolution and disambiguation** | 2.1, 2.3, 2.6 | `packages/core/src/go/`, `packages/server/src/routes/go.ts` |
| **Search, lists, palette, export** (JSON and Netscape HTML) and `GET /opensearch.xml` (anonymous, built from the deployment origin only) | 2.1, 2.2, 2.3 | `packages/core/src/bookmarks/`, `packages/core/src/search/`, `packages/core/src/export/` |
| **Import** — JSON and Netscape HTML upload | 2.8 | `packages/core/src/import/` (`json.ts`, `netscape.ts`), `packages/server/src/routes/import.ts` |
| **Outbound fetches** — metadata, favicons, AI provider, OIDC discovery and JWKS (every server-initiated HTTP request) | 2.7 | `packages/adapters/src/egress/` (the only module allowed network imports), `packages/server/src/worker/jobs/` (`fetch-metadata.ts`, `fetch-favicon.ts`, `ai-suggest.ts`) |
| **Favicon and metadata serving** | 2.6, 2.7 | `packages/server/src/routes/favicons.ts` (content-type allowlist, SVG refused or rasterised, `nosniff`) |
| **Rendering of user-controlled content in the SPA** | 2.6, 2.7, 2.8 | `packages/web/src/`, `packages/ui/src/` |
| **Operator-configured destinations outside egress** — the SMTP server the mail adapter connects to and the error-report transport. Both are chosen by the operator in configuration, never by a member or by request data, and are not HTTP fetches on behalf of a request | 2.10 | `packages/adapters/src/mail/`, `packages/adapters/src/errors/`; their credentials are secrets (T7) |
| **Secrets at rest** | 2.10, 2.11 | `packages/adapters/src/secret-box/` |
| **Configuration and startup checks** | 2.10, 2.11 | `packages/server/src/config/` |
| **CI, image build and deploy** | 2.11 | `.github/workflows/`, `apps/*/Dockerfile` (Cloud's deploy paths: see the Cloud threat model) |
| **Cloud entry points** (Cloud) — billing, contact, marketing site, operator console, deploy and migrate path, access layer, runtime environment | — | Cloud — see the Cloud threat model §3 |

Future boundaries, listed so a finding about them is recognised as design work rather than a defect in shipped code: custom forwarding domains, public share pages, a browser extension and subdomain tenancy (all out of v1 scope, doc 00 §4).

---

## 4. Security invariants

Each invariant is one sentence and the code that enforces it. Findings and verdicts cite them by number (`violates T1`). An invariant the code does not yet hold is still an invariant; a violation is a finding. Ids are never reused or renumbered; new ones are added at the end.

| # | Invariant | Anchor |
|---|---|---|
| **T1** | No principal reads, counts, detects or changes a row of a workspace it is not a member of: every tenant query runs inside `withTenant()` as the non-owner `slugbase_app` role, every tenant table has RLS **enabled and forced**, and cross-tenant needs go only through named system operations. The metadata and AI caches are keyed per workspace, so timing cannot reveal what another workspace saved. | `packages/db/src/tenant.ts`, `packages/db/src/rls/`, `packages/db/src/system/`; the cross-tenant matrix (doc 08 §3.3) |
| **T2** | Within a workspace, only a bookmark's or folder's owner may modify or delete it; read access comes only from ownership or a live sharing grant (direct, team, shared folder); tags are visible only to their owner; access ends when membership ends. | `packages/core/src/authz/`, `packages/core/src/sharing/` |
| **T3** | Every operation declares its authentication requirement, role and entitlement in its contract; an operation without a declaration cannot be registered; authorization runs before the handler. | `packages/contracts/src/operations/`, `packages/server/src/routes/register.ts`, `packages/server/src/http/authorize.ts` |
| **T4** | Session tokens, API tokens, the first-run setup token and single-use credential tokens are stored only as hashes; the session cookie is `__Host-` (production), `HttpOnly`, `Secure`, `SameSite=Lax`; sessions rotate on sign-in, MFA completion and privilege change, and revocation takes effect on the next request. | `packages/server/src/auth/sessions.ts`, `api-tokens.ts`, `packages/core/src/auth/credential-tokens.ts` |
| **T5** | A cookie-authenticated state-changing request is processed only when its `Origin` equals the deployment origin, `Sec-Fetch-Site` (when present) is `same-origin`, and its content type is JSON (or multipart on import); there is no exemption list; the app sends `frame-ancestors 'none'`. | `packages/server/src/http/cross-site.ts`, `headers.ts` |
| **T6** | Every server-initiated outbound HTTP request goes through the egress adapter, which resolves DNS itself, refuses non-public addresses (IPv4 and IPv6, including mapped forms) for the connected IP, re-validates every redirect hop, pins the validated IP for the connection, and enforces time, size and content-type caps. The only exception to refusing non-public addresses is an entry in the operator's allowlist for the exact host of the configured AI endpoint (Q90); member input can neither add nor widen it, and every other case applies to that host unchanged. The SMTP connection and the error-report transport are operator-configured destinations outside egress (§3); they never take a destination from request data. | `packages/adapters/src/egress/`; lint rule forbidding network imports elsewhere |
| **T7** | Secrets persisted in the database (TOTP secrets, any stored credential) are encrypted by the secret box with a key ID; no secret, password, token, cookie, MFA code or full email body appears in logs, error reports, analytics events or API responses. | `packages/adapters/src/secret-box/`, `packages/server/src/http/` (logger redaction list), `ErrorReportPort` scrubber |
| **T8** | Sign-in, registration, password reset, email change and invitation endpoints give no signal — status, body, or timing class — that distinguishes an existing account or email from a non-existing one. | `packages/server/src/routes/auth/`, `packages/core/src/auth/` |
| **T9** | Rate limits on sign-in, MFA, registration, reset, invitation acceptance and token creation hold per IP and per account, and the client IP is derived only across the configured trusted proxy hops. (Cloud extends this to its own public endpoints — see the Cloud threat model.) | `packages/server/src/http/rate-limit.ts`, `trusted-proxy.ts`, `packages/adapters/src/rate-limit/` |
| **T10** (Cloud) | Cloud — see the Cloud threat model. | — |
| **T11** | Entitlements are enforced by the server at every enforcement point (bookmark creation and import, workspace creation, AI, sharing, team administration, invitations, audit log); the UI hiding a feature is never the control; entitlements derive only from the entitlement source. | `packages/core/src/entitlements/`, the operations' declared `entitlement` |
| **T12** | `/go` resolves only for a signed-in member, only within the active workspace, only to accessible forwarding-enabled bookmarks, and only to `http`/`https` destinations; no endpoint redirects to a URL taken from a request parameter except same-origin relative paths. | `packages/core/src/go/`, `packages/server/src/routes/go.ts`, `packages/core/src/bookmarks/url.ts` |
| **T13** | Imported files, fetched metadata and AI output are data: parsed in memory within size and count caps, stored as plain text, URLs restricted to `http`/`https`, nothing executed or followed beyond the egress rules. | `packages/core/src/import/`, `packages/server/src/worker/jobs/`, `packages/core/src/bookmarks/url.ts` |
| **T14** | User-controlled text (titles, descriptions, folder and tag names, metadata, AI output) is never rendered as HTML or script: no `dangerouslySetInnerHTML` on it, the CSP allows no inline script or `eval`, and favicons are served with an image allowlist and `nosniff` (SVG refused or rasterised). | `packages/web/src/`, `packages/ui/src/`, `packages/server/src/http/headers.ts`, `packages/server/src/routes/favicons.ts` |
| **T15** | The customer application has no operator endpoints and no impersonation path. (Cloud adds the operator console's isolation — see the Cloud threat model.) | `packages/server/src/routes/` (absence) |
| **T16** | Images are built only by CI from a reviewed commit with a frozen lockfile, carry SBOM and provenance, are signed keylessly by the release workflow's identity so operators can verify them (from the first signed release candidate, Q92), and are deployed by immutable version tag or digest; pull-request workflows from forks never receive secrets. (Cloud adds its deploy-branch and CE-pin rule — see the Cloud threat model.) | `.github/workflows/` |
| **T17** | A password sign-in of an MFA-enrolled account completes only after a valid TOTP code (each time step usable once) or an unused backup code, and so does any other first-factor completion, such as a password reset, which leaves the session partial until then; disabling MFA or regenerating backup codes requires the second factor. | `packages/server/src/auth/mfa.ts`, `packages/core/src/auth/mfa.ts` |
| **T18** | Changing password or email, disabling MFA, creating API tokens, deleting the account and (CE) any instance-admin action require a session with recent re-authentication (password or OIDC re-login within 10 minutes); API tokens can never perform them. | `packages/server/src/auth/reauth.ts`, the operations' declared policy |
| **T19** | An invitation is accepted at most once, before expiry, unless revoked, and only by an account whose verified email equals the invited email; acceptance grants exactly the invited role in the invited workspace. | `packages/core/src/workspaces/invitations.ts` |
| **T20** | A federated sign-in links to an existing account only through an `email_verified` claim from a provider the operator configured, validated with issuer, audience, nonce and PKCE; it never links by an unverified email. | `packages/adapters/src/identity/oidc.ts`, `packages/core/src/auth/federated.ts` |
| **T21** (Cloud) | Cloud — see the Cloud threat model. | — |
| **T22** | `GET /health` and `GET /version` disclose nothing beyond liveness and `{ name, version, commit, builtAt }`. (Cloud adds its staging exposure rule — see the Cloud threat model.) | `packages/server/src/routes/health.ts` |
| **T23** | Tooling and agents never read or write secret values in GitHub or in a deployment's environment. (Cloud adds its environment key-name check — see the Cloud threat model.) | `.claude/` rules |
| **T24** (Cloud) | Cloud — see the Cloud threat model. | — |
| **T25** (Cloud) | Cloud — see the Cloud threat model. | — |

---

## 5. Accepted residuals

These are accepted on purpose and are **not findings**, as is anything the operator can do by design (§2.10). Tightening or loosening one is a change to this section first, with a reason.

1. **Usage counts can be lost.** `/go` and open counts are buffered per process for up to 10 s (doc 01 §8.1) and lost on a crash. Counts are statistics, not records.
2. **Destination sites learn the server's IP and the fetch time.** Metadata and favicon fetches come from the server (or the configured outbound proxy). The favicon proxy exists so members' browsers do not contact destination sites from the app; the server doing so is the trade.
3. **Cross-site top-level `GET /go/<slug>` is allowed.** A hostile page (2.6) can navigate a signed-in member to `/go/<slug>`; the effect is that the member lands on a destination they saved themselves and a usage counter increments. `SameSite=Lax` is required for address-bar use.
4. **An API token is a bearer credential.** Anyone holding it acts as its account within its scope until it is revoked or expires (2.12). Mitigations are hashing at rest, the `slb_` prefix for secret scanners, last-used display and per-token revocation, not binding.
5. **Rate limits are a cost, not a wall.** A distributed attacker with many IPs can still attempt credential stuffing at the per-account limit; the per-account limit, breached-password checks (Q15) and MFA are the defence.
6. **The operator can read everything** in their own deployment (§2.10), including workspace content in the database. Cloud's privacy policy states what MDG Labs does and does not do with that access.
7. **Workspace membership is visible to members.** Members of a workspace can see who else is a member (names and emails) — the product needs it for sharing.
8. **Slug existence within one's own reachable set** is observable by design: a member learns whether a slug they type resolves among bookmarks they can access.
9. (Cloud) Cloud — see the Cloud threat model.
10. (Cloud) Cloud — see the Cloud threat model.
11. (Cloud) Cloud — see the Cloud threat model.
12. (Cloud) Cloud — see the Cloud threat model.
13. **An allowlisted AI endpoint may sit on a private address.** An operator who runs a self-hosted model lists its exact host in the allowlist of Q90; the server then connects to that private address for AI suggestion requests only. The operator chose it (2.10), no member input reaches the allowlist, and DNS pinning, size and time caps still apply to it; a redirect away from the allowlisted host is validated like any other hop.
14. (Cloud) Cloud — see the Cloud threat model.

---

## 6. Severity rubric

Five levels, defined in SlugBase's terms. The rating is the **lowest** level whose definition the finding meets after the anti-inflation rules below.

| Level | Definition |
|---|---|
| **Critical** | An attacker from 2.1 or 2.2 — anonymous, or signed in to *another* workspace — reads or changes another workspace's content, takes over another account, or reaches the server's internal network position (SSRF to an internal address with a readable response), **in the default configuration**. Cloud adds its billing outcomes in the Cloud threat model. |
| **High** | The same class of outcome from a more constrained position: a member (2.3) reading another member's unshared content or modifying content it does not own; an invitee (2.4) joining with a wrong role or account; a hostile page (2.6) performing a state change with a member's session (CSRF) or executing script in the app origin (stored XSS); a leaked artefact (2.12) escalating beyond its scope; a blind SSRF to internal addresses; bypass of MFA (T17) or of the setup lock. |
| **Medium** | A bounded confidentiality or integrity loss, or one needing a precondition the default configuration does not give: account or email enumeration (T8); a missing rate limit on a credential endpoint (T9); a secret or token written to logs (T7); a workspace admin (2.5) reading members' unshared content; a violation of an invariant with no working path to a High outcome; a denial of service on `/go` from a single unauthenticated client. |
| **Low** | A weakness whose exploitation needs an already privileged or already compromised position, or a defence-in-depth gap with no attack path today: a missing security header with no injection point, a weak-but-not-broken parameter, a hardening gap only an operator can reach. |
| **Info** | An observation with no exploitable path: documentation drift in a control, a hardening suggestion, a dependency advisory in a code path SlugBase does not use. |

**Anti-inflation rules.** A finding is rated only after all of these hold:

1. **A reachable entry point** from §3, named, with its owner.
2. **A named attacker** from §2, using only that attacker's capability. A finding that needs the operator (2.10), or a capability the named attacker lacks, is not a finding at that level.
3. **The production build and defaults**: the released image, `NODE_ENV=production`, the composition root of the edition in question, the shipped configuration. A path that exists only in development (`pnpm dev`, `.env.local` defaults, the MSW mock, a billing fake, a test-only repository build, seed data) is rated by that precondition — normally Info — not as if it were the default.
4. **Operator-by-design is not a finding**, and neither is anything in §5.
5. **A mock, a fixture or a test helper is not a vulnerability.**
6. **Theory is checked.** A finding states the exact sequence from entry point to outcome, and a verifier re-derives it independently before it is rated above Low.

### Worked examples

All constructed against SlugBase's planned surfaces; real findings replace them as the project accumulates history.

- **Critical (constructed).** `GET /api/bookmarks/{id}` loads the bookmark with a repository method that takes the ID but not the tenant transaction, through a system operation added "for performance". An account in workspace A (2.2) requests a UUID from workspace B and receives it. Entry point: tenant data access. Violates T1. The cross-tenant matrix in API mode would catch it; RLS would not, because the system operation bypasses it — which is why system operations are a named, reviewed list.
- **High (constructed).** The bookmark title is rendered through a Markdown component that allows raw HTML. A member (2.3) shares a folder whose bookmark title contains an `<img onerror>` payload; another member opens the folder. Script runs in the app origin. Violates T14; the CSP blocks inline handlers in production, so the finding is rated High for the rendering defect even if the CSP holds — a CSP is defence in depth, not the control.
- **High (constructed).** The favicon job follows a redirect from `https://evil.example/favicon.ico` to `http://169.254.169.254/latest/meta-data/` without re-validating, and the proxy serves the response body back as an image. A malicious destination site (2.7) reads the response through the member's browser. Violates T6; with a readable response from an internal address it would be Critical on a host where that metadata service exists.
- **Medium (constructed).** `POST /api/auth/password-reset` returns `202` in ~5 ms for unknown emails and in ~120 ms for known ones because only the known path sends mail synchronously. An anonymous client (2.1) enumerates accounts. Violates T8. Mail must be queued for both paths.
- **Info (constructed).** Doc 01 §10 states a 180-day absolute session cap and the code enforces 90. Code stricter than the doc; documentation fix.

---

## 7. Disclosure split

The rubric decides where a finding is recorded. A finding rated **Critical or High** goes to a **private repository security advisory** in the repository that owns the code (CE findings in `mdg-labs/slugbase`, Cloud findings in the private Cloud repository), never to a public issue, and is fixed with `/orchestrate --advisory <GHSA-id>`; its commit message is neutral (`Refs: GHSA-…`), with no reproduction detail. **Medium, Low and Info** findings are public issues carrying the `security` label. A public finding that shares a root cause with a withheld one is withheld too. `.claude/scripts/audit-report.sh` enforces the split mechanically.

Outside reports arrive through GitHub **private vulnerability reporting** on `mdg-labs/slugbase` and **`support@slugbase.app`** (the security contact; `hello@slugbase.app` is the general address), as `SECURITY.md` describes (acknowledgement within 3 working days, coordinated disclosure, credit on request, Q86). A CE vulnerability fixed in a release is announced in the release notes and, for Critical/High, with a published advisory once operators have had a patched image for 7 days. Dependabot alerts are never dismissed; they are filed with `/triage dependabot <n>` (`mdg-security.md`).
