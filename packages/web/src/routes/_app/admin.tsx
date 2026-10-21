import { createFileRoute } from "@tanstack/react-router";
import { AdminLayout } from "../../shell/admin-layout.tsx";

export const Route = createFileRoute("/_app/admin")({
  component: AdminLayout,
});
