import { Alert, AlertDescription, AlertTitle, Button } from "@slugbase/ui";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/**
 * The view for a configuration that could not be loaded. It shows the request
 * id at most; nothing of the failure's cause reaches the page.
 */
export function ConfigFailure({ requestId }: { requestId?: string | undefined }): ReactElement {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-4 p-6">
      <Alert variant="error">
        <AlertTitle>{t("configFailure.title")}</AlertTitle>
        <AlertDescription>
          <p>{t("configFailure.description")}</p>
          {requestId === undefined ? null : (
            <p>
              {t("configFailure.requestId")}: <code>{requestId}</code>
            </p>
          )}
        </AlertDescription>
      </Alert>
      <Button
        onClick={() => {
          globalThis.location.reload();
        }}
      >
        {t("configFailure.reload")}
      </Button>
    </main>
  );
}
