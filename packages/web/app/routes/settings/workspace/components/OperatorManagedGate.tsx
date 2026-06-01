interface OperatorManagedGateProps {
  titleKey: string;
  bodyKey: string;
  t: (key: string) => string;
}

export function OperatorManagedGate({ titleKey, bodyKey, t }: OperatorManagedGateProps) {
  return (
    <section
      className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6"
      data-testid="workspace-operator-managed-gate"
    >
      <h2
        className="m-0 text-fg font-semibold"
        style={{ fontSize: "var(--text-h3)", lineHeight: "var(--lh-h3)" }}
      >
        {t(titleKey)}
      </h2>
      <p
        className="mt-sp-3 m-0 text-fg-muted"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t(bodyKey)}
      </p>
    </section>
  );
}
