import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * Twilio's letter of authorisation, filled in (M17).
 *
 * The carrier gets Twilio's own form, not something that looks like it: the PDF Twilio publishes for moving
 * numbers to it (`public/ports/twilio-loa.pdf`) is loaded as it is and the business's answers are written into its
 * boxes. It has no form fields, so every box is a position on the page, measured from the form itself; the
 * numbers below are those measurements, top-left origin as the form was laid out, turned into PDF coordinates by
 * `at`.
 *
 * The form has room for four numbers and says to put the rest on an extra page, so a fifth and after go on pages
 * of their own after it, in the same four columns.
 *
 * Built in the browser, so the account number and PIN on it go from the form to the file without passing through
 * anything of ours on the way.
 */

/** The path the form is served at. */
export const LETTER_TEMPLATE_PATH = '/ports/twilio-loa.pdf';

/** The file name the signed letter goes up under. */
export const LETTER_FILE_NAME = 'twilio-letter-of-authorization.pdf';

/** One number on the letter, with the old carrier's account it is on. */
export interface LetterNumber {
  /** As people read it: "(719) 204-8574". */
  readonly display: string;
  /** The carrier it is with today. */
  readonly carrier: string;
  readonly accountNumber: string;
  readonly pin: string;
}

/** Everything the form asks for. */
export interface LetterDetails {
  /** The name on the phone bill, exactly as it is there. */
  readonly firstName: string;
  readonly lastName: string;
  /** When the service is in the business's name. */
  readonly businessName: string;
  /** The service address the old carrier has: a street address, never a PO box. */
  readonly address: {
    readonly street: string;
    readonly city: string;
    readonly state: string;
    readonly zip: string;
  };
  readonly numbers: readonly LetterNumber[];
  /**
   * A signature drawn on the screen (a PNG data URL), the signer's name set in a signature face, or nothing — a
   * blank line, for a copy somebody wants to read before they sign.
   */
  readonly signature:
    { readonly kind: 'drawn'; readonly png: string } | { readonly kind: 'typed' } | null;
  /** The name printed beside the signature. */
  readonly printName: string;
  readonly date: Date;
}

const PAGE_HEIGHT = 792;
const INK = rgb(0.05, 0.1, 0.35);
const SIZE = 10.5;
/** Rows of numbers the form itself has room for. */
const ROWS_ON_FORM = 4;

/** A box on the form: left, right and the baseline its text sits on, in the form's own top-down measurements. */
interface Box {
  readonly left: number;
  readonly right: number;
  readonly baseline: number;
}

const BOX = {
  firstName: { left: 36, right: 304, baseline: 185.5 },
  lastName: { left: 313.5, right: 581, baseline: 185.5 },
  businessName: { left: 36, right: 581, baseline: 218.5 },
  street: { left: 36, right: 581, baseline: 313.5 },
  city: { left: 36, right: 211, baseline: 356 },
  state: { left: 221, right: 396, baseline: 356 },
  zip: { left: 406, right: 581, baseline: 356 },
  printName: { left: 196, right: 412, baseline: 656 },
  date: { left: 451, right: 553, baseline: 656 },
} satisfies Record<string, Box>;

/** The number table's four rows, and its columns. */
const ROW_BASELINES = [480.3, 496.6, 513.2, 529.7] as const;
const COLUMNS = {
  /** Inside the printed "(   )": the area code. */
  areaCode: { left: 41, right: 76 },
  /** After it: the rest of the number. */
  local: { left: 85, right: 204 },
  carrier: { left: 211, right: 330 },
  accountNumber: { left: 337, right: 478 },
  pin: { left: 485, right: 582 },
} as const;
/** The signature sits on its line, in the band between the paragraph above and the line. */
const SIGNATURE = { left: 38, right: 186, bottom: 657, maxHeight: 24 } as const;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "(719) 204-8574" → ["719", "204-8574"]; anything else goes after the brackets whole. */
export function splitNumber(display: string): [string, string] {
  const m = /^\s*\((\d{3})\)\s*(.+)$/.exec(display);
  return m ? [m[1]!, m[2]!.trim()] : ['', display.trim()];
}

/** Fills Twilio's form in. `template` is the form's bytes, as served at `LETTER_TEMPLATE_PATH`. */
export async function buildLetterPdf(
  d: LetterDetails,
  template: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(template);
  const name = oneLine(`${d.firstName} ${d.lastName}`);
  pdf.setTitle(`Letter of Authorization — ${oneLine(d.businessName) || name}`);
  pdf.setAuthor(name);
  pdf.setCreator('HandsFreeOS');
  pdf.setCreationDate(d.date);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const form = pdf.getPage(0);
  const put = writer(regular);

  put(form, BOX.firstName, d.firstName);
  put(form, BOX.lastName, d.lastName);
  put(form, BOX.businessName, d.businessName);
  put(form, BOX.street, d.address.street);
  put(form, BOX.city, d.address.city);
  put(form, BOX.state, d.address.state);
  put(form, BOX.zip, d.address.zip);

  const row = (page: PDFPage, baseline: number, n: LetterNumber, withBrackets: boolean) => {
    const [area, local] = splitNumber(n.display);
    if (withBrackets) {
      // Centred in the "(   )" the form prints.
      const w = regular.widthOfTextAtSize(area, SIZE);
      const mid = (COLUMNS.areaCode.left + COLUMNS.areaCode.right) / 2;
      put(page, { left: mid - w / 2, right: COLUMNS.areaCode.right, baseline }, area);
      put(page, { ...COLUMNS.local, baseline }, local);
    } else {
      put(page, { left: COLUMNS.areaCode.left, right: COLUMNS.local.right, baseline }, n.display);
    }
    put(page, { ...COLUMNS.carrier, baseline }, n.carrier);
    put(page, { ...COLUMNS.accountNumber, baseline }, n.accountNumber);
    put(page, { ...COLUMNS.pin, baseline }, n.pin);
  };
  d.numbers.slice(0, ROWS_ON_FORM).forEach((n, i) => row(form, ROW_BASELINES[i]!, n, true));

  // The signature, the name beside it, and the day.
  if (d.signature?.kind === 'drawn') {
    const image = await pdf.embedPng(d.signature.png);
    const scale = Math.min(
      (SIGNATURE.right - SIGNATURE.left) / image.width,
      SIGNATURE.maxHeight / image.height,
    );
    const h = image.height * scale;
    form.drawImage(image, {
      x: SIGNATURE.left,
      y: at(SIGNATURE.bottom),
      width: image.width * scale,
      height: h,
    });
  } else if (d.signature?.kind === 'typed') {
    const size = fitSize(script, name, 20, SIGNATURE.right - SIGNATURE.left);
    form.drawText(safe(name, script), {
      x: SIGNATURE.left,
      y: at(SIGNATURE.bottom - 2),
      size,
      font: script,
      color: INK,
    });
  }
  put(form, BOX.printName, d.printName || name);
  put(form, BOX.date, formatDate(d.date));

  // A fifth number and after: "If you have more than 4 numbers, please list on an extra page".
  const rest = d.numbers.slice(ROWS_ON_FORM);
  if (rest.length) {
    const perPage = 30;
    for (let start = 0; start < rest.length; start += perPage) {
      const page = pdf.addPage([612, PAGE_HEIGHT]);
      let y = 72;
      const heading = 'Letter of Authorization — additional telephone numbers';
      page.drawText(heading, { x: 36, y: at(y), size: 13, font: bold, color: rgb(0, 0, 0) });
      y += 20;
      const who = [oneLine(d.businessName), name].filter(Boolean).join(' · ');
      page.drawText(
        safe(`Continued from page 1 for ${who}, signed ${formatDate(d.date)}.`, regular),
        {
          x: 36,
          y: at(y),
          size: 9.5,
          font: regular,
          color: rgb(0.3, 0.3, 0.3),
        },
      );
      y += 28;
      const headers: [string, number][] = [
        ['Phone Number', COLUMNS.areaCode.left],
        ['Service Provider', COLUMNS.carrier.left],
        ['Account Number', COLUMNS.accountNumber.left],
        ['PIN (if applicable)', COLUMNS.pin.left],
      ];
      for (const [label, x] of headers)
        page.drawText(label, { x, y: at(y), size: 10, font: bold, color: rgb(0, 0, 0) });
      y += 6;
      page.drawLine({
        start: { x: 31, y: at(y) },
        end: { x: 585, y: at(y) },
        thickness: 0.75,
        color: rgb(0, 0, 0),
      });
      for (const n of rest.slice(start, start + perPage)) {
        y += 18;
        row(page, y, n, false);
        page.drawLine({
          start: { x: 31, y: at(y + 5) },
          end: { x: 585, y: at(y + 5) },
          thickness: 0.4,
          color: rgb(0.6, 0.6, 0.6),
        });
      }
    }
  }

  return pdf.save();
}

/** The form's top-down measurements, as PDF coordinates. */
const at = (fromTop: number) => PAGE_HEIGHT - fromTop;

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(
    date,
  );

/** The size at which `text` fits `width`, no bigger than `size` and no smaller than 7. */
function fitSize(font: PDFFont, text: string, size: number, width: number): number {
  const w = font.widthOfTextAtSize(safe(text, font) || ' ', size);
  return w <= width ? size : Math.max(7, (size * width) / w);
}

/** Writes into one box: on its baseline, from its left edge, set smaller rather than spill past its right. */
function writer(font: PDFFont) {
  return (page: PDFPage, box: Box, value: string) => {
    const text = safe(oneLine(value), font);
    if (!text) return;
    page.drawText(text, {
      x: box.left,
      y: at(box.baseline),
      size: fitSize(font, text, SIZE, box.right - box.left),
      font,
      color: INK,
    });
  };
}

const charsets = new WeakMap<PDFFont, Set<number>>();

/**
 * What the built-in fonts cannot draw, made drawable. They cover Western European text and not much more, and
 * pdf-lib throws on anything else — so an accent they lack loses the accent, and anything left becomes a question
 * mark rather than a letter that will not build.
 */
function safe(s: string, font: PDFFont): string {
  let ok = charsets.get(font);
  if (!ok) {
    ok = new Set(font.getCharacterSet());
    charsets.set(font, ok);
  }
  const set = ok;
  return Array.from(s.normalize('NFC'))
    .map((ch) => {
      if (set.has(ch.codePointAt(0)!)) return ch;
      const bare = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      return bare && Array.from(bare).every((b) => set.has(b.codePointAt(0)!)) ? bare : '?';
    })
    .join('');
}
