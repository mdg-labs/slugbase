import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { getSessionUser } from "../../../lib/session-client.js";
import { listApiTokens, loadAccountSettings } from "./account-api.js";
import type { AccountSettingsData, ApiTokenSummary } from "./account.types.js";

export interface AccountSettingsLoaderData {
  account: AccountSettingsData;
  tokens: ApiTokenSummary[];
}

export async function accountSettingsLoader({
  request,
}: LoaderFunctionArgs): Promise<AccountSettingsLoaderData> {
  const user = await getSessionUser(request);
  if (!user) {
    return redirect("/login") as never;
  }

  const account = await loadAccountSettings(request);
  const tokens = await listApiTokens(request);

  if (!account) {
    throw new Error("Failed to load account settings");
  }

  return { account, tokens };
}
