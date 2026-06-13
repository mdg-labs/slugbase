import { useLoaderData } from "react-router";

import { BillingSettingsPage } from "./components/BillingSettingsPage.js";
import type { BillingSettingsData } from "./billing.types.js";

export { billingSettingsLoader as loader } from "./billing-loader.js";

export default function BillingSettingsRoute() {
  const data = useLoaderData<BillingSettingsData>();
  return <BillingSettingsPage initialData={data} />;
}
