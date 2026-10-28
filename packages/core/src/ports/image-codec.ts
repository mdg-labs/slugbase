import type { Port } from "./port.ts";

/** The most pixels (width times height) of an image the codec decodes; an icon above it is refused before its pixels are allocated. */
export const ICON_MAX_INPUT_PIXELS = 4_194_304;

/** The edge lengths, in pixels, of the PNGs `reencodeIcon` produces. */
export const ICON_SIZES = [32, 64] as const;

export type ImageRefusalCode =
  /** The bytes are not an image format the codec accepts (PNG, JPEG, GIF, WebP or ICO): an SVG, an HTML page, a script, anything else. */
  | "unsupported_format"
  /** The image declares more than `ICON_MAX_INPUT_PIXELS` pixels, or an animation or a size the codec does not decode. */
  | "too_large"
  /** The bytes name a supported format but cannot be decoded. */
  | "undecodable";

/**
 * Thrown when the codec refuses an input. The message is a fixed text that never carries a byte of the input or the text of a lower-level error;
 * match on `code`.
 */
export class ImageRefused extends Error {
  readonly code: ImageRefusalCode;

  constructor(code: ImageRefusalCode) {
    super(
      {
        unsupported_format: "The image is not in a format the server accepts",
        too_large: "The image is larger than the server accepts",
        undecodable: "The image cannot be decoded",
      }[code],
    );
    this.name = "ImageRefused";
    this.code = code;
  }
}

/** The PNGs of one icon: square, `ICON_SIZES` pixels on an edge, never anything but a PNG. */
export interface ReencodedIcon {
  readonly png64: Uint8Array;
  readonly png32: Uint8Array;
}

/**
 * Turns the bytes of a fetched icon into the PNGs the server stores and serves (doc 02 section 5.4, doc 10 T6 and T14). The bytes are untrusted: the
 * codec identifies the format from the bytes themselves, not from a `Content-Type`, accepts only PNG, JPEG, GIF, WebP and ICO, refuses a vector format
 * (SVG) and anything it does not recognise, reads the declared size of the image and refuses one above `ICON_MAX_INPUT_PIXELS` before it allocates a
 * pixel, and decodes the first frame of an animation. What it returns is encoded afresh, so nothing of the input is carried into the output. Rejects
 * with `ImageRefused` for an input it refuses.
 */
export interface ImageCodecPort extends Port {
  reencodeIcon(input: Uint8Array): Promise<ReencodedIcon>;
}
