import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoadMore } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

describe("LoadMore", () => {
  it("shows the count line and loads the next results on demand", async () => {
    const onLoadMore = vi.fn<() => void>();
    const { container } = render(<LoadMore count="Showing 48 of 1,234" hasMore loadMoreLabel="Load more" onLoadMore={onLoadMore} />);

    expect(screen.getByRole("status").textContent).toBe("Showing 48 of 1,234");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    await expectNoViolations(container);
  });

  it("offers no button once everything is shown", () => {
    render(<LoadMore count="Showing 3 of 3" hasMore={false} loadMoreLabel="Load more" onLoadMore={() => undefined} />);

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Showing 3 of 3");
  });

  it("does not run a load while one is under way", () => {
    const onLoadMore = vi.fn<() => void>();
    render(<LoadMore count="Showing 24 of 48" hasMore loading loadMoreLabel="Load more" onLoadMore={onLoadMore} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("lets the size of a load be chosen", async () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(
      <LoadMore
        count="Showing 24 of 100"
        hasMore
        loadMoreLabel="Load more"
        onLoadMore={() => undefined}
        pageSize={{
          label: "Per load",
          value: "24",
          options: [
            { value: "24", label: "24" },
            { value: "48", label: "48" },
          ],
          onValueChange,
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Per load" }));
      await Promise.resolve();
    });
    await act(async () => {
      const option = await screen.findByRole("option", { name: "48" });
      // Base UI commits a click only after the press began on the item.
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("48");
  });
});
