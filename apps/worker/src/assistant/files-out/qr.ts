/**
 * A QR code to print (make_qr_code): one Letter page with the title over the code, the code big in the middle, and
 * under it a line saying what to do, the link written out and the business's name. The code is drawn as squares, so
 * it stays sharp however big it's printed, from the same library and error correction as the web's Share tab and the
 * phone's link sheet (apps/mobile/src/forms/qr.ts), with the four-square border scanners need to find it.
 *
 * The standard fonts only write Western European letters (documents/pdf.ts, `writable`): anything else is "?".
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { wrap, writable } from '../../documents/pdf';

const INK = rgb(0.07, 0.09, 0.15);
const GREY = rgb(0.42, 0.45, 0.5);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
/** The empty border round the code, in squares, as the standard asks. */
const QUIET = 4;
/** The code and its border, in points: five and a half inches. */
const CODE_SIDE = 396;

export interface QrPageWords {
  /** Over the code: "Get a free quote". */
  readonly title: string;
  /** The page it opens, written out under it. */
  readonly link: string;
  readonly business: string;
}

/** The code's squares, as the web and the phone make them. */
export function qrSquares(text: string): {
  readonly size: number;
  dark(x: number, y: number): boolean;
} {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  return { size, dark: (x, y) => Boolean(data[y * size + x]) };
}

/** The page as a PDF. */
export async function qrCodePdf(words: QrPageWords): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(writable(words.title).replace(/\n/g, ' '));
  doc.setAuthor(writable(words.business).replace(/\n/g, ' '));
  doc.setSubject(words.link);
  doc.setCreator('HandsFreeOS');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const room = PAGE_W - MARGIN * 2;
  const centred = (line: string, y: number, size: number, font = regular, color = INK) =>
    page.drawText(line, {
      x: (PAGE_W - font.widthOfTextAtSize(line, size)) / 2,
      y,
      size,
      font,
      color,
    });

  // The title, up to two lines, as big as fits.
  let size = 34;
  let titleLines = wrap(words.title, bold, size, room);
  while (titleLines.length > 2 && size > 20) {
    size -= 2;
    titleLines = wrap(words.title, bold, size, room);
  }
  titleLines = titleLines.slice(0, 2);
  let y = PAGE_H - MARGIN - size;
  for (const line of titleLines) {
    centred(line, y, size, bold);
    y -= size * 1.2;
  }

  // The code: one rectangle for each run of dark squares along a row.
  const { size: squares, dark } = qrSquares(words.link);
  const cell = CODE_SIDE / (squares + QUIET * 2);
  const left = (PAGE_W - CODE_SIDE) / 2;
  const top = y - 12;
  for (let row = 0; row < squares; row++) {
    let col = 0;
    while (col < squares) {
      if (!dark(col, row)) {
        col++;
        continue;
      }
      const start = col;
      while (col < squares && dark(col, row)) col++;
      page.drawRectangle({
        x: left + (QUIET + start) * cell,
        y: top - (QUIET + row + 1) * cell,
        // A hair over, so neighbouring rows meet without a white seam when printed.
        width: (col - start) * cell + 0.05,
        height: cell + 0.05,
        color: INK,
      });
    }
  }
  y = top - CODE_SIDE - 6;

  centred('Point your phone’s camera at the code.', y, 13, regular, GREY);
  y -= 26;
  for (const line of wrap(words.link, regular, 12, room).slice(0, 3)) {
    centred(line, y, 12);
    y -= 16;
  }
  centred(wrap(words.business, regular, 11, room)[0] ?? '', MARGIN, 11, regular, GREY);
  return Buffer.from(await doc.save());
}
