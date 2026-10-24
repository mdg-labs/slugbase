import "./zod-jitless.ts";
export { createWebApp, type CreateWebAppOptions } from "./create-web-app.tsx";
export { ApiProblemError, type ApiProblemCode } from "./api/client.ts";
export { useConfig, type ApiConfig } from "./config/config-context.tsx";
export {
  SLOT_NAMES,
  type SlotName,
  type WebExtension,
  type WebExtensionNavigationItem,
  type WebExtensionRoute,
  type WebExtensionSlots,
} from "./extensions/index.ts";
