---
title: "Set Up OIDC Sign-In"
description: "Add OpenID Connect sign-in providers to a self-hosted SlugBase, understand how accounts are linked and created, and check that a provider works."
edition: ce
order: 50
---

SlugBase can let people sign in with an identity provider that you run or trust, through OpenID Connect (OIDC). You configure each provider with environment keys. Only you, the operator, can add a provider. Workspace admins cannot. This page covers the keys, the redirect address to register at the provider, how SlugBase links and creates accounts, and a checklist to run when you are done.

## Prerequisites

- A `compose.yml` installation that runs over HTTPS. See [Put SlugBase Behind a Reverse Proxy](reverse-proxy.md).
- An OIDC provider that you can register an application at, and that your SlugBase server can reach on a public address. See [Where the provider may be](#where-the-provider-may-be).
- Docker Compose 2.24 or later, which `compose.yml` needs to read the optional `.env.oidc` file.

## What the provider must supply

SlugBase uses the authorization code flow with PKCE, a `state` value and a `nonce`. The provider must offer:

- A discovery document at `<issuer>/.well-known/openid-configuration` whose `issuer` is exactly the issuer URL you configure, with an authorization endpoint, a token endpoint and a `jwks_uri`.
- A token endpoint that accepts the client secret as HTTP Basic or in the form body (`client_secret_basic` or `client_secret_post`).
- An ID token signed with RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512 or EdDSA.
- In the ID token: a `sub` claim, and for linking and creating accounts an `email` claim with `email_verified` set to true. A `name` claim is used as the display name of an account that SlugBase creates.

## Set up a provider

### Register SlugBase at the provider

In the provider, create an application of the type "web" or "confidential client", and register this redirect address.

```text
https://links.example.com/api/v1/auth/oidc/<slug>/callback
```

Use your own `APP_ORIGIN` for the host. `<slug>` is the name of the provider on the sign-in page, which is the `<SLUG>` of your keys in lower case, with each underscore written as a hyphen. A provider whose keys start with `OIDC_COMPANY_SSO_` has the slug `company-sso`, so its redirect address ends in `/api/v1/auth/oidc/company-sso/callback`. The provider gives you a client ID and a client secret.

### Set the keys

Choose a `<SLUG>` for the provider: upper-case letters and digits, in groups joined by single underscores, such as `GOOGLE` or `COMPANY_SSO`. Put the keys in a file named `.env.oidc` next to `compose.yml`. Only the server reads that file. `.env` does not reach the server container, and the keys in `.env.oidc` are not read by the worker. The file is optional: without it SlugBase starts with no provider.

```sh
OIDC_COMPANY_SSO_ISSUER_URL=https://sso.example.com
OIDC_COMPANY_SSO_CLIENT_ID=<your client ID>
OIDC_COMPANY_SSO_CLIENT_SECRET='<your client secret>'
OIDC_COMPANY_SSO_NAME=Company SSO
```

Put the client secret in single quotes, as shown. Compose replaces a `$` and the name after it in a value without quotes, so a secret that holds one reaches SlugBase changed and the sign-in fails. Single quotes keep the value as it is. If the secret holds a single quote itself, ask the provider for a new secret without one.

Keep only `OIDC_<SLUG>_*` keys in this file. The container receives it as it is. Make it readable by you only, and keep it out of version control.

```sh
chmod 600 .env.oidc
```

Then start the containers again so that the server reads the file.

```sh
docker compose up -d
```

| Key | Required | What it sets |
| --- | -------- | ------------ |
| `OIDC_<SLUG>_ISSUER_URL` | Yes | The issuer of the provider. In production it is an `https` address with no credentials, query or fragment. It must be the `issuer` that the provider's discovery document names, character for character. |
| `OIDC_<SLUG>_CLIENT_ID` | Yes | The client ID that the provider gave you. |
| `OIDC_<SLUG>_CLIENT_SECRET` | Yes | The client secret that the provider gave you. |
| `OIDC_<SLUG>_NAME` | No | The name on the button of the sign-in page, 1 to 64 characters. It defaults to the slug. |
| `OIDC_<SLUG>_SCOPES` | No | The scopes to ask for, separated by spaces or commas. They must include `openid`. The default is `openid email profile`. Keep `email`: without it the provider sends no address, and SlugBase can neither link nor create an account. |
| `OIDC_<SLUG>_ENABLED` | No | `true` or `false`. The default is `true`. Set `false` to switch a provider off and keep its keys. |
| `OIDC_<SLUG>_AUTO_CREATE` | No | `true` or `false`. The default is `false`. See [Auto-create](#auto-create-accounts). |
| `OIDC_<SLUG>_ALLOWED_DOMAINS` | No | Comma-separated email domains, such as `example.com,example.org`. They limit which accounts auto-create may make. The default is any domain. |

A provider exists as soon as any of its keys has a value. An enabled provider that lacks `ISSUER_URL`, `CLIENT_ID` or `CLIENT_SECRET` stops SlugBase from starting, and the log names the missing key. It never prints a value.

The client secret lives only in the environment of the server. SlugBase does not store it in the database, shows it nowhere in the app, and does not log it.

You can configure as many providers as you want, each with its own `<SLUG>`.

## Where the provider may be

SlugBase fetches the discovery document, the signing keys and the token endpoint through its one guarded path for outbound requests. That path refuses an address that is not public: loopback, private (RFC 1918), shared CGNAT (such as the networks Tailscale uses), unique-local and link-local addresses. It also refuses a redirect from `https` to plain `http`.

For an OIDC provider there is **no setting that allows a private address**. `AI_ALLOWED_PRIVATE_HOST`, described in [Environment Settings](environment.md), covers the AI endpoint and nothing else. A provider whose issuer host name resolves to a private address, or whose discovery document points its token endpoint or key set at one, is left unavailable. The log then shows `discovery_failed` or `keys_failed` for it.

If your provider runs on a private network, give it a public address that the SlugBase server can reach, with a host name and a certificate for it. Only the server fetches these addresses. Your members' browsers need to reach the provider's authorization page only, and they may do that on your private network.

## How accounts are linked and created

A provider identity is the pair of the issuer and the `sub` claim. Every ID token is checked for its signature, issuer, audience, expiry and `nonce`, and the code exchange uses PKCE, before SlugBase believes any claim in it.

### Link to an existing account

A member can link a provider to their own account in **Settings**, **Account**, **Security**, under **Linked sign-in methods**. It needs a fresh re-authentication.

The first time someone signs in with an identity that is not linked, SlugBase links it to an existing account by email, and only when all of these hold:

- The provider asserts `email_verified` for the address.
- The address matches an account that is enabled.
- That account's own address is verified in SlugBase.

SlugBase never links by an address that the provider did not verify. It also never links to an account whose own address nobody verified, because whoever registered an address first is not necessarily its owner. Only configure a provider that verifies email addresses before it sets `email_verified`. A provider that lets people put any address in their profile would let them take over the account of that address.

### Auto-create accounts

With `OIDC_<SLUG>_AUTO_CREATE=true`, a first sign-in that finds no account to link to creates a verified account, signs it in and links the identity. It needs all of these:

- The provider asserts `email_verified` for the address, and no account holds that address.
- The domain of the address is in `OIDC_<SLUG>_ALLOWED_DOMAINS`, when you set that key.

An address at a domain that is not listed still links to the account that holds it. The list limits creation only.

What the new account gets depends on registration. With public registration on (`PUBLIC_REGISTRATION=true`), the account gets a personal workspace. With registration off, which is the default, the account has no workspace. Its owner sees **Waiting for an invitation**, and can use SlugBase only after a workspace admin invites that address. If you allow members to create workspaces in **Admin**, **Settings & status**, the account may see an option to create one instead. Without `AUTO_CREATE`, nobody gets an account through the provider unless they accept an invitation with it.

A person can also accept an invitation by signing in with a provider, when the provider asserts exactly the invited address as verified. That works whether `AUTO_CREATE` is on or off.

### What happens on a failure

Every failure ends in the same message on the sign-in page: "Signing in with that provider did not work. Try again, or sign in with your email address and password." Nothing on the page says which step refused, so the page does not reveal whether an account exists. The reason is in the server log as `An OIDC sign-in ended without a session`, with the provider and a fixed reason word such as `unverified_email`, `first_login_refused`, `invalid_token`, `exchange_failed` or `provider_unavailable`.

### Second factor and sessions

A sign-in through a provider is a full sign-in. SlugBase trusts the provider for the second factor and does not ask for its own code. If you need a second factor, require it at the provider. An account with no password uses its provider to re-authenticate for sensitive actions.

## Check the provider in the admin area

Open **Admin**, then **Settings & status**. Under **Configuration**, the row **Sign-in providers** lists the providers that are in use, each with the name from `OIDC_<SLUG>_NAME`. It shows **None** when there are none. The **Overview** page shows the same row.

SlugBase asks a provider for its discovery document and keys when it first needs them, not when it starts, and reuses what it found for an hour. A provider that you configured but that is not in the list did not answer correctly. Read the log of the server (`docker compose logs slugbase`) for the line `An OIDC provider is unavailable`. It names the provider and a fixed reason:

| Reason | Meaning |
| ------ | ------- |
| `discovery_failed` | The discovery document could not be fetched: a wrong issuer address, a network problem, a private address, a redirect to `http`, or an answer that was not `200`. A `code` field names the cause when the request was refused or failed. |
| `issuer_mismatch` | The `issuer` in the document is not exactly `OIDC_<SLUG>_ISSUER_URL`. Check for a trailing slash. |
| `invalid_discovery` | The document lacks an endpoint, uses a downgrade to `http`, or offers no token endpoint login method that SlugBase can use. |
| `keys_failed` or `invalid_keys` | The key set could not be fetched, or holds no usable key. |

SlugBase tries a provider that failed again after a minute, so a provider that was down needs no restart.

## Verify a provider

Run this list after you add or change a provider. Keep another way to sign in open, such as an instance admin password, in case you misconfigure it.

1. Start the containers again and read the log. `OIDC sign-in configured` names the slugs of your providers, and nothing says `An OIDC provider is unavailable`.
2. Open **Admin**, **Settings & status**. The provider is listed under **Sign-in providers**.
3. Open the sign-in page in a private window. It shows a button **Continue with** and the name of your provider.
4. Sign in with an account that has the same verified email address at SlugBase and at the provider. You arrive signed in. In **Settings**, **Account**, **Security**, the provider appears under **Linked sign-in methods**.
5. Sign out and sign in again with the provider. It no longer needs the email address to match.
6. Try an address that has no account. With `AUTO_CREATE` off, the sign-in page shows the failure message. With it on, an account is created. If registration is off, the account sees **Waiting for an invitation**.
7. If you set `OIDC_<SLUG>_ALLOWED_DOMAINS`, try an address outside the list. It must be refused.
8. Check that the provider verifies addresses. A test account whose address is not verified at the provider must be refused, with `unverified_email` in the log.

## Troubleshooting

**SlugBase does not start and names an `OIDC_` key.** An enabled provider lacks a required key, or a value is not valid. In production the issuer must be an `https` address.

**The provider is not on the sign-in page.** It did not answer discovery. See the reasons under [Check the provider in the admin area](#check-the-provider-in-the-admin-area).

**The provider reports a redirect or `redirect_uri` error.** The address registered at the provider is not exactly `APP_ORIGIN` followed by `/api/v1/auth/oidc/<slug>/callback`. Behind a proxy, check that `APP_ORIGIN` is the public HTTPS address.

**Signing in shows the failure message and the log says `unverified_email`.** The ID token has no `email`, or `email_verified` is not true. Check the scopes and the provider's settings for the user.

**Signing in works but does not link to my account.** The account must be enabled and its address verified in SlugBase, and the addresses must match. An administrator can mark an address verified in **Admin**, **Accounts**. Read the warning that the dialog shows first.

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Put SlugBase Behind a Reverse Proxy](reverse-proxy.md)
- [Set Up Mail](mail.md)
- [Environment Settings](environment.md)
