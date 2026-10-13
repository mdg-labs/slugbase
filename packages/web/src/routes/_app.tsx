import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "../shell/app-layout.tsx";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});
