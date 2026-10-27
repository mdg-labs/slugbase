import { createFileRoute } from "@tanstack/react-router";
import { ForwardingPage } from "../../forwarding/forwarding-page.tsx";

export const Route = createFileRoute("/_app/forwarding")({
  component: ForwardingPage,
});
