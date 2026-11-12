/**
 * Drawing the AI's designs (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decisions 14 and 39;
 * docs/socialcontent.md, "Making posts"): each page of a design Claude wrote
 * (packages/core/src/addons/socialcontent/posts-ai.ts) as a 1080x1350 picture, the 4:5 portrait Instagram, Facebook
 * and LinkedIn all show whole. Words are drawn here, never by an image model, so they're spelled right.
 *
 * Twelve layouts, so the pictures look like the owner made them in Canva rather than all alike (the owner, 12 Nov):
 * **bold**, **clean**, **split**, **number** (one big stat), **list** (items with ticks), **quote**, **myth** (crossed
 * out, then the truth), **beforeAfter**, **note** (a handwritten sticky note), **highlight** (words painted over with
 * a highlighter), and two with the photo OpenAI made under the words: **photo** (it fills the page) and **framed** (it
 * sits above a band of words). Four font pairs (modern, classic, loud, friendly) and a handwriting one for notes are
 * shipped with the worker (@fontsource): the server has no fonts of its own.
 */
import { createRequire } from 'node:module';
import type {
  Design,
  DesignFont,
  DesignPage,
  DesignStyle,
} from '@hfos/core/addons/socialcontent/posts-ai';
import type * as CanvasLib from '@napi-rs/canvas';

export const PICTURE_WIDTH = 1080;
export const PICTURE_HEIGHT = 1350;
const W = PICTURE_WIDTH;
const H = PICTURE_HEIGHT;
const PAD = 96;
const INNER = W - PAD * 2;

type Canvas = typeof CanvasLib;
type Ctx2d = ReturnType<ReturnType<Canvas['createCanvas']>['getContext']>;
type Img = Awaited<ReturnType<Canvas['loadImage']>>;

/** The fonts shipped with the worker, each registered once under its own name. */
const FAMILIES = [
  { name: 'HfosInter', pkg: 'inter', weights: [400, 700, 800] },
  { name: 'HfosPlayfair', pkg: 'playfair-display', weights: [700, 800] },
  { name: 'HfosOswald', pkg: 'oswald', weights: [500, 700] },
  { name: 'HfosPoppins', pkg: 'poppins', weights: [400, 600, 700, 800] },
  { name: 'HfosCaveat', pkg: 'caveat', weights: [600, 700] },
] as const;

/** How each font pair writes: the heading's font and weight, the body's, and whether headings are in capitals. */
interface Type {
  readonly head: string;
  readonly headWeight: number;
  readonly body: string;
  readonly bodyWeight: number;
  readonly strong: number;
  readonly upper: boolean;
  readonly lead: number;
}
const TYPES: Readonly<Record<DesignFont, Type>> = {
  modern: {
    head: 'HfosInter',
    headWeight: 800,
    body: 'HfosInter',
    bodyWeight: 400,
    strong: 700,
    upper: false,
    lead: 1.12,
  },
  classic: {
    head: 'HfosPlayfair',
    headWeight: 700,
    body: 'HfosInter',
    bodyWeight: 400,
    strong: 700,
    upper: false,
    lead: 1.16,
  },
  loud: {
    head: 'HfosOswald',
    headWeight: 700,
    body: 'HfosInter',
    bodyWeight: 400,
    strong: 700,
    upper: true,
    lead: 1.08,
  },
  friendly: {
    head: 'HfosPoppins',
    headWeight: 700,
    body: 'HfosPoppins',
    bodyWeight: 400,
    strong: 600,
    upper: false,
    lead: 1.16,
  },
};
const HAND = 'HfosCaveat';

let loaded: Promise<Canvas> | null = null;
/** The canvas library, with the fonts registered once. */
function canvasLib(): Promise<Canvas> {
  loaded ??= import('@napi-rs/canvas').then((lib) => {
    const req = createRequire(import.meta.url);
    for (const f of FAMILIES)
      for (const weight of f.weights)
        lib.GlobalFonts.registerFromPath(
          req.resolve(`@fontsource/${f.pkg}/files/${f.pkg}-latin-${weight}-normal.woff2`),
          f.name,
        );
    return lib;
  });
  return loaded;
}

/**
 * Words the fonts can draw: arrows become ›, and emoji and other symbols they have no shape for are left out (the
 * fonts hold Latin letters, numbers and punctuation, with ©, ® and ™).
 */
export function drawable(s: string | null): string {
  return (s ?? '')
    .replace(/[←-⇿➡⬅-⬇]/g, '›')
    .replace(/(?![©®™])[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[^\s -ɏ -⁯€™]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const font = (weight: number, size: number, family: string) => `${weight} ${size}px ${family}`;

/** Lines of words that fit `width` at the font set now; a word wider than the line is cut to fit. */
function wrap(ctx: Ctx2d, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const tryLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(tryLine).width <= width) {
      line = tryLine;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (ctx.measureText(line).width > width && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && ctx.measureText(`${line.slice(0, cut)}-`).width > width) cut--;
      lines.push(`${line.slice(0, cut)}-`);
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface Fitted {
  readonly size: number;
  readonly lines: string[];
}

/** The biggest size, from `most` down to `least`, at which `text` fits `width` in at most `maxLines` lines. */
function fit(
  ctx: Ctx2d,
  text: string,
  weight: number,
  family: string,
  most: number,
  least: number,
  width: number,
  maxLines: number,
): Fitted {
  for (let size = most; size >= least; size -= 4) {
    ctx.font = font(weight, size, family);
    const lines = wrap(ctx, text, width);
    if (lines.length <= maxLines) return { size, lines };
  }
  ctx.font = font(weight, least, family);
  return { size: least, lines: wrap(ctx, text, width).slice(0, Math.max(1, maxLines)) };
}

const linesHeight = (f: Fitted, lead: number) => f.size + (f.lines.length - 1) * f.size * lead;

/** Draws lines from `y` (the top of the first line); the top of what comes after. */
function drawLines(
  ctx: Ctx2d,
  lines: readonly string[],
  x: number,
  y: number,
  size: number,
  lead: number,
): number {
  for (const [i, l] of lines.entries()) ctx.fillText(l, x, y + size * 0.92 + i * size * lead);
  return y + size + (lines.length - 1) * size * lead;
}

// ------------------------------------------------------------------------------------------------ colours

/** WCAG relative brightness of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};
/** White or near black, whichever reads on `bg`. */
const wordsOn = (bg: string) =>
  contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111';
/** `want` where it reads on `bg`, else white or near black. */
const readable = (want: string, bg: string, least = 4.5) =>
  contrast(want, bg) >= least ? want : wordsOn(bg);
/** The accent where it shows on `bg`, else the words' colour. */
const accentOn = (accent: string, bg: string, words: string) =>
  contrast(accent, bg) >= 3 ? accent : words;
/** `a` moved `t` of the way to `b`. */
function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
const isDark = (hex: string) => luminance(hex) < 0.2;

/** A small, steady number from the words, so two pages of one layout aren't laid out exactly alike. */
function seedOf(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// ------------------------------------------------------------------------------------------------ pieces

interface Page {
  readonly ctx: Ctx2d;
  readonly d: Design;
  readonly type: Type;
  readonly kicker: string;
  readonly heading: string;
  readonly body: string;
  readonly footer: string;
  readonly items: readonly string[];
  readonly mark: string;
  readonly seed: number;
}

/** A kicker as a rounded label: the bottom of it. */
function pill(
  ctx: Ctx2d,
  t: Type,
  text: string,
  x: number,
  y: number,
  bg: string,
  align: 'left' | 'center' = 'left',
): number {
  ctx.font = font(t.strong, 30, t.body);
  const w = Math.min(INNER, ctx.measureText(text).width + 56);
  const left = align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y, w, 58, 29);
  ctx.fill();
  ctx.fillStyle = wordsOn(bg);
  ctx.textAlign = 'center';
  ctx.fillText(text, left + w / 2, y + 40, w - 40);
  ctx.textAlign = 'left';
  return y + 58;
}

interface Block {
  readonly x: number;
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
  readonly heading: string;
  readonly kicker?: string;
  readonly body?: string;
  readonly headColor: string;
  readonly bodyColor: string;
  readonly kickerColor: string;
  /** The kicker as a label on this colour, not a line of words. */
  readonly kickerPill?: string;
  readonly align?: 'left' | 'center';
  readonly valign?: 'top' | 'middle' | 'bottom';
  readonly headMost?: number;
  readonly headFamily?: string;
  readonly headWeight?: number;
  readonly upper?: boolean;
  readonly bodyMost?: number;
  readonly bodyFamily?: string;
  readonly bodyWeight?: number;
  /** Only measured: where it would end, nothing drawn. */
  readonly dry?: boolean;
}

/** A kicker, a heading and a body, measured to fit the room, then drawn; where it ended. */
function textBlock(ctx: Ctx2d, t: Type, b: Block): number {
  const align = b.align ?? 'left';
  const x = align === 'center' ? b.x + b.width / 2 : b.x;
  const room = b.bottom - b.top;
  const headFamily = b.headFamily ?? t.head;
  const headWeight = b.headWeight ?? t.headWeight;
  const heading = (b.upper ?? t.upper) ? b.heading.toUpperCase() : b.heading;
  const kicker = (b.kicker ?? '').toUpperCase();

  ctx.font = font(t.strong, 32, t.body);
  const kickerLines = kicker && !b.kickerPill ? wrap(ctx, kicker, b.width).slice(0, 2) : [];
  const kickerHeight = kicker
    ? b.kickerPill
      ? 58 + 32
      : 32 + (kickerLines.length - 1) * 32 * 1.3 + 28
    : 0;
  const most = b.headMost ?? (b.body ? 100 : 124);
  const bodyMost = b.bodyMost ?? 44;
  const bodyReserve = b.body ? Math.min(room * 0.42, bodyMost * 1.4 * 4) : 0;
  const headRoom = Math.max(most, room - kickerHeight - bodyReserve);
  const h = fit(
    ctx,
    heading,
    headWeight,
    headFamily,
    most,
    40,
    b.width,
    Math.max(2, Math.floor(headRoom / (most * t.lead))),
  );
  const headHeight = linesHeight(h, t.lead);
  let body: Fitted | null = null;
  if (b.body) {
    const bodyRoom = room - kickerHeight - headHeight - 40;
    body = fit(
      ctx,
      b.body,
      b.bodyWeight ?? t.bodyWeight,
      b.bodyFamily ?? t.body,
      bodyMost,
      28,
      b.width,
      Math.max(1, Math.floor(bodyRoom / (bodyMost * 1.4))),
    );
  }
  const total = kickerHeight + headHeight + (body ? 40 + linesHeight(body, 1.4) : 0);
  const valign = b.valign ?? 'middle';
  if (b.dry) return (valign === 'top' ? b.top : b.bottom) + (valign === 'top' ? total : 0);
  let y =
    valign === 'top'
      ? b.top
      : valign === 'bottom'
        ? Math.max(b.top, b.bottom - total)
        : b.top + Math.max(0, (room - total) / 2);

  ctx.textAlign = align;
  if (kicker && b.kickerPill) {
    y = pill(ctx, t, kicker, x, y, b.kickerPill, align) + 32;
    ctx.textAlign = align;
  } else if (kickerLines.length) {
    ctx.font = font(t.strong, 32, t.body);
    ctx.fillStyle = b.kickerColor;
    y = drawLines(ctx, kickerLines, x, y, 32, 1.3) + 28;
  }
  ctx.font = font(headWeight, h.size, headFamily);
  ctx.fillStyle = b.headColor;
  y = drawLines(ctx, h.lines, x, y, h.size, t.lead);
  if (body) {
    ctx.font = font(b.bodyWeight ?? t.bodyWeight, body.size, b.bodyFamily ?? t.body);
    ctx.fillStyle = b.bodyColor;
    y = drawLines(ctx, body.lines, x, y + 40, body.size, 1.4);
  }
  ctx.textAlign = 'left';
  return y;
}

function footerLine(p: Page, color: string, align: 'left' | 'center' = 'left'): void {
  if (!p.footer) return;
  const { ctx, type } = p;
  ctx.font = font(type.strong, 30, type.body);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.textAlign = align;
  const [line] = wrap(ctx, p.footer, INNER);
  ctx.fillText(line ?? '', align === 'center' ? W / 2 : PAD, H - PAD + 10);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

function pageNumber(p: Page, n: number, of: number, color: string): void {
  if (of <= 1) return;
  const { ctx, type } = p;
  ctx.font = font(type.strong, 30, type.body);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.textAlign = 'right';
  ctx.fillText(`${n}/${of}`, W - PAD, PAD + 20);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

function fill(ctx: Ctx2d, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
}

/** The photo, cut to cover the box from its middle. */
function cover(ctx: Ctx2d, img: Img, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/** A tick in a rounded box. */
function tick(ctx: Ctx2d, x: number, y: number, size: number, bg: string): void {
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, size * 0.28);
  ctx.fill();
  ctx.strokeStyle = wordsOn(bg);
  ctx.lineWidth = size * 0.13;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.26, y + size * 0.52);
  ctx.lineTo(x + size * 0.43, y + size * 0.69);
  ctx.lineTo(x + size * 0.75, y + size * 0.33);
  ctx.stroke();
}

// ------------------------------------------------------------------------------------------------ layouts

function drawBold(p: Page): void {
  const { ctx, d } = p;
  fill(ctx, d.background);
  // A soft shape in the accent, in one of three places, the way a template would have it.
  ctx.fillStyle = d.accent;
  ctx.globalAlpha = contrast(d.accent, d.background) < 1.4 ? 0.22 : 0.16;
  const where = p.seed % 3;
  ctx.beginPath();
  if (where === 0) ctx.arc(W - 40, 120, 360, 0, Math.PI * 2);
  else if (where === 1) ctx.arc(80, H - 60, 380, 0, Math.PI * 2);
  else {
    ctx.moveTo(W, H * 0.55);
    ctx.lineTo(W, H);
    ctx.lineTo(W * 0.35, H);
    ctx.closePath();
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = accentOn(d.accent, d.background, d.text);
  ctx.fillRect(PAD, PAD, 120, 14);
  textBlock(ctx, p.type, {
    x: PAD,
    width: INNER,
    top: PAD + 70,
    bottom: H - PAD - 100,
    heading: p.heading,
    kicker: p.kicker,
    body: p.body,
    headColor: d.text,
    bodyColor: d.text,
    kickerColor: accentOn(d.accent, d.background, d.text),
  });
}

function drawClean(p: Page): void {
  const { ctx, d } = p;
  fill(ctx, d.background);
  ctx.fillStyle = d.accent;
  ctx.fillRect(0, 0, 28, H);
  // A small grid of dots in the corner.
  ctx.fillStyle = accentOn(d.accent, d.background, d.text);
  ctx.globalAlpha = 0.35;
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 5; c++) {
      ctx.beginPath();
      ctx.arc(W - PAD - c * 30, PAD + 70 + r * 30, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  ctx.globalAlpha = 1;
  const end = textBlock(ctx, p.type, {
    x: PAD,
    width: INNER - 40,
    top: PAD + 60,
    bottom: H - PAD - 120,
    heading: p.heading,
    kicker: p.kicker,
    body: p.body,
    headColor: d.text,
    bodyColor: d.text,
    kickerColor: accentOn(d.accent, d.background, d.text),
  });
  if (!p.body) {
    ctx.fillStyle = accentOn(d.accent, d.background, d.text);
    ctx.fillRect(PAD, Math.min(end + 36, H - PAD - 100), 160, 10);
  }
}

function drawSplit(p: Page): void {
  const { ctx, d } = p;
  const cut = Math.round(H * (p.body ? 0.56 : 0.66));
  fill(ctx, d.background);
  ctx.fillStyle = d.accent;
  ctx.fillRect(0, 0, W, cut);
  const onAccent = wordsOn(d.accent);
  textBlock(ctx, p.type, {
    x: PAD,
    width: INNER,
    top: PAD + 40,
    bottom: cut - 64,
    heading: p.heading,
    kicker: p.kicker,
    headColor: onAccent,
    bodyColor: onAccent,
    kickerColor: onAccent,
    valign: 'bottom',
    headMost: 104,
  });
  if (p.body)
    textBlock(ctx, p.type, {
      x: PAD,
      width: INNER,
      top: cut + 64,
      bottom: H - PAD - (p.footer ? 80 : 0),
      heading: p.body,
      headColor: readable(d.text, d.background),
      bodyColor: readable(d.text, d.background),
      kickerColor: d.text,
      valign: 'top',
      headMost: 46,
      headFamily: p.type.body,
      headWeight: p.type.bodyWeight,
      upper: false,
    });
}

function drawNumber(p: Page): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  const big = accentOn(d.accent, d.background, d.text);
  let y = PAD + 60;
  if (p.kicker) y = pill(ctx, type, p.kicker.toUpperCase(), W / 2, y, d.accent, 'center') + 40;
  const mark = fit(ctx, p.mark, type.headWeight, type.head, 320, 120, INNER, 1);
  ctx.font = font(type.headWeight, mark.size, type.head);
  ctx.fillStyle = big;
  ctx.textAlign = 'center';
  const markTop = Math.max(y, H * 0.2);
  ctx.fillText(mark.lines[0] ?? '', W / 2, markTop + mark.size * 0.9);
  const markWidth = Math.min(INNER, ctx.measureText(mark.lines[0] ?? '').width);
  ctx.textAlign = 'left';
  ctx.fillStyle = big;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(W / 2 - markWidth * 0.3, markTop + mark.size * 1.02, markWidth * 0.6, 12);
  ctx.globalAlpha = 1;
  textBlock(ctx, type, {
    x: PAD,
    width: INNER,
    top: markTop + mark.size * 1.02 + 60,
    bottom: H - PAD - 90,
    heading: p.heading,
    body: p.body,
    headColor: d.text,
    bodyColor: d.text,
    kickerColor: d.text,
    align: 'center',
    valign: 'top',
    headMost: 76,
    bodyMost: 40,
  });
}

function drawList(p: Page): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  const box = accentOn(d.accent, d.background, d.text);
  const heading = (top: number, dry: boolean) =>
    textBlock(ctx, type, {
      x: PAD,
      width: INNER,
      top,
      bottom: top + H * 0.34,
      heading: p.heading,
      kicker: p.kicker,
      headColor: d.text,
      bodyColor: d.text,
      kickerColor: box,
      valign: 'top',
      headMost: 88,
      dry,
    });
  const headHeight = heading(0, true);
  const bottom = H - PAD - (p.footer ? 90 : 20);
  const textX = PAD + 84;
  const width = INNER - 84;
  const room = (bottom - (PAD + 40 + headHeight + 64)) / p.items.length;
  let size = p.items.length <= 3 ? 52 : 46;
  for (; size > 28; size -= 2) {
    ctx.font = font(type.strong, size, type.body);
    if (p.items.every((i) => wrap(ctx, i, width).length * size * 1.3 <= room - 24)) break;
  }
  ctx.font = font(type.strong, size, type.body);
  const tallest = Math.max(...p.items.map((i) => wrap(ctx, i, width).slice(0, 3).length));
  const each = Math.min(room, Math.max(56, tallest * size * 1.3) + 56);
  const total = headHeight + 64 + each * p.items.length - 56;
  const start = Math.max(PAD + 40, PAD + 40 + (bottom - PAD - 40 - total) / 2.4);
  const top = heading(start, false) + 64;
  for (const [i, item] of p.items.entries()) {
    const y = top + i * each;
    tick(ctx, PAD, y + 2, 56, box);
    ctx.font = font(type.strong, size, type.body);
    ctx.fillStyle = d.text;
    drawLines(
      ctx,
      wrap(ctx, item, width).slice(0, 3),
      textX,
      y + Math.max(0, (56 - size) / 2),
      size,
      1.3,
    );
  }
}

function drawQuote(p: Page): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  const mark = accentOn(d.accent, d.background, d.text);
  ctx.font = font(800, 420, 'HfosPlayfair');
  ctx.fillStyle = mark;
  ctx.globalAlpha = 0.9;
  ctx.fillText('“', PAD - 20, PAD + 330);
  ctx.globalAlpha = 1;
  const end = textBlock(ctx, type, {
    x: PAD,
    width: INNER,
    top: PAD + 300,
    bottom: H - PAD - 170,
    heading: p.heading,
    body: p.body,
    headColor: d.text,
    bodyColor: d.text,
    kickerColor: d.text,
    valign: 'top',
    headMost: 84,
    upper: false,
    headFamily: type.head === 'HfosOswald' ? 'HfosInter' : type.head,
  });
  if (p.kicker) {
    ctx.fillStyle = mark;
    ctx.fillRect(PAD, end + 56, 64, 8);
    ctx.font = font(type.strong, 34, type.body);
    ctx.fillStyle = d.text;
    ctx.fillText(p.kicker, PAD + 88, end + 72, INNER - 88);
  }
}

function drawMyth(p: Page): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  const muted = mix(d.text, d.background, 0.45);
  const myth = fit(ctx, p.heading, type.headWeight, type.head, 76, 40, INNER, 4);
  const onCard = wordsOn(d.accent);
  const truth = (top: number, bottom: number, dry: boolean) =>
    textBlock(ctx, type, {
      x: PAD + 24,
      width: INNER - 48,
      top,
      bottom,
      heading: p.body,
      kicker: 'Truth',
      kickerPill:
        onCard === '#ffffff' ? mix(d.accent, '#000000', 0.35) : mix(d.accent, '#ffffff', 0.5),
      headColor: onCard,
      bodyColor: onCard,
      kickerColor: onCard,
      valign: 'top',
      headMost: 56,
      upper: false,
      dry,
    });
  const most = H - PAD - (p.footer ? 80 : 0);
  const mythHeight = 58 + 36 + linesHeight(myth, type.lead) + 70;
  const cardWords = truth(0, most - PAD - mythHeight - 96, true);
  const cardHeight = Math.max(320, cardWords + 96);
  let y = PAD + Math.max(30, (most - PAD - mythHeight - cardHeight) / 2);
  y =
    pill(ctx, type, (p.kicker || 'Myth').toUpperCase(), PAD, y, mix(d.background, d.text, 0.75)) +
    36;
  ctx.font = font(type.headWeight, myth.size, type.head);
  ctx.fillStyle = muted;
  for (const [i, line] of myth.lines.entries()) {
    const top = y + i * myth.size * type.lead;
    ctx.fillText(line, PAD, top + myth.size * 0.9);
    const w = ctx.measureText(line).width;
    ctx.fillStyle = accentOn(d.accent, d.background, d.text);
    ctx.fillRect(PAD - 8, top + myth.size * 0.52, w + 16, Math.max(6, myth.size * 0.09));
    ctx.fillStyle = muted;
  }
  y += linesHeight(myth, type.lead) + 70;
  const cardBottom = Math.min(most, y + cardHeight);
  ctx.fillStyle = d.accent;
  ctx.beginPath();
  ctx.roundRect(PAD - 32, y, INNER + 64, cardBottom - y, 40);
  ctx.fill();
  truth(y + 48, cardBottom - 48, false);
}

function drawBeforeAfter(p: Page): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  const end = textBlock(ctx, type, {
    x: PAD,
    width: INNER,
    top: PAD + 30,
    bottom: H * 0.3,
    heading: p.heading,
    kicker: p.kicker,
    headColor: d.text,
    bodyColor: d.text,
    kickerColor: accentOn(d.accent, d.background, d.text),
    valign: 'top',
    headMost: 80,
  });
  const top = end + 56;
  const bottom = H - PAD - (p.footer ? 80 : 0);
  const gap = 90;
  const cardH = (bottom - top - gap) / 2;
  const sides = [
    { label: 'Before', text: p.items[0] ?? '', bg: mix(d.background, d.text, 0.08) },
    { label: 'After', text: p.items[1] ?? '', bg: d.accent },
  ];
  for (const [i, side] of sides.entries()) {
    const y = top + i * (cardH + gap);
    ctx.fillStyle = side.bg;
    ctx.beginPath();
    ctx.roundRect(PAD - 24, y, INNER + 48, cardH, 36);
    ctx.fill();
    const words = i === 0 ? readable(d.text, side.bg) : wordsOn(side.bg);
    textBlock(ctx, type, {
      x: PAD + 16,
      width: INNER - 32,
      top: y + 36,
      bottom: y + cardH - 36,
      heading: side.text,
      kicker: side.label,
      headColor: words,
      bodyColor: words,
      kickerColor: words,
      valign: 'middle',
      headMost: 58,
      upper: false,
    });
  }
  // An arrow down between them.
  const ay = top + cardH + gap / 2;
  ctx.fillStyle = accentOn(d.accent, d.background, d.text);
  ctx.beginPath();
  ctx.moveTo(W / 2 - 34, ay - 18);
  ctx.lineTo(W / 2 + 34, ay - 18);
  ctx.lineTo(W / 2, ay + 22);
  ctx.closePath();
  ctx.fill();
}

function drawNote(p: Page): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  // Dots on the background, like a desk mat.
  ctx.fillStyle = wordsOn(d.background);
  ctx.globalAlpha = 0.08;
  for (let y = 40; y < H; y += 54)
    for (let x = 40; x < W; x += 54) {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  ctx.globalAlpha = 1;
  const yellow = luminance(d.background) > 0.7 && contrast(d.background, '#fff1a6') < 1.15;
  const paper = yellow ? '#ffd6e0' : '#fff1a6';
  const size = 860;
  const top = 190;
  ctx.save();
  ctx.translate(W / 2, top + size / 2);
  ctx.rotate(((p.seed % 2 ? -1 : 1) * 2.5 * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.fillStyle = paper;
  ctx.fillRect(-size / 2, -size / 2, size, size);
  ctx.shadowColor = 'transparent';
  // A strip of tape across the top.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(-110, -size / 2 - 30, 220, 64);
  textBlock(ctx, type, {
    x: -size / 2 + 80,
    width: size - 160,
    top: -size / 2 + 90,
    bottom: size / 2 - 80,
    heading: p.heading,
    kicker: p.kicker,
    body: p.body,
    headColor: '#1d1d1f',
    bodyColor: '#2b2b2b',
    kickerColor: '#7a5c00',
    headFamily: HAND,
    headWeight: 700,
    upper: false,
    headMost: 120,
    bodyFamily: HAND,
    bodyWeight: 600,
    bodyMost: 58,
  });
  ctx.restore();
}

function drawHighlight(p: Page): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  const heading = type.upper ? p.heading.toUpperCase() : p.heading;
  const words = heading.split(' ');
  const want = (type.upper ? p.mark.toUpperCase() : p.mark).split(' ').filter(Boolean);
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let start = -1;
  for (let i = 0; i + want.length <= words.length && start < 0; i++)
    if (want.every((w, k) => norm(words[i + k]!) === norm(w))) start = i;
  const marked = new Set(start < 0 ? [] : want.map((_, k) => start + k));
  let y = PAD + 80;
  if (p.kicker) {
    ctx.font = font(type.strong, 32, type.body);
    ctx.fillStyle = accentOn(d.accent, d.background, d.text);
    ctx.fillText(p.kicker.toUpperCase(), PAD, y + 30, INNER);
    y += 80;
  }
  const h = fit(ctx, heading, type.headWeight, type.head, 120, 48, INNER, 6);
  const blockH = linesHeight(h, type.lead) + (p.body ? 300 : 0);
  y = Math.max(y, (H - blockH) / 2 - 40);
  ctx.font = font(type.headWeight, h.size, type.head);
  let w = 0;
  const space = ctx.measureText(' ').width;
  // The highlight covers the whole word, so the words on it never sit half on the background.
  const tall = ctx.measureText('Hgy');
  const up = tall.actualBoundingBoxAscent + h.size * 0.06;
  const down = tall.actualBoundingBoxDescent + h.size * 0.04;
  for (const [li, line] of h.lines.entries()) {
    const base = y + h.size * 0.9 + li * h.size * type.lead;
    let x = PAD;
    for (const word of line.split(' ')) {
      const ww = ctx.measureText(word).width;
      const on = marked.has(w);
      if (on) {
        ctx.fillStyle = d.accent;
        ctx.beginPath();
        ctx.roundRect(x - 12, base - up, ww + 24, up + down, 10);
        ctx.fill();
      }
      ctx.fillStyle = on ? wordsOn(d.accent) : d.text;
      ctx.fillText(word, x, base);
      x += ww + space;
      w++;
    }
  }
  if (p.body)
    textBlock(ctx, type, {
      x: PAD,
      width: INNER,
      top: y + linesHeight(h, type.lead) + 56,
      bottom: H - PAD - 90,
      heading: p.body,
      headColor: d.text,
      bodyColor: d.text,
      kickerColor: d.text,
      valign: 'top',
      headMost: 44,
      headFamily: type.body,
      headWeight: type.bodyWeight,
      upper: false,
    });
}

function drawPhoto(p: Page, img: Img): void {
  const { ctx, d, type } = p;
  cover(ctx, img, 0, 0, W, H);
  const shade = ctx.createLinearGradient(0, H * 0.3, 0, H);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(0.55, 'rgba(0,0,0,0.55)');
  shade.addColorStop(1, 'rgba(0,0,0,0.85)');
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
  textBlock(ctx, type, {
    x: PAD,
    width: INNER,
    top: H * 0.42,
    bottom: H - PAD - (p.footer ? 80 : 20),
    heading: p.heading,
    kicker: p.kicker,
    kickerPill: d.accent,
    body: p.body,
    headColor: '#ffffff',
    bodyColor: '#f2f2f2',
    kickerColor: '#ffffff',
    valign: 'bottom',
    headMost: 96,
    bodyMost: 38,
  });
}

function drawFramed(p: Page, img: Img): void {
  const { ctx, d, type } = p;
  fill(ctx, d.background);
  const frame = { x: 56, y: 56, w: W - 112, h: Math.round(H * 0.56) };
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(frame.x, frame.y, frame.w, frame.h, 36);
  ctx.clip();
  cover(ctx, img, frame.x, frame.y, frame.w, frame.h);
  ctx.restore();
  let top = frame.y + frame.h + 56;
  if (p.kicker)
    top = pill(ctx, type, p.kicker.toUpperCase(), PAD, frame.y + frame.h - 29, d.accent) + 40;
  textBlock(ctx, type, {
    x: PAD,
    width: INNER,
    top,
    bottom: H - PAD - (p.footer ? 70 : 0),
    heading: p.heading,
    body: p.body,
    headColor: d.text,
    bodyColor: d.text,
    kickerColor: d.text,
    valign: 'top',
    headMost: 80,
    bodyMost: 38,
  });
}

/** The colour the page number and footer are drawn in, on each layout. */
function edgeColor(layout: DesignStyle, d: Design): { number: string; footer: string } {
  if (layout === 'photo') return { number: '#ffffff', footer: '#ffffff' };
  if (layout === 'split')
    return { number: wordsOn(d.accent), footer: readable(d.text, d.background) };
  return { number: d.text, footer: d.text };
}

function drawPage(
  ctx: Ctx2d,
  d: Design,
  page: DesignPage,
  n: number,
  of: number,
  photo: Img | null,
): void {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const p: Page = {
    ctx,
    d,
    type: TYPES[d.font] ?? TYPES.modern,
    kicker: drawable(page.kicker),
    heading: drawable(page.heading),
    body: drawable(page.body),
    footer: drawable(page.footer),
    items: page.items.map(drawable).filter(Boolean),
    mark: drawable(page.mark),
    seed: seedOf(page.heading),
  };
  // A layout without what it needs (a photo that didn't come, items that were all symbols) is drawn bold.
  const needs: Partial<Record<DesignStyle, boolean>> = {
    photo: !!photo,
    framed: !!photo,
    list: p.items.length >= 2,
    beforeAfter: p.items.length >= 2,
    number: !!p.mark,
    highlight: !!p.mark,
    myth: !!p.body,
  };
  const layout: DesignStyle = needs[page.layout] === false ? 'bold' : page.layout;
  switch (layout) {
    case 'clean':
      drawClean(p);
      break;
    case 'split':
      drawSplit(p);
      break;
    case 'number':
      drawNumber(p);
      break;
    case 'list':
      drawList(p);
      break;
    case 'quote':
      drawQuote(p);
      break;
    case 'myth':
      drawMyth(p);
      break;
    case 'beforeAfter':
      drawBeforeAfter(p);
      break;
    case 'note':
      drawNote(p);
      break;
    case 'highlight':
      drawHighlight(p);
      break;
    case 'photo':
      drawPhoto(p, photo!);
      break;
    case 'framed':
      drawFramed(p, photo!);
      break;
    default:
      drawBold(p);
  }
  const edge = edgeColor(layout, d);
  pageNumber(p, n, of, edge.number);
  footerLine(
    p,
    layout === 'note' ? wordsOn(d.background) : edge.footer,
    layout === 'number' || layout === 'note' ? 'center' : 'left',
  );
}

/** A picture as drawn: a page with the photo is a JPEG, so it stays small; the others are PNGs. */
export interface Drawn {
  readonly bytes: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg';
}

/** Each page of the design, in order; `photo` is what OpenAI made, drawn under the first page's words. */
export async function drawDesign(d: Design, photo: Buffer | null = null): Promise<Drawn[]> {
  const lib = await canvasLib();
  const img = photo ? await lib.loadImage(photo) : null;
  const out: Drawn[] = [];
  for (const [i, page] of d.pages.entries()) {
    const canvas = lib.createCanvas(PICTURE_WIDTH, PICTURE_HEIGHT);
    const withPhoto = i === 0 && img && (page.layout === 'photo' || page.layout === 'framed');
    drawPage(canvas.getContext('2d'), d, page, i + 1, d.pages.length, i === 0 ? img : null);
    out.push(
      withPhoto
        ? { bytes: await canvas.encode('jpeg', 90), mimeType: 'image/jpeg' }
        : { bytes: await canvas.encode('png'), mimeType: 'image/png' },
    );
  }
  return out;
}
