import { EmptyState, InboxIcon } from "@slugbase/ui/patterns";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useConfig } from "../../config/config-context.tsx";

function Home() {
  const { product } = useConfig();
  const { t } = useTranslation();
  return (
    <EmptyState
      description={t("home.empty.description")}
      headingLevel={1}
      icon={<InboxIcon aria-hidden="true" />}
      title={t("home.empty.title", { name: product.name })}
    />
  );
}

export const Route = createFileRoute("/_app/")({
  component: Home,
});
