import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../../dashboard/home-page.tsx";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});
