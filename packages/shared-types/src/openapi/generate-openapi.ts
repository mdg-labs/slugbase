import { generateOpenApi } from "@ts-rest/open-api";

import { apiContract } from "../contracts/index.js";

export const OPENAPI_OUTPUT_PATH = "dist/openapi.json";

export function buildOpenApiDocument(): ReturnType<typeof generateOpenApi> {
  return generateOpenApi(apiContract, {
    info: {
      title: "SlugBase API",
      version: "0.0.0",
      description: "SlugBase REST API",
    },
    openapi: "3.1.0",
  });
}
