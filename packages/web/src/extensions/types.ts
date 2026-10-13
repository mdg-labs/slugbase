import type { ComponentType, FunctionComponent, ReactNode } from "react";
import type { SlotName } from "./slot-names.ts";

/** A page an extension adds to the in-app layout. */
export interface WebExtensionRoute {
  /** Absolute path below the app layout, for example `/settings/billing`. Unique among the extensions and the routes of the app. */
  readonly path: string;
  /** The page, rendered in the shell's main area. */
  readonly component: FunctionComponent;
}

/** A link an extension adds to the sidebar, after the app's own. */
export interface WebExtensionNavigationItem {
  /** Absolute path the link goes to, usually one of the extension's routes. */
  readonly to: string;
  /** The text of the link, in the user's language: the extension owns its strings. */
  readonly label: string;
  /** Decorative; the label names the link. */
  readonly icon?: ReactNode;
}

/** The components an extension renders in named slots, at most one per slot. */
export type WebExtensionSlots = { readonly [Name in SlotName]?: ComponentType };

/**
 * What a composition adds to the web app (doc 01 section 7.2). An extension is
 * identified by `id`; everything else it contributes is optional.
 */
export interface WebExtension {
  /** Unique among the extensions of one app. */
  readonly id: string;
  /** Pages added to the in-app layout. */
  readonly routes?: readonly WebExtensionRoute[];
  /** Sidebar links, listed after the app's own in registration order. */
  readonly navigation?: readonly WebExtensionNavigationItem[];
  /** Components for the named slots. */
  readonly slots?: WebExtensionSlots;
}
