import { useTranslate } from "@tolgee/react";

export default function HomeRoute() {
  const { t } = useTranslate();

  return (
    <section className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-8 shadow-raised">
      <p className="t-body-lg">{t("app.home.welcome")}</p>
    </section>
  );
}
