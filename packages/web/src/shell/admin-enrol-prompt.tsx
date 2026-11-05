import { Button } from "@slugbase/ui";
import { Banner, Confirm } from "@slugbase/ui/patterns";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

const SECURITY_PATH = "/settings/account/security";

/** The link to Security, where an account turns on two-factor authentication. */
export function EnrolLink({ children }: { children?: ReactNode }): ReactElement {
  const { t } = useTranslation();
  return (
    <Button render={<Link to={SECURITY_PATH} />} size="sm" variant="outline">
      {children ?? t("admin.mfaRequired.action")}
    </Button>
  );
}

/**
 * The prompt an admin without a second factor gets in place of an action the server refuses to such an admin: it says why and
 * sends the admin to Security to turn it on. Nothing is sent to the server for the action.
 */
export function EnrolFirstDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <Confirm
      cancelLabel={t("admin.mfaRequired.cancel")}
      confirmLabel={t("admin.mfaRequired.action")}
      description={t("admin.mfaRequired.description")}
      onConfirm={() => {
        void router.navigate({ to: SECURITY_PATH });
        onClose();
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("admin.mfaRequired.title")}
    />
  );
}

/** The prompt that sits where a page would let an admin edit and, without a second factor, only lets them read. */
export function EnrolFirstBanner({ title, description }: { title: string; description: string }): ReactElement {
  return <Banner action={<EnrolLink />} description={description} title={title} variant="warning" />;
}
