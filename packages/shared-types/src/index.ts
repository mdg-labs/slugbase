export { apiContract, healthContract } from "./contracts/index.js";
export {
  HealthResponseSchema,
  VersionResponseSchema,
  type HealthResponse,
  type VersionResponse,
} from "./contracts/health.contract.js";
export {
  buildOpenApiDocument,
  OPENAPI_OUTPUT_PATH,
} from "./openapi/generate-openapi.js";
