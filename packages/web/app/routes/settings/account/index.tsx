import { useLoaderData } from "react-router";

import type { AccountSettingsLoaderData } from "./account-loader.js";
import { AccountSettingsPage } from "./components/AccountSettingsPage.js";

export { accountSettingsLoader as loader } from "./account-loader.js";

export default function AccountSettingsRoute() {
  const { account, tokens, aiSuggestionsAvailable } = useLoaderData<AccountSettingsLoaderData>();
  return (
    <AccountSettingsPage
      initialAccount={account}
      initialTokens={tokens}
      aiSuggestionsAvailable={aiSuggestionsAvailable}
    />
  );
}
