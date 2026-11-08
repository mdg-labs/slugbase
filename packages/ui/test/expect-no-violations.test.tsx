import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoViolations } from "./support.tsx";

describe("expectNoViolations", () => {
  it("waits for an axe run an earlier test left behind instead of failing with 'Axe is already running'", async () => {
    const { container } = render(<button type="button">Pin</button>);
    // A test that times out while this awaits is abandoned by vitest, and the axe run it started carries on.
    const abandoned = expectNoViolations(container);

    await expect(expectNoViolations(container)).resolves.toBeUndefined();
    await abandoned;
  });

  it("still names the violations it finds after waiting for a run left behind", async () => {
    const { container } = render(<img src="/a.png" />);
    const abandoned = expectNoViolations(container).catch(() => undefined);

    await expect(expectNoViolations(container)).rejects.toMatchObject({ actual: [expect.stringContaining("image-alt")] });
    await abandoned;
  });
});
