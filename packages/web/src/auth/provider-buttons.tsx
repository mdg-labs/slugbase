import { Button } from "@slugbase/ui";
import type { ReactElement } from "react";
import { navigateTo } from "./navigate.ts";
import { oidcInvitationStartPath, oidcStartPath, type OidcIntent, type OidcProvider } from "./oidc.ts";

/** What the handshake is for: a sign-in, link or re-authentication that comes back to a page, or the acceptance of an invitation. */
type Purpose =
  | { readonly intent: OidcIntent; readonly returnTo: string; readonly invitation?: undefined }
  | { readonly invitation: string; readonly intent?: undefined; readonly returnTo?: undefined };

/**
 * One button per provider, each a top-level navigation to the start of the handshake. The provider's name is
 * text: it comes from the server's configuration and is never markup.
 */
export function ProviderButtons({
  providers,
  label,
  ...purpose
}: {
  providers: readonly OidcProvider[];
  label: (name: string) => string;
} & Purpose): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          className="w-full"
          key={provider.slug}
          onClick={() => {
            navigateTo(purpose.invitation === undefined ? oidcStartPath(provider.slug, purpose.intent, purpose.returnTo) : oidcInvitationStartPath(provider.slug, purpose.invitation));
          }}
          variant="outline"
        >
          {label(provider.name)}
        </Button>
      ))}
    </div>
  );
}
