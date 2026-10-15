import { describe, expect, it } from "vitest";
import { renderQrSvg } from "../../src/auth/qr.ts";

const URI = "otpauth://totp/SlugBase:ada%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=SlugBase&algorithm=SHA1&digits=6&period=30";

describe("renderQrSvg", () => {
  it("is a self-contained SVG document of shapes only", () => {
    const svg = renderQrSvg(URI);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/viewBox="0 0 (\d+) \1"/);
    expect(svg).not.toMatch(/<script|<image|<foreignObject|href=|on\w+=/i);
    expect(svg).not.toContain(URI);
  });

  it("draws the same code for the same text and another for another text", () => {
    expect(renderQrSvg(URI)).toBe(renderQrSvg(URI));
    expect(renderQrSvg(URI)).not.toBe(renderQrSvg(`${URI}&x=1`));
  });

  it("makes a larger symbol for a longer text", () => {
    const size = (svg: string) => Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1]);
    expect(size(renderQrSvg(`${URI}${"x".repeat(120)}`))).toBeGreaterThan(size(renderQrSvg("a")));
  });
});
