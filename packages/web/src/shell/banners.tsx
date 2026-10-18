import { Banner } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { ResendButton, ResendStatus, useResendVerification } from "../auth/resend-verification.tsx";
import { useConfig } from "../config/config-context.tsx";

/**
 * The persistent banner for an account whose email address is not verified (doc 03 persistent banners). A deployment
 * that requires verification never lets such an account in, so it shows only where verification is optional, and only
 * while the server can send the link; it is gone as soon as the account is verified.
 */
export function EmailUnverifiedBanner(): ReactElement | null {
  const { t } = useTranslation();
  const account = useCachedAccount();
  const { features } = useConfig();
  const resend = useResendVerification();
  if (account === undefined || account.emailVerified || !features.mail) {
    return null;
  }
  return (
    <Banner
      action={<ResendButton email={account.email} resend={resend} />}
      description={
        <>
          <p>{t("shell.emailUnverified.description", { email: account.email })}</p>
          <ResendStatus resend={resend} />
        </>
      }
      title={t("shell.emailUnverified.title")}
      variant="warning"
    />
  );
}
