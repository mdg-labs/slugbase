import { Alert, AlertDescription, AlertTitle, Button } from "@slugbase/ui";
import type { ReactElement } from "react";

// The catalogs of the web app (doc 03, D19) arrive with the translation
// layer; until then the one view that shows before any configuration is read
// carries its own English and German text, chosen from the browser language.
const MESSAGES = {
  en: {
    title: "The app could not be loaded",
    description: "The settings of this server could not be read. Reload the page, and tell your administrator if this continues.",
    reload: "Reload",
    requestId: "Request ID",
  },
  de: {
    title: "Die App konnte nicht geladen werden",
    description:
      "Die Einstellungen dieses Servers konnten nicht gelesen werden. Lade die Seite neu und melde es deiner Administration, wenn es weiter auftritt.",
    reload: "Neu laden",
    requestId: "Anfrage-ID",
  },
} as const;

function messagesFor(language: string) {
  return language.toLowerCase().startsWith("de") ? MESSAGES.de : MESSAGES.en;
}

/**
 * The view for a configuration that could not be loaded. It shows the request
 * id at most; nothing of the failure's cause reaches the page.
 */
export function ConfigFailure({ requestId }: { requestId?: string | undefined }): ReactElement {
  const text = messagesFor(globalThis.navigator.language);
  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-4 p-6">
      <Alert variant="error">
        <AlertTitle>{text.title}</AlertTitle>
        <AlertDescription>
          <p>{text.description}</p>
          {requestId === undefined ? null : (
            <p>
              {text.requestId}: <code>{requestId}</code>
            </p>
          )}
        </AlertDescription>
      </Alert>
      <Button
        onClick={() => {
          globalThis.location.reload();
        }}
      >
        {text.reload}
      </Button>
    </main>
  );
}
