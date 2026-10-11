import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { paths } from "../src/index.ts";
import type { ApiConfigSchema } from "../src/operations/meta.ts";
import type { paths as generatedPaths } from "../generated/schema.d.ts";

type GeneratedApiConfig = paths["/api/config"]["get"]["responses"]["200"]["content"]["application/json"];

describe("generated client types", () => {
  it("types GET /api/config exactly as the ApiConfig schema infers", () => {
    expectTypeOf<GeneratedApiConfig>().toEqualTypeOf<z.infer<typeof ApiConfigSchema>>();
    expect(true).toBe(true);
  });

  it("exports the paths type of the generated file from the package entry", () => {
    expectTypeOf<paths>().toEqualTypeOf<generatedPaths>();
    expect(true).toBe(true);
  });
});
