import { getClientApiOrigin } from "../../lib/client-api-path.js";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import {
  AuthButton,
  AuthHeading,
  AuthInput,
  AuthShell as AuthShellBase,
  ErrorBanner,
  KeyFieldIcon,
  LockFieldIcon,
  MailFieldIcon,
  SuccessBanner,
  SsoSection as SsoSectionBase,
  UserFieldIcon,
  type OidcProviderItem,
  type SsoSectionProps,
} from "@slugbase/ui";

export {
  AuthButton,
  AuthHeading,
  AuthInput,
  ErrorBanner,
  KeyFieldIcon,
  LockFieldIcon,
  MailFieldIcon,
  SuccessBanner,
  UserFieldIcon,
  type OidcProviderItem,
};

type AuthShellWrapperProps = {
  children: ReactNode;
  showSlugRows?: boolean;
};

/** i18n-wired auth layout - primitives live in @slugbase/ui. */
export function AuthShell({ children, showSlugRows = true }: AuthShellWrapperProps) {
  const { t } = useTranslation();

  return (
    <AuthShellBase
      showSlugRows={showSlugRows}
      brand={{
        headline: t("auth.brand.headline"),
        subline: t("auth.brand.subline"),
        footer: t("auth.brand.footer"),
      }}
    >
      {children}
    </AuthShellBase>
  );
}

/** SSO section with API base URL from the web app environment. */
export function SsoSection(props: Omit<SsoSectionProps, "apiBaseUrl">) {
  return (
    <SsoSectionBase apiBaseUrl={getClientApiOrigin()} {...props} />
  );
}
