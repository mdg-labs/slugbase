import { createFileRoute } from "@tanstack/react-router";
import { SettingsLayout } from "../../shell/settings-layout.tsx";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});
