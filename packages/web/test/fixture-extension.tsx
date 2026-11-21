import { useEffect, useState, type ReactElement } from "react";
import { ApiProblemError, Slot, useApiClient, type WebExtension } from "../src/index.ts";

export function FixtureFooter(): ReactElement {
  return <p>Fixture usage meter</p>;
}

export function FixtureBanner(): ReactElement {
  return <p>Fixture limit banner</p>;
}

export function FixtureDashboardTop(): ReactElement {
  return <p>Fixture dashboard notice</p>;
}

function FixtureBilling(): ReactElement {
  return <h1>Fixture billing page</h1>;
}

/** An extension that fills `sidebar.footer`, adds the page `/settings/billing` and a navigation item for it. */
export const fixtureExtension: WebExtension = {
  id: "fixture",
  routes: [{ path: "/settings/billing", component: FixtureBilling }],
  navigation: [{ to: "/settings/billing", label: "Plan & billing" }],
  slots: { "sidebar.footer": FixtureFooter },
};

export function secondFooter(text: string): WebExtension {
  return { id: `second-${text}`, slots: { "sidebar.footer": () => <p>{text}</p> } };
}

export const VERSION_PAGE_PATH = "/status";

/** What the page of `versionPageExtension` shows for the answer of `GET /version`: the product name, or the code of the problem. */
function VersionPage(): ReactElement {
  const api = useApiClient();
  const [shown, setShown] = useState("loading");
  useEffect(() => {
    api
      .GET("/version")
      .then(({ data }) => {
        setShown(data === undefined ? "no document" : `${data.name} ${data.version}`);
      })
      .catch((error: unknown) => {
        setShown(error instanceof ApiProblemError ? `problem ${error.code} ${String(error.status)} ${error.requestId}` : "failed");
      });
  }, [api]);
  return (
    <section aria-label="Status page">
      <h1>Status page</h1>
      <p>{shown}</p>
      <Slot name="entitlement.upgradeAction" />
      <Slot name="noWorkspace.footer" />
    </section>
  );
}

/** An extension whose page reads `GET /version` through `useApiClient()` and renders two slots with `Slot`. */
export const versionPageExtension: WebExtension = {
  id: "status",
  routes: [{ path: VERSION_PAGE_PATH, component: VersionPage }],
};

/** An extension that only fills `entitlement.upgradeAction`, for the page of `versionPageExtension` to render. */
export const upgradeActionExtension: WebExtension = {
  id: "upgrade",
  slots: { "entitlement.upgradeAction": () => <a href="/upgrade">Upgrade now</a> },
};
