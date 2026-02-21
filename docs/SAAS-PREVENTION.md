# Keeping SlugBase core free of SaaS logic

This repo is the **open-source, self-hosted-only** core. SaaS-specific code (organizations, billing, cloud auth flows, etc.) lives in the private **slugbase-cloud** repo. Use this checklist to avoid leaking SaaS logic into core.

## Checklist (code review and CI)

- [ ] **No `isCloud` / cloud-mode branching**  
  Core must not branch on “cloud vs self-hosted”. `config/mode.ts` is fixed to `selfhosted`; there is no runtime cloud toggle.

- [ ] **No organizations in core**  
  No `organizations`, `org_members`, `org_invitations` tables or routes. No `org_id` / `current_org_id` in application code. Cloud-only migrations (010, 011, 012, 016, 017) must **not** be registered in `backend/src/db/migrations/index.ts`.

- [ ] **No billing / plans in core**  
  No Stripe, plan limits, or “upgrade” flows in this repo. Those belong in slugbase-cloud.

- [ ] **No cloud-only auth in core**  
  No public signup with email verification, refresh-token flow, or org-scoped auth. The `/auth/refresh` route in core returns 404; register/verify-signup exist only for self-hosted use when registrations are enabled (env-gated).

- [ ] **Tenant only as single default**  
  Core uses `tenant_id` with a single default tenant. Multi-tenant resolution (e.g. by org/host) is implemented in slugbase-cloud, not here.

## If in doubt

- Prefer the **safest and most maintainable** option.
- Do not add features that only make sense in a hosted SaaS unless they are behind a clear, documented boundary (e.g. a separate package or repo).
- See `.cursor/rules` and the main architecture plan for the intended split between core and cloud.
