interface AdminRoleGateProps {
  t: (key: string) => string;
}

export function AdminRoleGate({ t }: AdminRoleGateProps) {
  return (
    <div
      className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6"
      data-testid="workspace-admin-role-gate"
    >
      <p
        className="m-0 text-fg-muted"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t("settings.workspace.admin_only_notice")}
      </p>
    </div>
  );
}
