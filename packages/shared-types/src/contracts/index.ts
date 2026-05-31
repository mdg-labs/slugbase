import { initContract } from "@ts-rest/core";

import { apiTokenContract } from "./api-token.contract.js";
import { authContract } from "./auth.contract.js";
import { bookmarksContract } from "./bookmarks.contract.js";
import { healthContract } from "./health.contract.js";
import { invitationContract } from "./invitation.contract.js";
import { mfaContract } from "./mfa.contract.js";
import { registrationContract } from "./registration.contract.js";
import { setupContract } from "./setup.contract.js";
import { workspaceContract } from "./workspace.contract.js";

const c = initContract();

export const apiContract = c.router({
  ...healthContract,
  ...authContract,
  ...mfaContract,
  ...apiTokenContract,
  ...bookmarksContract,
  ...workspaceContract,
  ...registrationContract,
  ...setupContract,
  ...invitationContract,
});

export { apiTokenContract } from "./api-token.contract.js";
export { bookmarksContract } from "./bookmarks.contract.js";
export { authContract } from "./auth.contract.js";
export { healthContract } from "./health.contract.js";
export { invitationContract } from "./invitation.contract.js";
export { mfaContract } from "./mfa.contract.js";
export { registrationContract } from "./registration.contract.js";
export { setupContract } from "./setup.contract.js";
export { workspaceContract } from "./workspace.contract.js";
