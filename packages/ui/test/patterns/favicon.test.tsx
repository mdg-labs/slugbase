import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { avatarColour } from "../../src/patterns/account-avatar.tsx";
import { Favicon } from "../../src/patterns/favicon.tsx";
import { expectNoViolations } from "../support.tsx";

function frame(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-slot='favicon']");
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

function image(container: HTMLElement): HTMLImageElement {
  const element = container.querySelector("img");
  expect(element).not.toBeNull();
  return element as HTMLImageElement;
}

function loadedWith(img: HTMLImageElement, naturalWidth: number): void {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: naturalWidth });
  fireEvent.load(img);
}

describe("Favicon", () => {
  it("asks the app's own proxy for the icon, decoratively and lazily, at the size it was given", () => {
    const { container } = render(
      <>
        <Favicon host="example.com" />
        <Favicon host="example.org" size={32} />
      </>,
    );

    const [small, large] = Array.from(container.querySelectorAll("img"));
    expect(small?.getAttribute("src")).toBe("/api/v1/favicons/example.com");
    expect(small?.getAttribute("alt")).toBe("");
    expect(small?.getAttribute("loading")).toBe("lazy");
    expect(small?.getAttribute("width")).toBe("16");
    expect(large?.getAttribute("src")).toBe("/api/v1/favicons/example.org");
    expect(large?.getAttribute("width")).toBe("32");
    expect(container.querySelectorAll("[data-slot='favicon']")[0]?.className).toContain("size-4");
    expect(container.querySelectorAll("[data-slot='favicon']")[1]?.className).toContain("size-8");
  });

  it("shows the monogram of the host, without www, on the colour of the host while the icon loads", () => {
    const { container } = render(<Favicon host="www.Example.com" />);

    const element = frame(container);
    expect(element.getAttribute("data-state")).toBe("loading");
    expect(element.textContent).toBe("e");
    expect(element.getAttribute("aria-hidden")).toBe("true");
    expect(element.getAttribute("translate")).toBe("no");
    expect(element.className).toContain(avatarColour("www.example.com"));
    expect(image(container).className).toContain("opacity-0");
  });

  it("gives a host the same colour every time and a different host a colour of the set", () => {
    const colours = new Set(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example", "g.example", "h.example"].map((host) => avatarColour(host)));
    expect(colours.size).toBeGreaterThan(1);
    const first = render(<Favicon host="docs.example.org" />);
    const second = render(<Favicon host="docs.example.org" />);
    expect(frame(first.container).className).toBe(frame(second.container).className);
  });

  it("shows the icon in place of the monogram once a stored icon has loaded", () => {
    const { container } = render(<Favicon host="example.com" size={32} />);

    loadedWith(image(container), 64);

    const element = frame(container);
    expect(element.getAttribute("data-state")).toBe("loaded");
    expect(element.textContent).toBe("");
    expect(element.className).toContain("bg-muted");
    expect(image(container).className).not.toContain("opacity-0");
  });

  it("keeps the monogram for the one-pixel placeholder the server answers for a host without an icon", () => {
    const { container } = render(<Favicon host="example.com" />);

    loadedWith(image(container), 1);

    expect(frame(container).getAttribute("data-state")).toBe("missing");
    expect(frame(container).textContent).toBe("e");
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps the monogram when the request fails", () => {
    const { container } = render(<Favicon host="example.com" />);

    fireEvent.error(image(container));

    expect(frame(container).getAttribute("data-state")).toBe("missing");
    expect(frame(container).textContent).toBe("e");
    expect(container.querySelector("img")).toBeNull();
  });

  it("starts over for another host", () => {
    const { container, rerender } = render(<Favicon host="example.com" />);
    fireEvent.error(image(container));

    rerender(<Favicon host="example.org" />);

    expect(frame(container).getAttribute("data-state")).toBe("loading");
    expect(image(container).getAttribute("src")).toBe("/api/v1/favicons/example.org");
  });

  it("keeps its box the same size in every state", () => {
    const { container } = render(<Favicon host="example.com" size={32} />);
    const before = frame(container).className.split(" ").filter((name) => name.startsWith("size-"));

    loadedWith(image(container), 64);

    expect(frame(container).className.split(" ").filter((name) => name.startsWith("size-"))).toEqual(before);
  });

  it.each(["", "evil.example/x", "//evil.example", "evil.example:8080", "user@evil.example", "..", "-a.example", "a..example", "a.example?x=1", "a b.example", "[::1]", `${"a".repeat(64)}.example`])(
    "asks for no icon and shows only a monogram for %j",
    (host) => {
      const { container } = render(<Favicon host={host} />);

      expect(container.querySelector("img")).toBeNull();
      expect(frame(container).getAttribute("data-state")).toBe("missing");
    },
  );

  it("never points the picture at another origin", () => {
    const { container } = render(
      <>
        {["example.com", "xn--bcher-kva.example", "EXAMPLE.org", "a.b.c.example"].map((host) => (
          <Favicon host={host} key={host} />
        ))}
      </>,
    );

    for (const img of Array.from(container.querySelectorAll("img"))) {
      expect(new URL(img.src, window.location.href).origin).toBe(window.location.origin);
      expect(img.getAttribute("src")).toMatch(/^\/api\/v1\/favicons\/[a-z0-9.-]+$/);
    }
  });

  it("is free of accessibility violations", async () => {
    const { container } = render(<Favicon host="example.com" />);

    await expectNoViolations(container);
  });
});
