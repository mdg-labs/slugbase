import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

function Menu({ onSelect }: { onSelect: () => void }): React.ReactElement {
  return <AccountMenu items={[{ id: "sign-out", label: "Sign out", onSelect }]} label="Account" />;
}

beforeEach(() => {
  stubBrowserApis();
});

describe("AccountMenu", () => {
  it("opens from the account button and runs the chosen item", async () => {
    const onSelect = vi.fn<() => void>();
    render(<Menu onSelect={onSelect} />);
    expect(screen.queryByRole("menuitem")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Account" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("is free of accessibility violations closed and open", async () => {
    const { container } = render(<Menu onSelect={() => undefined} />);
    await expectNoViolations(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Account" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    await expectNoViolations(document.body);
  });
});
