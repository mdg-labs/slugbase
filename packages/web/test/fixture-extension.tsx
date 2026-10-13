import type { ReactElement } from "react";
import type { WebExtension } from "../src/index.ts";

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
