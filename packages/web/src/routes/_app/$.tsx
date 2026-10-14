import { createFileRoute } from "@tanstack/react-router";
import { NotFoundPage } from "../../shell/error-pages.tsx";

export const Route = createFileRoute("/_app/$")({
  component: NotFoundPage,
});
