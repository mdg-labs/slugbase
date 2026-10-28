import { ICON_MAX_INPUT_PIXELS, ICON_SIZES, ImageRefused, type ImageCodecPort, type ReencodedIcon } from "@slugbase/core";
import sharp, { type Sharp } from "sharp";

// The image codec of the favicon fetch (doc 02 section 5.4, doc 10 T6 and T14), built on sharp (libvips). The bytes are untrusted: they come from a site a
// member does not control. The codec never trusts a `Content-Type`; it identifies the format from the bytes and accepts PNG, JPEG, GIF, WebP and ICO only,
// so an SVG (a vector format that can carry script), an HTML page and anything it does not recognise are refused before any decoder sees them. The decoder
// reads the declared size of the image first and refuses one with more than `ICON_MAX_INPUT_PIXELS` pixels before it allocates a pixel, so a small file that
// declares enormous dimensions cannot make the server allocate them: the size is read from the header of a PNG, a GIF and a WebP here, and the decoder
// enforces the same cap again (`limitInputPixels`, which is also what covers a JPEG). An animation is read as its first frame. An ICO is read by its
// own directory: the largest image of it is taken, as the PNG it embeds or as the bitmap it holds (at most 256 by 256, read here into pixels). What it
// returns is encoded afresh as a PNG at 32 and 64 pixels with no metadata, so nothing of the input is carried into the output.

type Format = "png" | "jpeg" | "gif" | "webp" | "ico";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_MAX_ENTRIES = 64;
const ICO_MAX_EDGE = 256;
const DIB_HEADER_BYTES = 40;

/** The most bytes of one stored PNG, which is what the database accepts. */
const MAX_PNG_BYTES = 65_536;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean {
  return bytes.length >= at + prefix.length && prefix.every((value, index) => bytes[at + index] === value);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function formatOf(bytes: Uint8Array): Format | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") {
    return "gif";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "webp";
  }
  if (bytes.length >= ICO_HEADER_BYTES && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return "ico";
  }
  return undefined;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/** The size a PNG, GIF or WebP declares in its header, read from fixed offsets; undefined when the header is too short or is not one the codec reads. */
function declaredSize(bytes: Uint8Array, format: Format): Size | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (format) {
    case "png":
      return bytes.length >= 24 && ascii(bytes, 12, 4) === "IHDR" ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined;
    case "gif":
      return bytes.length >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : undefined;
    case "webp": {
      const kind = bytes.length >= 30 ? ascii(bytes, 12, 4) : "";
      if (kind === "VP8X") {
        return { width: 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)), height: 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) };
      }
      if (kind === "VP8L" && view.getUint8(20) === 0x2f) {
        const bits = view.getUint32(21, true);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      if (kind === "VP8 ") {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Refuses an image whose header declares more than `ICON_MAX_INPUT_PIXELS` pixels, or none; the decoder is not given it. */
function checkDeclaredSize(bytes: Uint8Array, format: Format): void {
  const size = declaredSize(bytes, format);
  if (size !== undefined && (size.width < 1 || size.height < 1)) {
    throw new ImageRefused("undecodable");
  }
  if (size !== undefined && size.width * size.height > ICON_MAX_INPUT_PIXELS) {
    throw new ImageRefused("too_large");
  }
}

interface IcoEntry {
  readonly width: number;
  readonly height: number;
  readonly bitCount: number;
  readonly size: number;
  readonly offset: number;
}

/** The image of an ICO that is largest (then deepest); entries that point outside the file are not images. */
function bestIcoEntry(bytes: Uint8Array): IcoEntry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (count === 0 || count > ICO_MAX_ENTRIES || bytes.length < ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES) {
    throw new ImageRefused("undecodable");
  }
  let best: IcoEntry | undefined;
  for (let index = 0; index < count; index += 1) {
    const at = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const entry: IcoEntry = {
      width: view.getUint8(at) === 0 ? ICO_MAX_EDGE : view.getUint8(at),
      height: view.getUint8(at + 1) === 0 ? ICO_MAX_EDGE : view.getUint8(at + 1),
      bitCount: view.getUint16(at + 6, true),
      size: view.getUint32(at + 8, true),
      offset: view.getUint32(at + 12, true),
    };
    if (entry.size === 0 || entry.offset + entry.size > bytes.length) {
      continue;
    }
    if (best === undefined || entry.width * entry.height > best.width * best.height || (entry.width * entry.height === best.width * best.height && entry.bitCount > best.bitCount)) {
      best = entry;
    }
  }
  if (best === undefined) {
    throw new ImageRefused("undecodable");
  }
  return best;
}

interface Pixels {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Reads the bitmap an ICO entry holds (a DIB without a file header, its height doubled for the mask) into RGBA pixels. */
function readDib(bytes: Uint8Array): Pixels {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < DIB_HEADER_BYTES || view.getUint32(0, true) < DIB_HEADER_BYTES) {
    throw new ImageRefused("undecodable");
  }
  const headerSize = view.getUint32(0, true);
  const width = view.getInt32(4, true);
  const doubled = view.getInt32(8, true);
  const bitCount = view.getUint16(14, true);
  const compression = view.getUint32(16, true);
  const height = Math.abs(doubled) / 2;
  if (width < 1 || width > ICO_MAX_EDGE || !Number.isInteger(height) || height < 1 || height > ICO_MAX_EDGE) {
    throw new ImageRefused("too_large");
  }
  if (![1, 4, 8, 24, 32].includes(bitCount) || (compression !== 0 && !(compression === 3 && bitCount === 32))) {
    throw new ImageRefused("undecodable");
  }
  const colorsUsed = view.getUint32(32, true);
  const paletteEntries = bitCount <= 8 ? (colorsUsed === 0 ? 1 << bitCount : colorsUsed) : 0;
  if (paletteEntries > 1 << bitCount) {
    throw new ImageRefused("undecodable");
  }
  const paletteAt = headerSize;
  const bitsAt = paletteAt + paletteEntries * 4 + (compression === 3 && headerSize === DIB_HEADER_BYTES ? 12 : 0);
  const rowBytes = Math.floor((width * bitCount + 31) / 32) * 4;
  const maskRowBytes = Math.floor((width + 31) / 32) * 4;
  const maskAt = bitsAt + rowBytes * height;
  if (maskAt > bytes.length) {
    throw new ImageRefused("undecodable");
  }
  const hasMask = maskAt + maskRowBytes * height <= bytes.length;
  const topDown = doubled < 0;
  const data = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let row = 0; row < height; row += 1) {
    const source = topDown ? row : height - 1 - row;
    const line = bitsAt + source * rowBytes;
    for (let column = 0; column < width; column += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 255;
      if (bitCount === 32 || bitCount === 24) {
        const at = line + column * (bitCount / 8);
        blue = bytes[at] ?? 0;
        green = bytes[at + 1] ?? 0;
        red = bytes[at + 2] ?? 0;
        if (bitCount === 32) {
          alpha = bytes[at + 3] ?? 0;
          anyAlpha ||= alpha !== 0;
        }
      } else {
        const bit = column * bitCount;
        const byte = bytes[line + (bit >> 3)] ?? 0;
        const index = (byte >> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1);
        if (index >= paletteEntries) {
          throw new ImageRefused("undecodable");
        }
        const at = paletteAt + index * 4;
        blue = bytes[at] ?? 0;
        green = bytes[at + 1] ?? 0;
        red = bytes[at + 2] ?? 0;
      }
      const out = (row * width + column) * 4;
      data[out] = red;
      data[out + 1] = green;
      data[out + 2] = blue;
      data[out + 3] = alpha;
    }
  }
  if (hasMask && (bitCount !== 32 || !anyAlpha)) {
    // The AND mask decides what is transparent when the bitmap has no alpha of its own.
    for (let row = 0; row < height; row += 1) {
      const source = topDown ? row : height - 1 - row;
      const line = maskAt + source * maskRowBytes;
      for (let column = 0; column < width; column += 1) {
        const transparent = (((bytes[line + (column >> 3)] ?? 0) >> (7 - (column & 7))) & 1) === 1;
        data[(row * width + column) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  } else if (bitCount === 32 && !anyAlpha) {
    for (let at = 3; at < data.length; at += 4) {
      data[at] = 255;
    }
  }
  return { data, width, height };
}

function refusalOf(error: unknown): ImageRefused {
  if (error instanceof ImageRefused) {
    return error;
  }
  return new ImageRefused(error instanceof Error && /exceeds pixel limit/i.test(error.message) ? "too_large" : "undecodable");
}

function squarePng(source: Sharp, size: (typeof ICON_SIZES)[number]): Promise<Buffer> {
  return source
    .clone()
    .resize(size, size, { fit: "contain", background: TRANSPARENT })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function encode(source: Sharp): Promise<ReencodedIcon> {
  const [png64, png32] = await Promise.all([squarePng(source, 64), squarePng(source, 32)]);
  if (png64.length > MAX_PNG_BYTES || png32.length > MAX_PNG_BYTES) {
    throw new ImageRefused("too_large");
  }
  return { png64: new Uint8Array(png64), png32: new Uint8Array(png32) };
}

function decoder(input: Buffer): Sharp {
  return sharp(input, { limitInputPixels: ICON_MAX_INPUT_PIXELS, failOn: "error", animated: false, sequentialRead: true });
}

/**
 * The image codec of `ImageCodecPort` on sharp. It holds no state; one value serves every job. libvips' operation cache is turned off, because the
 * inputs are small, once-only and untrusted.
 */
export class SharpImageCodec implements ImageCodecPort {
  readonly available = true;

  constructor() {
    sharp.cache(false);
  }

  async reencodeIcon(input: Uint8Array): Promise<ReencodedIcon> {
    try {
      const format = formatOf(input);
      if (format === undefined) {
        throw new ImageRefused("unsupported_format");
      }
      if (format !== "ico") {
        checkDeclaredSize(input, format);
        return await encode(decoder(Buffer.from(input.buffer, input.byteOffset, input.byteLength)));
      }
      const entry = bestIcoEntry(input);
      const image = input.subarray(entry.offset, entry.offset + entry.size);
      if (startsWith(image, PNG_SIGNATURE)) {
        checkDeclaredSize(image, "png");
        return await encode(decoder(Buffer.from(image.buffer, image.byteOffset, image.byteLength)));
      }
      const pixels = readDib(image);
      return await encode(sharp(pixels.data, { raw: { width: pixels.width, height: pixels.height, channels: 4 }, limitInputPixels: ICON_MAX_INPUT_PIXELS }));
    } catch (error) {
      throw refusalOf(error);
    }
  }
}
