import { initContract } from "@ts-rest/core";

import { aiContract } from "./ai.contract.js";
import { billingContract } from "./billing-api.contract.js";
import { accountContract } from "./account.contract.js";
import { apiTokenContract } from "./api-token.contract.js";
import { authContract } from "./auth.contract.js";
import { bookmarksContract } from "./bookmarks.contract.js";
import { foldersContract } from "./folders.contract.js";
import { healthContract } from "./health.contract.js";
import { importContract } from "./import.contract.js";
import { invitationContract } from "./invitation.contract.js";
import { mfaContract } from "./mfa.contract.js";
import { registrationContract } from "./registration.contract.js";
import { setupContract } from "./setup.contract.js";
import { sharingContract } from "./sharing.contract.js";
import { slugsContract } from "./slugs.contract.js";
import { tagsContract } from "./tags.contract.js";
import { workspaceContract } from "./workspace.contract.js";

const c = initContract();

export const apiContract = c.router({
  ...healthContract,
  ...authContract,
  ...accountContract,
  ...mfaContract,
  ...apiTokenContract,
  ...bookmarksContract,
  ...foldersContract,
  ...tagsContract,
  ...slugsContract,
  ...workspaceContract,
  ...registrationContract,
  ...setupContract,
  ...sharingContract,
  ...invitationContract,
  ...importContract,
  ...billingContract,
  ...aiContract,
});

export { aiContract } from "./ai.contract.js";
export { billingContract } from "./billing-api.contract.js";
export { accountContract } from "./account.contract.js";
export { apiTokenContract } from "./api-token.contract.js";
export { bookmarksContract } from "./bookmarks.contract.js";
export { foldersContract } from "./folders.contract.js";
export { authContract } from "./auth.contract.js";
export { healthContract } from "./health.contract.js";
export { importContract } from "./import.contract.js";
export { invitationContract } from "./invitation.contract.js";
export { mfaContract } from "./mfa.contract.js";
export { registrationContract } from "./registration.contract.js";
export { setupContract } from "./setup.contract.js";
export { sharingContract } from "./sharing.contract.js";
export { slugsContract } from "./slugs.contract.js";
export { tagsContract } from "./tags.contract.js";
export { workspaceContract } from "./workspace.contract.js";
