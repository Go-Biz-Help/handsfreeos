import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * The signed letter a port needs, made here rather than printed, signed and scanned (M17).
 *
 * The words are Twilio's own letter-of-authorisation template, filled in: every `{…}` below is one of its
 * `[…]` gaps and nothing else is changed. One thing is added at the end, because the template says
 * "number(s)" without ever saying which: the numbers the letter covers.
 *
 * Built in the browser with the fonts every PDF reader already has, so nothing about the business leaves the
 * page until it is attached — and then it goes up exactly like a letter somebody scanned.
 */

/** Whatever the business typed into the letter's gaps. */
export interface LetterDetails {
  /** `[END USER BUSINESS NAME]` — the business's legal name. */
  readonly businessName: string;
  /** `[COMPANY REGISTRATION NUMBER]` — the EIN, or the state's registration number. */
  readonly registrationNumber: string;
  /** `[DESCRIPTION OF SERVICES]` — finishes the sentence "{business} provides …". */
  readonly services: string;
  /** `[COUNTRY]` — "the United States". */
  readonly country: string;
  /** `[COUNTRY AND NUMBER TYPE]` — "United States local". */
  readonly numberType: string;
  /** The letterhead under the name: the business's address, and a website or phone if it has one. */
  readonly letterhead: readonly string[];
  readonly date: Date;
  readonly signer: {
    readonly name: string;
    readonly title: string;
    readonly phone: string;
    readonly email: string;
  };
  /**
   * A signature drawn on the screen (a PNG data URL), the signer's name set in a signature face, or nothing —
   * a blank line, for a copy somebody wants to read before they sign.
   */
  readonly signature:
    { readonly kind: 'drawn'; readonly png: string } | { readonly kind: 'typed' } | null;
  /** The numbers the letter covers, as people read them. */
  readonly numbers: readonly string[];
}

/** The template's body, gap for gap. */
const BODY: readonly string[] = [
  '{business}, with company registration number {registration}, provides {services}. By way of this letter, {business} requests to obtain the right to make use of {numberType} number(s).',
  'To provide support to customers in {country}, {business} requires {numberType} number(s) to facilitate service requests from these customers.',
  "{business} agrees to use the number(s) exclusively for inbound customer calls made to Customer Support or similar services in connection with {business}'s business and agrees that it will not permit use of the number(s) by third-party users for their own purposes. Further, {business} will not use the number(s) for Callback, Calling Cards, and/or Third Country Calling.",
  '{business} is aware of the country restrictions with respect to the number(s) and will respect them.',
];

const PAGE = { width: 612, height: 792 } as const; // US Letter, in points
const MARGIN = 72;
const WIDTH = PAGE.width - MARGIN * 2;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);
const RULE = rgb(0.75, 0.75, 0.75);

/** The file name the letter goes up under. */
export const LETTER_FILE_NAME = 'letter-of-authorization.pdf';

/** "United States local", "United States toll-free", or both — read off the numbers themselves. */
export function numberTypeFor(e164s: readonly string[]): string {
  const tollFree = e164s.filter((n) => /^\+18(00|33|44|55|66|77|88)/.test(n)).length;
  if (tollFree === 0) return 'United States local';
  if (tollFree === e164s.length) return 'United States toll-free';
  return 'United States local and toll-free';
}

/** The letter's gaps with what was typed in them. A trailing full stop is the template's, not theirs. */
export function letterParagraphs(d: LetterDetails): string[] {
  const fill: Record<string, string> = {
    business: oneLine(d.businessName),
    registration: oneLine(d.registrationNumber),
    services: oneLine(d.services).replace(/[.\s]+$/, ''),
    country: oneLine(d.country),
    numberType: oneLine(d.numberType),
  };
  return BODY.map((p) => p.replace(/\{(\w+)\}/g, (_, k: string) => fill[k] ?? ''));
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Builds the letter. Returns the PDF's bytes. */
export async function buildLetterPdf(d: LetterDetails): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Letter of Authorization — ${oneLine(d.businessName)}`);
  pdf.setAuthor(oneLine(d.businessName));
  pdf.setSubject('Letter of Authorization for phone numbers');
  pdf.setCreator('HandsFreeOS');
  pdf.setCreationDate(d.date);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const w = new Writer(pdf, regular);

  // Letterhead.
  w.text(oneLine(d.businessName), { font: bold, size: 16 });
  for (const line of d.letterhead.map(oneLine).filter(Boolean))
    w.text(line, { size: 9.5, color: MUTED, gap: 2 });
  w.space(8);
  w.rule();
  w.space(22);

  w.text(new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(d.date), { size: 11 });
  w.space(18);
  w.text('To Whom It May Concern:', { size: 11 });
  w.space(12);
  for (const p of letterParagraphs(d)) {
    w.paragraph(p, { size: 11, leading: 15.5 });
    w.space(10);
  }
  w.space(6);
  w.text('Sincerely,', { size: 11 });

  // The signature, on its line.
  w.need(84);
  if (d.signature?.kind === 'drawn') {
    const image = await pdf.embedPng(d.signature.png);
    const scale = Math.min(200 / image.width, 56 / image.height, 1);
    const h = image.height * scale;
    w.space(8);
    w.page.drawImage(image, { x: MARGIN, y: w.y - h, width: image.width * scale, height: h });
    w.space(h + 4);
  } else if (d.signature?.kind === 'typed') {
    w.space(34);
    w.page.drawText(w.safe(oneLine(d.signer.name), script), {
      x: MARGIN,
      y: w.y,
      size: 24,
      font: script,
      color: INK,
    });
    w.space(8);
  } else {
    w.space(50);
  }
  w.page.drawLine({
    start: { x: MARGIN, y: w.y },
    end: { x: MARGIN + 240, y: w.y },
    thickness: 0.75,
    color: INK,
  });
  w.space(12);
  w.text('Signature of authorized signatory', { size: 8.5, color: MUTED });
  w.space(22);

  w.rule();
  w.space(18);
  // The stamp beside the signatory's details rather than under them, which keeps a short list of numbers on
  // the one page.
  const stamp = { width: 140, height: 64 };
  const stampX = PAGE.width - MARGIN - stamp.width;
  w.need(96);
  const top = w.y;
  w.page.drawText('Company Stamp:', {
    x: stampX,
    y: top - 10.5,
    size: 10.5,
    font: bold,
    color: INK,
  });
  w.page.drawRectangle({
    x: stampX,
    y: top - 18 - stamp.height,
    width: stamp.width,
    height: stamp.height,
    borderColor: RULE,
    borderWidth: 0.75,
  });
  const rows: [string, string][] = [
    ['NAME:', d.signer.name],
    ['TITLE:', d.signer.title],
    ['PHONE NUMBER:', d.signer.phone],
    ['EMAIL:', d.signer.email],
  ];
  for (const [label, value] of rows)
    w.labelled(label, oneLine(value), bold, stampX - 16 - (MARGIN + 100));
  w.y = Math.min(w.y, top - 18 - stamp.height);
  w.space(28);

  // Which numbers, since the template never says.
  w.need(40);
  w.text('Number(s) covered by this letter', { font: bold, size: 10.5 });
  w.space(4);
  const columns = 3;
  const colWidth = WIDTH / columns;
  for (let i = 0; i < d.numbers.length; i += columns) {
    w.need(16);
    d.numbers.slice(i, i + columns).forEach((n, c) =>
      w.page.drawText(w.safe(n, regular), {
        x: MARGIN + c * colWidth,
        y: w.y - 10.5,
        size: 10.5,
        font: regular,
        color: INK,
      }),
    );
    w.space(16);
  }

  return pdf.save();
}

/** Lays text down a page from the top, and starts another when it runs out. */
class Writer {
  page: PDFPage;
  /** The top of the next line. */
  y: number;
  private readonly charsets = new Map<PDFFont, Set<number>>();

  constructor(
    private readonly pdf: PDFDocument,
    private readonly font: PDFFont,
  ) {
    this.page = pdf.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  need(height: number) {
    if (this.y - height >= MARGIN) return;
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  space(height: number) {
    this.y -= height;
  }

  rule() {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE.width - MARGIN, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
  }

  text(
    s: string,
    o: { font?: PDFFont; size: number; color?: ReturnType<typeof rgb>; gap?: number },
  ) {
    const font = o.font ?? this.font;
    for (const line of this.wrap(this.safe(s, font), font, o.size)) {
      this.need(o.size + (o.gap ?? 0));
      this.y -= o.size;
      this.page.drawText(line, { x: MARGIN, y: this.y, size: o.size, font, color: o.color ?? INK });
      this.y -= o.gap ?? 4;
    }
  }

  paragraph(s: string, o: { size: number; leading: number }) {
    for (const line of this.wrap(this.safe(s, this.font), this.font, o.size)) {
      this.need(o.leading);
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y - o.size,
        size: o.size,
        font: this.font,
        color: INK,
      });
      this.y -= o.leading;
    }
  }

  /** A label and its value on one line. A value too long for the room is set smaller, never cut off. */
  labelled(label: string, value: string, bold: PDFFont, room: number) {
    const size = 10.5;
    this.need(20);
    this.page.drawText(label, { x: MARGIN, y: this.y - size, size, font: bold, color: INK });
    const text = this.safe(value, this.font);
    const fit = Math.max(
      7,
      Math.min(size, (size * room) / this.font.widthOfTextAtSize(text || ' ', size)),
    );
    if (text)
      this.page.drawText(text, {
        x: MARGIN + 100,
        y: this.y - size,
        size: fit,
        font: this.font,
        color: INK,
      });
    this.y -= 20;
  }

  private wrap(s: string, font: PDFFont, size: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(next, size) <= WIDTH) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * What the built-in fonts cannot draw, made drawable. They cover Western European text and not much more,
   * and pdf-lib throws on anything else — so an accent they lack loses the accent, and anything left becomes
   * a question mark rather than a letter that will not build.
   */
  safe(s: string, font: PDFFont): string {
    let set = this.charsets.get(font);
    if (!set) {
      set = new Set(font.getCharacterSet());
      this.charsets.set(font, set);
    }
    const ok = set;
    return Array.from(s.replace(/\s+/g, ' ').normalize('NFC'))
      .map((ch) => {
        if (ok.has(ch.codePointAt(0)!)) return ch;
        const bare = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        return bare && Array.from(bare).every((b) => ok.has(b.codePointAt(0)!)) ? bare : '?';
      })
      .join('');
  }
}
