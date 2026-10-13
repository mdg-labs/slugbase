import { createFileRoute } from "@tanstack/react-router";
import { ForbiddenPage } from "../../shell/error-pages.tsx";

export const Route = createFileRoute("/_app/403")({
  component: ForbiddenPage,
});
