import "./zod-jitless.ts";
export { createWebApp, type CreateWebAppOptions } from "./create-web-app.tsx";
export { ApiProblemError, type ApiClient, type ApiProblemCode } from "./api/client.ts";
export { useApiClient } from "./api/use-api-client.ts";
export { useConfig, type ApiConfig } from "./config/config-context.tsx";
export {
  SLOT_NAMES,
  Slot,
  useSlotFilled,
  type SlotName,
  type WebExtension,
  type WebExtensionNavigationItem,
  type WebExtensionRoute,
  type WebExtensionSlots,
  type WebRegistrationAcknowledgement,
} from "./extensions/index.ts";
