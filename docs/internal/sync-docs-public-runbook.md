# Runbook — sync `docs/public/` to `slugbase-docs`

Operator guide for the CI workflow that mirrors public documentation from the SlugBase monorepo to the Documentation.AI publish repository.

| Field | Value |
|---|---|
| Workflow | [`.github/workflows/sync-docs-public.yml`](../../.github/workflows/sync-docs-public.yml) |
| Source | `docs/public/**` in `mdg-labs/slugbase` |
| Target | `mdg-labs/slugbase-docs` (`main`, repo root) |
| Trigger | Push to `slugbase` `main` when `docs/public/**` changes |
| Parent contract | [#392](https://github.com/mdg-labs/slugbase/issues/392) |

## Sync semantics

1. **Flat mirror** — contents of `docs/public/` copy to the **root** of `slugbase-docs` (e.g. `docs/public/documentation.json` → `slugbase-docs/documentation.json`).
2. **Replace strategy** — `rsync --delete` removes files from `slugbase-docs` that no longer exist under `docs/public/`.
3. **Scope** — only `docs/public/**`. `docs/internal/**`, `.cursor/**`, and other monorepo paths are never included.
4. **Idempotent** — if the mirror produces no diff, the workflow skips commit and push.
5. **Commit message** — references the source repository and SHA (`sync from mdg-labs/slugbase@<sha>`).

Documentation.AI watches `slugbase-docs` `main` and rebuilds on each push.

## GitHub secret

| Secret name | Repository | Purpose |
|---|---|---|
| `SLUGBASE_DOCS_DEPLOY_KEY` | `mdg-labs/slugbase` | SSH private key with **write** access to `mdg-labs/slugbase-docs` |

**Never commit key material.** Store the private key only in GitHub Actions secrets (or your local password manager during setup).

### One-time setup (operator)

1. Generate an ed25519 deploy key pair (no passphrase):

   ```bash
   ssh-keygen -t ed25519 -C "slugbase-docs-sync" -f slugbase-docs-deploy -N ""
   ```

2. In **GitHub → `mdg-labs/slugbase-docs` → Settings → Deploy keys → Add deploy key**:
   - Title: `slugbase CI sync`
   - Key: contents of `slugbase-docs-deploy.pub`
   - **Allow write access**: enabled

3. In **GitHub → `mdg-labs/slugbase` → Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `SLUGBASE_DOCS_DEPLOY_KEY`
   - Value: contents of `slugbase-docs-deploy` (private key, including `BEGIN`/`END` lines)

4. Securely delete local key files after storing the secret.

5. Confirm the secret exists (name only — do not print the value):

   ```bash
   gh secret list --repo mdg-labs/slugbase | rg SLUGBASE_DOCS_DEPLOY_KEY
   ```

Until this secret is configured, the sync workflow fails at the **Verify deploy key secret** step.

## Manual verification

After the secret is configured and a `docs/public/**` change has merged to `slugbase` `main`:

1. Open **Actions → Sync Public Docs** on `mdg-labs/slugbase` and confirm the run succeeded.
2. On `mdg-labs/slugbase-docs`, confirm a new commit on `main` whose message references the source SHA.
3. Verify root layout matches source, e.g.:
   - `documentation.json` at repo root
   - `selfhosted/quick-start.mdx` (or another known page)
4. **Delete test:** remove a file under `docs/public/`, merge to `main`, re-run sync, confirm the file is gone from `slugbase-docs`.

Local authoring validation (no publish):

```bash
pnpm validate:docs-public
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `SLUGBASE_DOCS_DEPLOY_KEY is not configured` | Secret missing on `slugbase` | Complete [one-time setup](#one-time-setup-operator) |
| `Permission denied (publickey)` | Deploy key not on `slugbase-docs` or write access disabled | Re-add deploy key with write access |
| Workflow did not run | Change not on `main` or outside `docs/public/**` | Merge to `main`; only path-filtered files trigger sync |
| No commit on `slugbase-docs` | Mirror already matched | Expected — idempotent skip |
| Documentation.AI stale | `slugbase-docs` push failed or DA build lag | Check workflow logs; check Documentation.AI dashboard |

## Related

- Authoring guide: [`docs/public/README.md`](../public/README.md)
- Publish contract: [#392](https://github.com/mdg-labs/slugbase/issues/392)
- Workflow implementation: [#396](https://github.com/mdg-labs/slugbase/issues/396)
