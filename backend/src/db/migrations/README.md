# Core migrations

Only migrations **registered** in `index.ts` are run by the self-hosted core. The registered set is: 001–009, 013–015, 018–020.

**Cloud-only schema** (organizations, org_members, org_invitations, org-scoped teams, plan/billing columns, AI-on-org) is maintained in the **SlugBase Cloud** deployment codebase, not here. Do not add such migrations to the core registered list. Files in this directory named `_legacy_cloud_*.ts` are kept for reference only and must **not** be imported or registered in `index.ts`.
