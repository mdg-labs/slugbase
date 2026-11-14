import { Button } from "@slugbase/ui";
import type { ReactElement } from "react";
import { useAcknowledgementChecks, type AcknowledgementChecks, type AcknowledgementEntries } from "./acknowledgement-checks.tsx";
import { navigateTo } from "./navigate.ts";
import { oidcInvitationStartPath, oidcStartPath, type OidcIntent, type OidcProvider } from "./oidc.ts";

/** What the handshake is for: a sign-in, link or re-authentication that comes back to a page, or the acceptance of an invitation. */
type Purpose =
  | { readonly intent: OidcIntent; readonly returnTo: string; readonly invitation?: undefined }
  | { readonly invitation: string; readonly intent?: undefined; readonly returnTo?: undefined };

interface ProviderButtonsProps {
  readonly providers: readonly OidcProvider[];
  readonly label: (name: string) => string;
  /**
   * The checks of a page that already shows the acknowledgement checkboxes (the invitation's sign-up form): the buttons are
   * gated by them and render none of their own, so the page holds one set. Left out, the buttons keep their own.
   */
  readonly acknowledgements?: AcknowledgementChecks;
}

/** The list of buttons: `onPick` gets the slug of the provider the person chose. */
function ProviderList({ providers, label, onPick }: ProviderButtonsProps & { readonly onPick: (slug: string) => void }): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          className="w-full"
          key={provider.slug}
          onClick={() => {
            onPick(provider.slug);
          }}
          variant="outline"
        >
          {label(provider.name)}
        </Button>
      ))}
    </div>
  );
}

/**
 * A sign-in or an invitation may create an account, so the acknowledgements the app's extensions declare are required
 * checkboxes above the buttons, as on the registration form (doc 03 sections 1.2 and 1.5): while one is unticked no start
 * is made, each unticked box is marked and the first takes the focus, and the ticked ones travel with the start.
 */
function AcknowledgingProviderButtons({
  providers,
  label,
  acknowledgements,
  showFields,
  ...purpose
}: Omit<ProviderButtonsProps, "acknowledgements"> & Purpose & { readonly acknowledgements: AcknowledgementChecks; readonly showFields: boolean }): ReactElement {
  const startPath = (slug: string, acknowledged: AcknowledgementEntries | undefined): string =>
    purpose.invitation === undefined ? oidcStartPath(slug, purpose.intent, purpose.returnTo, acknowledged) : oidcInvitationStartPath(slug, purpose.invitation, acknowledged);
  const list = (
    <ProviderList
      label={label}
      onPick={(slug) => {
        const focusFirstUnticked = acknowledgements.check();
        if (focusFirstUnticked !== undefined) {
          focusFirstUnticked();
          return;
        }
        navigateTo(startPath(slug, acknowledgements.entries()));
      }}
      providers={providers}
    />
  );
  return !showFields || acknowledgements.fields === null ? (
    list
  ) : (
    <div className="flex flex-col gap-4">
      {acknowledgements.fields}
      {list}
    </div>
  );
}

/** The buttons with checkboxes of their own, for a page that has none. */
function OwnCheckProviderButtons(props: Omit<ProviderButtonsProps, "acknowledgements"> & Purpose): ReactElement {
  return <AcknowledgingProviderButtons {...props} acknowledgements={useAcknowledgementChecks()} showFields />;
}

/**
 * One button per provider, each a top-level navigation to the start of the handshake. The provider's name is
 * text: it comes from the server's configuration and is never markup. A link or a re-authentication creates no account
 * and asks for no acknowledgement.
 */
export function ProviderButtons({ providers, label, acknowledgements, ...purpose }: ProviderButtonsProps & Purpose): ReactElement {
  if (purpose.invitation !== undefined || purpose.intent === "login") {
    return acknowledgements === undefined ? (
      <OwnCheckProviderButtons label={label} providers={providers} {...purpose} />
    ) : (
      <AcknowledgingProviderButtons acknowledgements={acknowledgements} label={label} providers={providers} showFields={false} {...purpose} />
    );
  }
  return (
    <ProviderList
      label={label}
      onPick={(slug) => {
        navigateTo(oidcStartPath(slug, purpose.intent, purpose.returnTo));
      }}
      providers={providers}
    />
  );
}
