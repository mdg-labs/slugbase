import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { getSessionUser } from "../../../lib/session-client.js";
import { loadBillingSettingsData } from "./billing-api.js";
import type { BillingSettingsData } from "./billing.types.js";

export async function billingSettingsLoader({
  request,
}: LoaderFunctionArgs): Promise<BillingSettingsData> {
  const user = await getSessionUser(request);
  if (!user) {
    return redirect("/login") as never;
  }

  const url = new URL(request.url);
  const returnUrl = `${url.origin}${url.pathname}`;

  const data = await loadBillingSettingsData(request, user.id, returnUrl);
  if (!data) {
    throw new Error("Failed to load billing settings data");
  }

  return data;
}
