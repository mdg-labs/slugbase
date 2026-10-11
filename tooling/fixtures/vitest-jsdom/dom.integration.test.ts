import { expect, test } from "vitest";

test("integration tests never get a DOM", () => {
  expect(typeof document).toBe("undefined");
});
