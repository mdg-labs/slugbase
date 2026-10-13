import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useConfig } from "../config/config-context.tsx";

function Landing() {
  const { product } = useConfig();
  const { t } = useTranslation();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-6">
      <h1 className="text-2xl font-semibold">{t("landing.heading", { name: product.name })}</h1>
      <p className="text-muted-foreground">{t("landing.tagline")}</p>
    </main>
  );
}

export const Route = createFileRoute("/")({
  component: Landing,
});
