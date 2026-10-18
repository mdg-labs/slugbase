import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ResendButton, ResendStatus, useResendVerification } from "./resend-verification.tsx";

/** What follows a registration: where the verification link went, and the way to ask for it again. */
export function CheckEmail({ email }: { email: string }): ReactElement {
  const { t } = useTranslation();
  const resend = useResendVerification();
  return (
    <div className="flex flex-col gap-4">
      <p>{t("register.checkEmail.description", { email })}</p>
      <p className="text-muted-foreground text-sm">{t("register.checkEmail.hint")}</p>
      <ResendStatus resend={resend} />
      <div>
        <ResendButton email={email} resend={resend} />
      </div>
    </div>
  );
}
