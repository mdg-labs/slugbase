import { Button } from "@slugbase/ui";
import { Banner, Loading } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "./me.ts";
import { PasswordCard } from "./password-card.tsx";
import { SessionsCard } from "./sessions-card.tsx";
import { TwoFactorCard } from "./two-factor-card.tsx";

/** `/settings/account/security` (doc 03 section 11.2): the password and the sessions of the signed-in account. */
export function AccountSecurityPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-xl">{t("settings.security.title")}</h1>
      {me.data === undefined ? null : me.data.account.hasPassword ? (
        <PasswordCard key={me.data.account.id} />
      ) : (
        <Banner
          description={t("settings.security.password.none.description")}
          title={t("settings.security.password.none.title")}
          variant="info"
        />
      )}
      {me.data === undefined ? null : <TwoFactorCard enabled={me.data.account.mfaEnabled} key={`mfa-${me.data.account.id}`} />}
      {me.isPending ? <Loading label={t("shell.loading")} /> : null}
      {me.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void me.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.security.loadFailed.title")}
          variant="error"
        />
      ) : null}
      <SessionsCard />
    </div>
  );
}
