import {
  resolveDefaultOpenApiOutputPath,
  writeOpenApiDocument,
} from "../openapi/write-openapi.js";

writeOpenApiDocument(resolveDefaultOpenApiOutputPath());
