import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { staysWhileParams, unsavedChanges, useUnsavedForm, type FormAddress, type FormStays } from "../../src/patterns/index.ts";

const HERE: FormAddress = { pathname: "/tags", search: "" };
const ELSEWHERE: FormAddress = { pathname: "/folders", search: "" };

function Form({
  dirty,
  stays,
  onRelease,
}: {
  readonly dirty: boolean;
  readonly stays?: FormStays;
  readonly onRelease?: { current: (() => void) | undefined };
}): ReactElement {
  const { release } = useUnsavedForm(dirty, stays);
  if (onRelease !== undefined) {
    onRelease.current = release;
  }
  return <form />;
}

function holds(next: FormAddress = ELSEWHERE, current: FormAddress = HERE): boolean {
  return unsavedChanges.holds({ current, next });
}

afterEach(() => {
  expect(unsavedChanges.hasUnsaved()).toBe(false);
});

describe("useUnsavedForm", () => {
  it("holds a route change for a form with edits and not for one without", () => {
    const view = render(<Form dirty={false} />);
    expect(holds()).toBe(false);

    view.rerender(<Form dirty />);
    expect(holds()).toBe(true);

    view.rerender(<Form dirty={false} />);
    expect(holds()).toBe(false);
    view.unmount();
  });

  it("lets a change through that keeps the form on its page", () => {
    const view = render(<Form dirty />);

    expect(holds({ pathname: "/tags", search: "?tag=1" })).toBe(false);
    expect(holds({ pathname: "/tags/", search: "" })).toBe(true);
    view.unmount();
  });

  it("holds a change that drops or changes the parameter that opens the form, on any path", () => {
    const view = render(<Form dirty stays={staysWhileParams("new", "bookmark")} />);
    const open: FormAddress = { pathname: "/bookmarks", search: "?new=1" };

    expect(holds({ pathname: "/folders", search: "?new=1" }, open)).toBe(false);
    expect(holds({ pathname: "/bookmarks", search: "?new=1&url=x" }, open)).toBe(false);
    expect(holds({ pathname: "/bookmarks", search: "" }, open)).toBe(true);
    expect(holds({ pathname: "/bookmarks", search: "?bookmark=7" }, open)).toBe(true);
    view.unmount();
  });

  it("holds while any of several forms holds edits that the change takes away", () => {
    const view = render(
      <>
        <Form dirty={false} />
        <Form dirty />
      </>,
    );
    expect(holds()).toBe(true);

    view.rerender(
      <>
        <Form dirty={false} />
        <Form dirty={false} />
      </>,
    );
    expect(holds()).toBe(false);
    view.unmount();
  });

  it("stops holding for a form that unmounts", () => {
    const view = render(<Form dirty />);
    expect(holds()).toBe(true);

    view.unmount();

    expect(holds()).toBe(false);
  });

  it("stops holding once the form releases its edits, and holds again when it changes after that", () => {
    const release: { current: (() => void) | undefined } = { current: undefined };
    const view = render(<Form dirty onRelease={release} />);

    act(() => {
      release.current?.();
    });
    expect(holds()).toBe(false);

    view.rerender(<Form dirty={false} onRelease={release} />);
    view.rerender(<Form dirty onRelease={release} />);
    expect(holds()).toBe(true);
    view.unmount();
  });

  it("lets the part that holds a route release every form at once", () => {
    const view = render(
      <>
        <Form dirty />
        <Form dirty />
      </>,
    );

    unsavedChanges.releaseAll();

    expect(unsavedChanges.hasUnsaved()).toBe(false);
    expect(holds()).toBe(false);
    view.unmount();
  });

  it("tells a subscriber when a form gains or loses an edit, and not after it stops listening", () => {
    const heard: boolean[] = [];
    const stop = unsavedChanges.subscribe(() => {
      heard.push(unsavedChanges.hasUnsaved());
    });

    const view = render(<Form dirty />);
    view.rerender(<Form dirty={false} />);
    stop();
    view.rerender(<Form dirty />);
    view.unmount();

    expect(heard).toEqual([true, false]);
  });
});
