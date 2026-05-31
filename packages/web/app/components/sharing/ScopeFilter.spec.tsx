import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { ScopeFilter } from "./ScopeFilter.js";

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
    t: (key: string) => {
      const messages = staticMessages.en as Record<string, string>;
      return messages[key] ?? key;
    },
  }),
}));

describe("ScopeFilter", () => {
  afterEach(() => {
    cleanup();
  });

  it("calls onChange with shared-with-me when that scope is selected", async () => {
    const onChange = vi.fn();
    const view = render(<ScopeFilter value="all" onChange={onChange} />);

    fireEvent.click(view.getByTestId("sharing-scope-filter-trigger"));
    fireEvent.click(view.getByTestId("sharing-scope-option-shared-with-me"));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("shared-with-me");
    });
  });
});
