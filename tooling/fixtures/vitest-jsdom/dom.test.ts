import { expect, test } from "vitest";

test("unit tests get a DOM", () => {
  expect(typeof document).toBe("object");
});
