import { afterEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";

describe("Zod without eval", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it(
    "builds every contract schema without calling the Function constructor",
    { timeout: HEAVY_TEST_TIMEOUT_MS },
    async () => {
      vi.resetModules();
      const probe = vi.fn();
      const RealFunction = globalThis.Function;
      const Spy = new Proxy(RealFunction, {
        construct(target, args: unknown[], newTarget) {
          probe(args);
          return Reflect.construct(target, args, newTarget) as object;
        },
      });
      vi.stubGlobal("Function", Spy);

      await import("../src/index.ts");

      expect(probe).not.toHaveBeenCalled();
    },
  );
});
