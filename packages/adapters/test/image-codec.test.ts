import { crc32, deflateSync } from "node:zlib";
import { ICON_MAX_INPUT_PIXELS, ImageRefused, type ImageRefusalCode } from "@slugbase/core";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { SharpImageCodec } from "../src/index.ts";

// The image codec of the favicon fetch (doc 02 section 5.4, doc 10 T6 and T14). The failure scenario: the bytes are a hostile site's. An SVG with a script, an
// HTML page and anything that is not a raster icon are refused before a decoder sees them; a small file that declares enormous dimensions is refused on
// its declared size, before a pixel is allocated; and what the codec returns is always a PNG it encoded itself, at 64 and 32 pixels.

const codec = new SharpImageCodec();
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG whose header declares `width` by `height` 8-bit gray pixels; `rows` is the compressed pixel data, left out for a header with no image behind it. */
function pngDeclaring(width: number, height: number, pixels?: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), ...(pixels === undefined ? [] : [chunk("IDAT", pixels)]), chunk("IEND", Buffer.alloc(0))]);
}

async function refusal(promise: Promise<unknown>): Promise<ImageRefusalCode> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImageRefused);
    return (error as ImageRefused).code;
  }
  throw new Error("the codec accepted the input");
}

async function expectIcon(input: Uint8Array): Promise<void> {
  const icon = await codec.reencodeIcon(input);
  for (const [png, size] of [
    [icon.png64, 64],
    [icon.png32, 32],
  ] as const) {
    expect(Buffer.from(png).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(await sharp(png).metadata()).toMatchObject({ format: "png", width: size, height: size, hasAlpha: true });
  }
}

const square = (width: number, height = width): Sharp => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } });

/** An ICO holding one image of `payload`, declared as `edge` by `edge`. */
function ico(payload: Buffer, edge: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = edge === 256 ? 0 : edge;
  header[7] = edge === 256 ? 0 : edge;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(payload.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, payload]);
}

/** The DIB an ICO entry holds: 32-bit BGRA pixels (bottom-up) of one colour, then the 1-bit AND mask. */
function dib32(edge: number, alpha: number): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(edge, 4);
  header.writeInt32LE(edge * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(edge * edge * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    pixels.set([10, 20, 200, alpha], at);
  }
  return Buffer.concat([header, pixels, Buffer.alloc(Math.floor((edge + 31) / 32) * 4 * edge)]);
}

describe("an icon the codec accepts", () => {
  it.each([
    ["a PNG", async () => square(40).png().toBuffer()],
    ["a JPEG", async () => square(48).jpeg().toBuffer()],
    ["a GIF", async () => square(30).gif().toBuffer()],
    ["a WebP", async () => square(50).webp().toBuffer()],
    ["a non-square PNG", async () => square(100, 30).png().toBuffer()],
    ["an ICO that holds a PNG", async () => ico(await square(32).png().toBuffer(), 32)],
    ["an ICO that holds a 32-bit bitmap", () => Promise.resolve(ico(dib32(16, 255), 16))],
  ])("becomes a 64 px and a 32 px PNG: %s", async (_name, make) => {
    await expectIcon(await make());
  });

  it("encodes the PNGs afresh: the metadata of a JPEG does not reach the output", async () => {
    const jpeg = await square(48).withExif({ IFD0: { Copyright: "secret-copyright-marker" } }).jpeg().toBuffer();
    expect(jpeg.includes(Buffer.from("secret-copyright-marker"))).toBe(true);

    const icon = await codec.reencodeIcon(jpeg);

    expect(Buffer.from(icon.png64).includes(Buffer.from("secret-copyright-marker"))).toBe(false);
    expect((await sharp(icon.png64).metadata()).exif).toBeUndefined();
  });

  it("keeps the transparency of a bitmap whose alpha is set and takes the first frame of an animation", async () => {
    const alphaMean = async (png: Uint8Array): Promise<number> => (await sharp(png).stats()).channels[3]?.mean ?? -1;
    // A 32-bit bitmap whose alpha is all zero and whose mask hides nothing is opaque; one with alpha keeps it.
    expect(await alphaMean((await codec.reencodeIcon(ico(dib32(16, 0), 16))).png64)).toBe(255);
    expect(await alphaMean((await codec.reencodeIcon(ico(dib32(16, 255), 16))).png64)).toBe(255);
    const half = dib32(16, 128);
    expect(await alphaMean((await codec.reencodeIcon(ico(half, 16))).png64)).toBeCloseTo(128, 0);
    const frames = await square(10).gif().toBuffer();
    const twoFrames = await sharp([frames, await square(10).gif().toBuffer()].map((frame) => frame), { join: { animated: true } }).gif().toBuffer();
    await expectIcon(twoFrames);
  });
});

describe("an input the codec refuses", () => {
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(document.cookie)</script><rect width="64" height="64"/></svg>');

  it.each([
    ["an SVG with a script", SVG],
    ["an SVG with an XML prolog", Buffer.concat([Buffer.from('<?xml version="1.0"?>\n'), SVG])],
    ["an SVG after a byte order mark and whitespace", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("  \n"), SVG])],
    ["an HTML page", Buffer.from("<!doctype html><html><script>alert(1)</script></html>")],
    ["a script", Buffer.from("alert(1)")],
    ["a CUR cursor", Buffer.from([0, 0, 2, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0, 1, 2, 3, 4])],
    ["a TIFF", Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])],
    ["a BMP file", Buffer.from("BM6\u0000\u0000\u0000\u0000\u0000\u0000\u00006\u0000\u0000\u0000")],
    ["an empty input", Buffer.alloc(0)],
    ["a PNG signature alone", PNG_SIGNATURE],
  ])("%s", async (_name, input) => {
    const code = await refusal(codec.reencodeIcon(input));
    expect(["unsupported_format", "undecodable"]).toContain(code);
  });

  it.each([
    ["an SVG", SVG],
    ["an HTML page", Buffer.from("<html></html>")],
    ["an empty input", Buffer.alloc(0)],
  ])("names %s an unsupported format", async (_name, input) => {
    expect(await refusal(codec.reencodeIcon(input))).toBe("unsupported_format");
  });

  it("refuses a PNG that declares more pixels than the cap before it decodes any: the header alone says too_large", async () => {
    const declared = pngDeclaring(60_000, 60_000);

    expect(declared.length).toBeLessThan(100);
    expect(60_000 * 60_000).toBeGreaterThan(ICON_MAX_INPUT_PIXELS);
    expect(await refusal(codec.reencodeIcon(declared))).toBe("too_large");
  });

  it("refuses an ICO whose PNG declares more pixels than the cap", async () => {
    expect(await refusal(codec.reencodeIcon(ico(pngDeclaring(60_000, 60_000), 16)))).toBe("too_large");
  });

  it("refuses a decompression bomb that fits in 64 KiB: a small file whose decoded image is far above the cap", async () => {
    const edge = 7_000;
    const pixels = deflateSync(Buffer.alloc(edge * (edge + 1)), { level: 9 });
    const bomb = pngDeclaring(edge, edge, pixels);

    expect(bomb.length).toBeLessThanOrEqual(64 * 1024);
    expect(edge * edge).toBeGreaterThan(ICON_MAX_INPUT_PIXELS);
    expect(await refusal(codec.reencodeIcon(bomb))).toBe("too_large");
  });

  it("accepts a PNG at the cap and refuses one pixel row above it", async () => {
    const edge = Math.floor(Math.sqrt(ICON_MAX_INPUT_PIXELS));
    const atCap = pngDeclaring(edge, edge, deflateSync(Buffer.alloc(edge * (edge + 1)), { level: 9 }));
    const above = pngDeclaring(edge, edge + 1, deflateSync(Buffer.alloc(edge * (edge + 2)), { level: 9 }));

    await expectIcon(atCap);
    expect(await refusal(codec.reencodeIcon(above))).toBe("too_large");
  });

  it("refuses a GIF, a WebP and a JPEG that declare enormous dimensions in a few bytes", async () => {
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0]), Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b])]);
    const vp8x = Buffer.alloc(30);
    vp8x.write("RIFF", 0, "ascii");
    vp8x.writeUInt32LE(22, 4);
    vp8x.write("WEBPVP8X", 8, "ascii");
    vp8x.writeUInt32LE(10, 16);
    vp8x.writeUIntLE(0xffffff, 24, 3);
    vp8x.writeUIntLE(0xffffff, 27, 3);
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x4e, 0x20, 0x4e, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00,
      0x3f, 0x00, 0, 0, 0, 0, 0xff, 0xd9,
    ]);

    expect(await refusal(codec.reencodeIcon(gif))).toBe("too_large");
    expect(await refusal(codec.reencodeIcon(vp8x))).toBe("too_large");
    expect(await refusal(codec.reencodeIcon(jpeg))).toBe("too_large");
  });

  it("refuses a truncated PNG and an ICO whose entry points outside the file, with a fixed message that carries no byte of the input", async () => {
    const truncated = (await square(40).png().toBuffer()).subarray(0, 60);
    const outside = ico(Buffer.from("x"), 16);
    outside.writeUInt32LE(9_999, 14);

    for (const input of [truncated, outside]) {
      const error = await codec.reencodeIcon(input).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ImageRefused);
      expect((error as ImageRefused).message).toMatch(/^The image /);
    }
  });

  it("refuses an ICO bitmap that declares more than 256 pixels on an edge and one with a palette index outside the palette", async () => {
    const wide = dib32(16, 255);
    wide.writeInt32LE(5_000, 4);
    expect(await refusal(codec.reencodeIcon(ico(wide, 16)))).toBe("too_large");

    const palette = Buffer.alloc(40 + 8 + 4 + 4);
    palette.writeUInt32LE(40, 0);
    palette.writeInt32LE(1, 4);
    palette.writeInt32LE(2, 8);
    palette.writeUInt16LE(1, 12);
    palette.writeUInt16LE(1, 14);
    palette.writeUInt32LE(1, 32);
    palette[44] = 0x80;
    expect(await refusal(codec.reencodeIcon(ico(palette, 16)))).toBe("undecodable");
  });
});
