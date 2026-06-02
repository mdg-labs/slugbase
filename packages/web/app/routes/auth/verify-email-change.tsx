import { useTranslate } from "@tolgee/react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { AuthHeading, AuthShell, ErrorBanner, SuccessBanner } from "./AuthShell.js";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

type LoaderData =
  | { success: true }
  | { success: false; error: string };

export async function loader({ request }: LoaderFunctionArgs): Promise<LoaderData> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return { success: false, error: "auth.verify_email_change.error_invalid" };
  }

  const cookie = request.headers.get("Cookie") ?? "";
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE_URL()}/auth/verify-email-change?token=${encodeURIComponent(token)}`,
      { headers: cookie ? { Cookie: cookie } : {} },
    );
  } catch {
    return { success: false, error: "auth.verify_email_change.error_generic" };
  }

  if (res.ok) {
    return { success: true };
  }

  if (res.status === 422) {
    return { success: false, error: "auth.verify_email_change.error_expired" };
  }

  return { success: false, error: "auth.verify_email_change.error_invalid" };
}

export default function VerifyEmailChangeRoute() {
  const { t } = useTranslate();
  const data = useLoaderData<typeof loader>();

  return (
    <AuthShell>
      <AuthHeading title={t("auth.verify_email_change.title")} />

      {data.success ? (
        <>
          <SuccessBanner message={t("auth.verify_email_change.success_message")} />
          <Link
            to="/settings/account?section=profile"
            className="mt-sp-6 inline-flex w-full items-center justify-center rounded-md bg-accent px-sp-5 py-sp-4 font-medium text-accent-fg hover:opacity-90"
            style={{ fontSize: "var(--text-body)" }}
          >
            {t("auth.verify_email_change.back_to_settings")}
          </Link>
        </>
      ) : (
        <>
          <ErrorBanner message={t(data.error)} />
          <Link to="/settings/account?section=profile" className="mt-sp-6 inline-block text-accent-text hover:underline">
            {t("auth.verify_email_change.back_to_settings")}
          </Link>
        </>
      )}
    </AuthShell>
  );
}
