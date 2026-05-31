import { initContract } from "@ts-rest/core";

import { healthContract } from "./health.contract.js";

const c = initContract();

export const apiContract = c.router(healthContract);

export { healthContract } from "./health.contract.js";
