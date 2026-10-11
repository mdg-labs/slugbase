import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AtLeastOne,
  ComponentTypes,
  OperationResponses,
  OperationTypes,
  paths,
} from "../src/index.ts";
import type {
  components as generatedComponents,
  operations as generatedOperations,
} from "../generated/schema.d.ts";

describe("types the package entry refers to", () => {
  it("exports the generated operations interface as OperationTypes", () => {
    expectTypeOf<OperationTypes>().toEqualTypeOf<generatedOperations>();
    expectTypeOf<paths["/api/config"]["get"]>().toEqualTypeOf<OperationTypes["getApiConfig"]>();
    expect(true).toBe(true);
  });

  it("exports the generated components interface as ComponentTypes", () => {
    expectTypeOf<ComponentTypes>().toEqualTypeOf<generatedComponents>();
    expectTypeOf<ComponentTypes["schemas"]["Problem"]>().not.toBeAny();
    expectTypeOf<
      paths["/api/config"]["get"]["responses"][200]["content"]["application/json"]
    >().toEqualTypeOf<ComponentTypes["schemas"]["ApiConfig"]>();
    expect(true).toBe(true);
  });

  it("exports AtLeastOne, the type OperationResponses is built from", () => {
    type OneOf = AtLeastOne<{ a: string; b: number }>;
    expectTypeOf<{ a: string }>().toExtend<OneOf>();
    expectTypeOf<{ b: number }>().toExtend<OneOf>();
    expectTypeOf<{ a: string; b: number }>().toExtend<OneOf>();
    expectTypeOf<Record<string, never>>().not.toExtend<OneOf>();
    expectTypeOf<OperationResponses>().not.toBeAny();
    expect(true).toBe(true);
  });
});
