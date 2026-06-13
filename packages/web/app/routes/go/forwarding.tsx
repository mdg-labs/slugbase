import type { LoaderFunctionArgs } from "react-router";

import { ForwardingPage } from "./ForwardingPage.js";
import { loadForwardingData } from "./forwarding-loader.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadForwardingData(request);
  if (!data) {
    throw new Error("Failed to load forwarding preferences");
  }
  return data;
}

export default function ForwardingRoute() {
  return <ForwardingPage />;
}
