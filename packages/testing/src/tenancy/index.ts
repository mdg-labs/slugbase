export { runApiMatrix } from "./api-mode.js";
export type { ApiCall, ApiMatrixOptions, ApiMatrixReport, ApiResponse, RequestFunction } from "./api-mode.js";
export { runRlsOnlyMatrix } from "./rls-mode.js";
export type { RlsOnlyOptions, RlsOnlyReport } from "./rls-mode.js";
export { IDENTIFIER_KINDS, identifiersOf, namesOf, principalsOf } from "./fixture.js";
export type {
  FixtureIdentifier,
  FixturePrincipal,
  IdentifierKind,
  PrincipalRole,
  TenantFixture,
  WorkspaceFixture,
} from "./fixture.js";
export { kindOfParameter, PATH_PARAMETER_MAPPING, REPOSITORY_SAMPLES } from "./mapping.js";
export type { PathParameterMapping, RepositorySample, RepositorySamples } from "./mapping.js";
export { OPERATION_KINDS, classifyOperations, describeOperation, loadOpenApiDocument } from "./openapi.js";
export type {
  Classification,
  ClassificationSummary,
  ClassifiedOperation,
  IdentifierInput,
  InputLocation,
  OperationKind,
} from "./openapi.js";
export { MatrixFailureError, assertMatrixPassed, formatFailures } from "./report.js";
export type { MatrixFailure, MatrixMode } from "./report.js";
export { PROBE_SAMPLE, PROBE_WORKSPACE_A, PROBE_WORKSPACE_B, createProbe } from "./probe.js";
export type { Probe, ProbeOptions, ProbePolicy } from "./probe.js";
