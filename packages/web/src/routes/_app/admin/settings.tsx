import { createFileRoute } from "@tanstack/react-router";

// The page arrives with its own item; until then the route holds the navigation entry inside the admin layout.
export const Route = createFileRoute("/_app/admin/settings")({
  component: () => null,
});
