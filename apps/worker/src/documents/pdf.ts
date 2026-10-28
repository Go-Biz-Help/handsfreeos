/**
 * The signed copy (answers 16a and 17a): the PDF the template was made from, with the words the team typed over
 * (26c), everything filled in and each signature drawn in place, then a proof page at the end saying who signed,
 * when, from where, and what they agreed to.
 *
 * Every page is redrawn as the signer saw it: the original page goes in as a picture of itself (`embedPage`), turned
 * the way it shows, on a page of the size it showed at. That keeps the fractions the editor placed things with true
 * on a rotated or cropped page, and flattens the original's own form fields into the page, so nothing on the signed
 * copy can be changed by typing into it afterwards.
 *
 * The standard PDF fonts only write Western European letters: anything else becomes "?". Answer 26c's words are
 * typed by the team, and a signer's name comes from their signature's picture, so this rarely shows.
 */
import {
  degrees,
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import {
  DOCUMENT_CHANNEL_LABELS,
  documentDay,
  DOCUMENT_STEP_LABELS,
  PROOF_WORDS,
  SIGNING_WORDS,
  type DocumentDefinition,
  type DocumentEdit,
  type DocumentField,
  type DocumentStepKind,
  type DocumentValue,
} from '@hfos/core/server';

export interface ProofStep {
  readonly kind: DocumentStepKind;
  readonly at: Date;
  readonly channel: keyof typeof DOCUMENT_CHANNEL_LABELS | null;
  readonly ip: string | null;
  readonly device: string | null;
}

export interface ProofSigner {
  readonly id: string;
  readonly kind: 'signer' | 'copy';
  readonly name: string;
  readonly roleLabel: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly agreedWording: string | null;
  readonly steps: readonly ProofStep[];
}

export interface SignedCopyInput {
  readonly source: Uint8Array;
  readonly definition: DocumentDefinition;
  /** Everything filled in, by field: the team's before it went, and each signer's. */
  readonly values: Readonly<Record<string, DocumentValue>>;
  readonly proof: {
    readonly documentId: string;
    readonly documentName: string;
    readonly business: string;
    readonly sentBy: string | null;
    readonly sentAt: Date;
    readonly completedAt: Date;
    readonly timeZone: string;
    readonly sourceSha256: string;
    /** In signing order; copies last. */
    readonly signers: readonly ProofSigner[];
    /** The signature each signer drew or typed, by signer. */
    readonly signatures: Readonly<Record<string, DocumentValue | undefined>>;
  };
}

// ---------- letters the standard fonts can write ----------

const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** What the standard fonts can write: Western European letters; anything else is "?". */
export function writable(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (
      ch === '\n' ||
      (c >= 0x20 && c <= 0x7e) ||
      (c >= 0xa0 && c <= 0xff) ||
      WIN_ANSI_EXTRA.has(ch)
    )
      out += ch;
    else if (ch === '\t' || ch === '\r') out += ' ';
    else if (ch === '‐' || ch === '‑' || ch === '−') out += '-';
    else out += '?';
  }
  return out;
}

/** Words broken into lines no wider than `width`; a word wider than the line is broken between letters. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of writable(text).split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= width) {
        line = tryLine;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let n = rest.length - 1;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

const colour = (hex: string): RGB =>
  rgb(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );

const INK = rgb(0.07, 0.09, 0.15);
const GREY = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

/** A day as words: 2026-10-28 is "October 28, 2026". */
export const dayWords = documentDay;

/** A moment as the business reads it: "Oct 28, 2026, 4:05:12 AM CDT". */
export function momentWords(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'long',
    }).format(at);
  } catch {
    return `${at.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  }
}

/** A value as the words written in its box; null for the ones drawn instead (signatures, ticks). */
export function valueText(value: DocumentValue): string | null {
  switch (value.kind) {
    case 'text':
      return value.text.trim() || null;
    case 'date':
      return dayWords(value.date);
    case 'check':
    case 'signature':
      return null;
  }
}

interface Fonts {
  readonly sans: readonly [PDFFont, PDFFont];
  readonly serif: readonly [PDFFont, PDFFont];
  readonly mono: readonly [PDFFont, PDFFont];
}

async function fontsOf(doc: PDFDocument): Promise<Fonts> {
  const [h, hb, t, tb, c, cb] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.TimesRoman),
    doc.embedFont(StandardFonts.TimesRomanBold),
    doc.embedFont(StandardFonts.Courier),
    doc.embedFont(StandardFonts.CourierBold),
  ]);
  return { sans: [h, hb], serif: [t, tb], mono: [c, cb] };
}

/** A box given as fractions of the page from its top left, in the page's own points from its bottom left. */
interface Rect {
  readonly left: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const rectOf = (page: PDFPage, b: { x: number; y: number; w: number; h: number }): Rect => {
  const { width, height } = page.getSize();
  return {
    left: b.x * width,
    bottom: height - (b.y + b.h) * height,
    width: b.w * width,
    height: b.h * height,
  };
};

const pngBytes = (dataUrl: string): Uint8Array =>
  Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

/** The words typed over a part of the page (26c): covered in its background, the new words written on it. */
function drawEdit(page: PDFPage, edit: DocumentEdit, fonts: Fonts): void {
  const r = rectOf(page, edit);
  page.drawRectangle({
    x: r.left,
    y: r.bottom,
    width: r.width,
    height: r.height,
    color: colour(edit.background),
  });
  if (!edit.text.trim()) return;
  const font = fonts[edit.font][edit.bold ? 1 : 0];
  let size = edit.size;
  let lines = wrap(edit.text, font, size, r.width);
  // Shrinks to fit the box it covers rather than spilling onto what's beside it.
  while (size > 4 && lines.length * size * 1.15 > r.height + size * 0.3) {
    size = Math.max(4, size - 0.5);
    lines = wrap(edit.text, font, size, r.width);
  }
  const ascent = font.heightAtSize(size, { descender: false });
  let y = r.bottom + r.height - ascent;
  for (const line of lines) {
    page.drawText(line, { x: r.left, y, size, font, color: colour(edit.color) });
    y -= size * 1.15;
  }
}

/** One filled-in field, drawn where the template put it. */
async function drawValue(
  doc: PDFDocument,
  page: PDFPage,
  field: DocumentField,
  value: DocumentValue,
  fonts: Fonts,
  images: Map<string, PDFImage>,
): Promise<void> {
  const r = rectOf(page, field);
  if (value.kind === 'signature') {
    let image = images.get(value.image);
    if (!image) {
      image = await doc.embedPng(pngBytes(value.image));
      images.set(value.image, image);
    }
    const scale = Math.min(r.width / image.width, r.height / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    page.drawImage(image, {
      x: r.left + (r.width - w) / 2,
      y: r.bottom + (r.height - h) / 2,
      width: w,
      height: h,
    });
    return;
  }
  if (value.kind === 'check') {
    if (!value.checked) return;
    const side = Math.min(r.width, r.height);
    const pad = side * 0.2;
    const x0 = r.left + (r.width - side) / 2 + pad;
    const y0 = r.bottom + (r.height - side) / 2 + pad;
    const s = side - 2 * pad;
    const thickness = Math.max(0.8, side * 0.09);
    page.drawLine({
      start: { x: x0, y: y0 },
      end: { x: x0 + s, y: y0 + s },
      thickness,
      color: INK,
    });
    page.drawLine({
      start: { x: x0, y: y0 + s },
      end: { x: x0 + s, y: y0 },
      thickness,
      color: INK,
    });
    return;
  }
  const text = valueText(value);
  if (!text) return;
  const font = fonts.sans[0];
  const pad = Math.min(2, r.width * 0.02);
  const width = r.width - 2 * pad;
  if (field.type === 'long_text') {
    let size = Math.min(field.fontSize, r.height);
    let lines = wrap(text, font, size, width);
    while (size > 5 && lines.length * size * 1.2 > r.height) {
      size -= 0.5;
      lines = wrap(text, font, size, width);
    }
    const ascent = font.heightAtSize(size, { descender: false });
    let y = r.bottom + r.height - ascent - pad;
    for (const line of lines) {
      if (y < r.bottom - size) break;
      page.drawText(line, { x: r.left + pad, y, size, font, color: INK });
      y -= size * 1.2;
    }
    return;
  }
  const line = writable(text).replace(/\s*\n\s*/g, ' ');
  let size = Math.min(field.fontSize, r.height * 0.85);
  while (size > 5 && font.widthOfTextAtSize(line, size) > width) size -= 0.5;
  const ascent = font.heightAtSize(size, { descender: false });
  page.drawText(line, {
    x: r.left + pad,
    y: r.bottom + (r.height - ascent) / 2,
    size,
    font,
    color: INK,
  });
}

/** The original's form fields, flattened into its pages, so their filled-in words come along. */
function flattenForm(src: PDFDocument): void {
  try {
    src.getForm().flatten();
  } catch {
    // A form pdf-lib can't flatten keeps its fields: the page itself still comes across.
  }
}

/** The PDF with everything on it, then the proof page. */
export async function buildSignedCopy(input: SignedCopyInput): Promise<Uint8Array> {
  const src = await PDFDocument.load(input.source, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  flattenForm(src);
  const doc = await PDFDocument.create();
  const fonts = await fontsOf(doc);
  const images = new Map<string, PDFImage>();
  const { definition, values, proof } = input;
  const stamp = writable(`Document ID: ${proof.documentId}`);

  const sourcePages = src.getPages();
  for (let i = 0; i < sourcePages.length; i++) {
    const sp = sourcePages[i]!;
    const crop = sp.getCropBox();
    const embedded = await doc.embedPage(sp, {
      left: crop.x,
      bottom: crop.y,
      right: crop.x + crop.width,
      top: crop.y + crop.height,
    });
    const turn = (((sp.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    const sideways = turn === 90 || turn === 270;
    const w = crop.width;
    const h = crop.height;
    const page = doc.addPage(sideways ? [h, w] : [w, h]);
    // A page shown turned (its /Rotate) is drawn turned the same way, onto a page the shape it shows.
    if (turn === 0) page.drawPage(embedded, { x: 0, y: 0 });
    else if (turn === 90) page.drawPage(embedded, { x: 0, y: w, rotate: degrees(-90) });
    else if (turn === 180) page.drawPage(embedded, { x: w, y: h, rotate: degrees(180) });
    else page.drawPage(embedded, { x: h, y: 0, rotate: degrees(90) });

    for (const edit of definition.edits) if (edit.page === i) drawEdit(page, edit, fonts);
    for (const field of definition.fields) {
      if (field.page !== i) continue;
      const value = values[field.id];
      if (value) await drawValue(doc, page, field, value, fonts, images);
    }
    const { height } = page.getSize();
    page.drawText(stamp, { x: 8, y: height - 9, size: 6, font: fonts.sans[0], color: GREY });
  }

  await drawProof(doc, fonts, images, input);

  doc.setTitle(writable(proof.documentName));
  doc.setSubject(writable(`${PROOF_WORDS.title}: ${proof.documentName}`));
  doc.setProducer('HandsFreeOS');
  doc.setCreator('HandsFreeOS');
  doc.setCreationDate(proof.completedAt);
  doc.setModificationDate(proof.completedAt);
  return doc.save();
}

// ---------- the proof page ----------

const LETTER: [number, number] = [612, 792];
const MARGIN = 54;

/** Writes lines down the page, starting another page when one fills. */
class ProofWriter {
  page!: PDFPage;
  y = 0;
  readonly width = LETTER[0] - 2 * MARGIN;

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
    private readonly footer: string,
  ) {
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage(LETTER);
    this.y = LETTER[1] - MARGIN;
    const font = this.fonts.sans[0];
    this.page.drawText(writable(this.footer), {
      x: MARGIN,
      y: MARGIN / 2,
      size: 7,
      font,
      color: GREY,
    });
  }

  need(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  text(
    words: string,
    opts: {
      size?: number;
      bold?: boolean;
      mono?: boolean;
      color?: RGB;
      indent?: number;
      after?: number;
    } = {},
  ): void {
    const size = opts.size ?? 9.5;
    const font = (opts.mono ? this.fonts.mono : this.fonts.sans)[opts.bold ? 1 : 0];
    const indent = opts.indent ?? 0;
    for (const line of wrap(words, font, size, this.width - indent)) {
      this.need(size * 1.35);
      this.y -= size * 1.35;
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y,
        size,
        font,
        color: opts.color ?? INK,
      });
    }
    this.y -= opts.after ?? 0;
  }

  /** "Label: value", the label in grey. */
  pair(label: string, value: string, opts: { mono?: boolean; indent?: number } = {}): void {
    const size = 9.5;
    const indent = opts.indent ?? 0;
    const labelFont = this.fonts.sans[0];
    const shown = writable(`${label}: `);
    const font = (opts.mono ? this.fonts.mono : this.fonts.sans)[0];
    const fits =
      labelFont.widthOfTextAtSize(shown, size) + font.widthOfTextAtSize(writable(value), size);
    // A long label with a long value (the fingerprint) puts the value on the line below it.
    if (fits > this.width - indent && labelFont.widthOfTextAtSize(shown, size) > 140) {
      this.text(label, { indent, color: GREY });
      this.text(value, { indent: indent + 8, mono: opts.mono, size: opts.mono ? 8.5 : size });
      return;
    }
    const labelWidth = labelFont.widthOfTextAtSize(shown, size);
    const lines = wrap(value, font, opts.mono ? 8.5 : size, this.width - indent - labelWidth);
    lines.forEach((line, n) => {
      this.need(size * 1.35);
      this.y -= size * 1.35;
      if (n === 0)
        this.page.drawText(shown, {
          x: MARGIN + indent,
          y: this.y,
          size,
          font: labelFont,
          color: GREY,
        });
      this.page.drawText(line, {
        x: MARGIN + indent + labelWidth,
        y: this.y,
        size: opts.mono ? 8.5 : size,
        font,
        color: INK,
      });
    });
  }

  rule(): void {
    this.need(14);
    this.y -= 8;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + this.width, y: this.y },
      thickness: 0.6,
      color: RULE,
    });
    this.y -= 6;
  }

  image(image: PDFImage, maxWidth: number, maxHeight: number, indent: number): void {
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    this.need(h + 6);
    this.y -= h + 4;
    this.page.drawImage(image, { x: MARGIN + indent, y: this.y, width: w, height: h });
    this.y -= 2;
  }
}

/** One step of the trail as a line: "Link sent by email · Oct 28, 2026, 4:05:12 AM CDT · from 203.0.113.9". */
export function stepLine(step: ProofStep, timeZone: string): string {
  const what =
    step.kind === 'sent' ||
    step.kind === 'reminded' ||
    step.kind === 'code_sent' ||
    step.kind === 'copy_sent'
      ? `${DOCUMENT_STEP_LABELS[step.kind]}${step.channel ? ` by ${DOCUMENT_CHANNEL_LABELS[step.channel]}` : ''}`
      : DOCUMENT_STEP_LABELS[step.kind];
  return [
    what,
    momentWords(step.at, timeZone),
    ...(step.ip ? [`${PROOF_WORDS.from} ${step.ip}`] : []),
  ].join(' · ');
}

async function drawProof(
  doc: PDFDocument,
  fonts: Fonts,
  images: Map<string, PDFImage>,
  input: SignedCopyInput,
): Promise<void> {
  const { proof, definition } = input;
  const tz = proof.timeZone;
  const w = new ProofWriter(
    doc,
    fonts,
    `${PROOF_WORDS.title} · ${proof.documentName} · ${SIGNING_WORDS.poweredBy}`,
  );
  w.text(PROOF_WORDS.title, { size: 18, bold: true, after: 8 });
  w.pair(PROOF_WORDS.document, proof.documentName);
  w.pair(PROOF_WORDS.documentId, proof.documentId, { mono: true });
  w.pair(
    PROOF_WORDS.business,
    proof.sentBy ? `${proof.sentBy}, ${proof.business}` : proof.business,
  );
  w.pair(PROOF_WORDS.sent, momentWords(proof.sentAt, tz));
  w.pair(PROOF_WORDS.completed, momentWords(proof.completedAt, tz));
  w.pair(PROOF_WORDS.original, proof.sourceSha256, { mono: true });

  // Answer 26c: the words the team typed over before it went, so nobody has to take the copy's word for them.
  const changed = definition.edits.filter((e) => e.original.trim() || e.text.trim());
  if (changed.length) {
    w.rule();
    w.text('Words changed on the original before it was sent', { bold: true, size: 11, after: 2 });
    for (const e of changed)
      w.text(
        `Page ${e.page + 1}: “${e.original.trim() || '(blank)'}” became “${e.text.trim() || '(taken out)'}”`,
        { indent: 8 },
      );
  }

  let n = 0;
  for (const s of proof.signers) {
    w.rule();
    const heading =
      s.kind === 'signer' ? `${PROOF_WORDS.signer} ${++n}: ${s.name}` : `Got a copy: ${s.name}`;
    w.text(heading, { bold: true, size: 11, after: 2 });
    if (s.roleLabel && s.kind === 'signer') w.pair(PROOF_WORDS.role, s.roleLabel, { indent: 8 });
    const reached = [s.email, s.phone].filter(Boolean).join(' · ');
    if (reached) w.pair(PROOF_WORDS.contact, reached, { indent: 8 });
    for (const step of s.steps) w.text(stepLine(step, tz), { indent: 8 });
    const device = [...s.steps].reverse().find((x) => x.kind === 'signed' && x.device)?.device;
    if (device) w.pair(PROOF_WORDS.device, device, { indent: 8 });
    const signature = proof.signatures[s.id];
    if (signature?.kind === 'signature') {
      let image = images.get(signature.image);
      if (!image) {
        image = await doc.embedPng(pngBytes(signature.image));
        images.set(signature.image, image);
      }
      w.image(image, 160, 48, 8);
    }
    if (s.agreedWording)
      w.text(`${PROOF_WORDS.agreed}: “${s.agreedWording}”`, { indent: 8, size: 8.5, color: GREY });
  }
  w.rule();
  w.text(PROOF_WORDS.footer, { size: 8.5, color: GREY });
}
