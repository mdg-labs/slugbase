import { initContract } from "@ts-rest/core";

import { authContract } from "./auth.contract.js";
import { healthContract } from "./health.contract.js";

const c = initContract();

export const apiContract = c.router({ ...healthContract, ...authContract });

export { authContract } from "./auth.contract.js";
export { healthContract } from "./health.contract.js";
