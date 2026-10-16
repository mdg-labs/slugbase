import { Button } from "@slugbase/ui";
import type { ReactElement } from "react";
import { navigateTo } from "./navigate.ts";
import { oidcStartPath, type OidcIntent, type OidcProvider } from "./oidc.ts";

/**
 * One button per provider, each a top-level navigation to the start of the handshake. The provider's name is
 * text: it comes from the server's configuration and is never markup.
 */
export function ProviderButtons({
  providers,
  intent,
  returnTo,
  label,
}: {
  providers: readonly OidcProvider[];
  intent: OidcIntent;
  returnTo: string;
  label: (name: string) => string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          className="w-full"
          key={provider.slug}
          onClick={() => {
            navigateTo(oidcStartPath(provider.slug, intent, returnTo));
          }}
          variant="outline"
        >
          {label(provider.name)}
        </Button>
      ))}
    </div>
  );
}
