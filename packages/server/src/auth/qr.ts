import qrcode from "qrcode-generator";

const CELL_SIZE = 4;
const MARGIN_CELLS = 4;

/**
 * The QR code of `text` as a self-contained SVG document: black cells on a white square with a quiet
 * zone of four cells, at the smallest symbol version that holds the text with error correction level M.
 * The document holds only shapes, never script or a reference to anything outside it.
 */
export function renderQrSvg(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createSvgTag({ cellSize: CELL_SIZE, margin: MARGIN_CELLS * CELL_SIZE, scalable: true });
}
