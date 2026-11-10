/**
 * Drawing the AI's designs (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decision 14; docs/socialcontent.md,
 * "Making posts"): each page of a design Claude wrote (packages/core/src/addons/socialcontent/posts-ai.ts) as a
 * 1080x1350 PNG, the 4:5 portrait Instagram, Facebook and LinkedIn all show whole. Words are drawn here, never by an
 * image model, so they're spelled right.
 *
 * Three layouts: **bold** (a big heading on a solid colour), **clean** (dark words on a light background with a
 * coloured bar) and **split** (a coloured top with the heading, the body below). The font is Inter, shipped with
 * the worker (@fontsource/inter): the server has no fonts of its own.
 */
import { createRequire } from 'node:module';
import type { Design, DesignPage } from '@hfos/core/addons/socialcontent/posts-ai';
import type * as CanvasLib from '@napi-rs/canvas';

export const PICTURE_WIDTH = 1080;
export const PICTURE_HEIGHT = 1350;
const PAD = 96;
const FONT = 'HfosInter';

type Canvas = typeof CanvasLib;
type Ctx2d = ReturnType<ReturnType<Canvas['createCanvas']>['getContext']>;

let loaded: Promise<Canvas> | null = null;
/** The canvas library, with Inter registered once. */
function canvasLib(): Promise<Canvas> {
  loaded ??= import('@napi-rs/canvas').then((lib) => {
    const req = createRequire(import.meta.url);
    for (const weight of [400, 700, 800])
      lib.GlobalFonts.registerFromPath(
        req.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2`),
        FONT,
      );
    return lib;
  });
  return loaded;
}

/**
 * Words the font can draw: arrows become ›, and emoji and other symbols it has no shape for are left out (the
 * font holds Latin letters, numbers and punctuation, with ©, ® and ™).
 */
export function drawable(s: string | null): string {
  return (s ?? '')
    .replace(/[\u2190-\u21FF\u27A1\u2B05-\u2B07]/g, '\u203A')
    .replace(/(?![\u00A9\u00AE\u2122])[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[^\s\u0020-\u024F\u2000-\u206F\u20AC\u2122]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

/** The biggest size, from `most` down to `least`, at which `text` fits `width` in at most `lines` lines. */
function fit(
  ctx: Ctx2d,
  text: string,
  weight: number,
  most: number,
  least: number,
  width: number,
  maxLines: number,
): { size: number; lines: string[] } {
  for (let size = most; size >= least; size -= 4) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const lines = wrap(ctx, text, width);
    if (lines.length <= maxLines) return { size, lines };
  }
  ctx.font = `${weight} ${least}px ${FONT}`;
  const lines = wrap(ctx, text, width);
  return { size: least, lines: lines.slice(0, maxLines) };
}

function drawLines(
  ctx: Ctx2d,
  lines: readonly string[],
  x: number,
  y: number,
  size: number,
  lineHeight: number,
): number {
  for (const [i, l] of lines.entries()) ctx.fillText(l, x, y + size + i * size * lineHeight);
  return y + size + (lines.length - 1) * size * lineHeight + size * (lineHeight - 1);
}

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
/** The accent where it reads on `bg`, else the words' colour. */
const accentOn = (accent: string, bg: string, words: string) =>
  contrast(accent, bg) >= 3 ? accent : words;

function drawPage(ctx: Ctx2d, d: Design, page: DesignPage, n: number, of: number): void {
  const W = PICTURE_WIDTH;
  const H = PICTURE_HEIGHT;
  const inner = W - PAD * 2;
  const kicker = drawable(page.kicker).toUpperCase();
  const heading = drawable(page.heading);
  const body = drawable(page.body);
  const footer = drawable(page.footer);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  let headingArea: { top: number; bottom: number; bg: string };
  let bodyBg: string;
  if (d.style === 'split') {
    const cut = Math.round(H * 0.56);
    ctx.fillStyle = d.accent;
    ctx.fillRect(0, 0, W, cut);
    ctx.fillStyle = d.background;
    ctx.fillRect(0, cut, W, H - cut);
    headingArea = { top: PAD + 40, bottom: cut - 60, bg: d.accent };
    bodyBg = d.background;
  } else {
    ctx.fillStyle = d.background;
    ctx.fillRect(0, 0, W, H);
    if (d.style === 'clean') {
      ctx.fillStyle = d.accent;
      ctx.fillRect(0, 0, 28, H);
    } else {
      ctx.fillStyle = d.accent;
      ctx.fillRect(PAD, PAD, 120, 14);
    }
    headingArea = { top: PAD + 60, bottom: H - PAD - 120, bg: d.background };
    bodyBg = d.background;
  }
  const headingWords = d.style === 'split' ? wordsOn(d.accent) : d.text;
  const bodyWords =
    d.style === 'split' ? (contrast(d.text, bodyBg) >= 4.5 ? d.text : wordsOn(bodyBg)) : d.text;

  // The page's number on a carousel, top right.
  if (of > 1) {
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = headingWords;
    ctx.globalAlpha = 0.7;
    ctx.textAlign = 'right';
    ctx.fillText(`${n}/${of}`, W - PAD, PAD + 28);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }

  const split = d.style === 'split';
  // Measured first, then drawn: on a bold or clean page the words sit in the middle of the page.
  ctx.font = `800 34px ${FONT}`;
  const kickerLines = kicker ? wrap(ctx, kicker, inner).slice(0, 2) : [];
  const kickerHeight = kickerLines.length
    ? 34 + (kickerLines.length - 1) * 34 * 1.3 + 34 * 0.3 + 28
    : 0;
  const room = headingArea.bottom - headingArea.top;
  const most = body ? (split ? 96 : 104) : 128;
  const headingRoom = room - kickerHeight - (split || !body ? 0 : 320);
  const h = fit(
    ctx,
    heading,
    800,
    most,
    48,
    inner,
    Math.max(2, Math.floor(headingRoom / (most * 1.12))),
  );
  const headingHeight = h.size + (h.lines.length - 1) * h.size * 1.12 + h.size * 0.12;
  let b: { size: number; lines: string[] } | null = null;
  let bodyHeight = 0;
  if (body) {
    const bodyRoom = split
      ? H - PAD - (footer ? 90 : 0) - (Math.round(H * 0.56) + 64)
      : room - kickerHeight - headingHeight - 48;
    b = fit(ctx, body, 400, 46, 30, inner, Math.max(2, Math.floor(bodyRoom / (46 * 1.4))));
    bodyHeight = b.size + (b.lines.length - 1) * b.size * 1.4;
  }
  const block = kickerHeight + headingHeight + (b && !split ? 48 + bodyHeight : 0);
  let y = split
    ? Math.max(headingArea.top, headingArea.bottom - kickerHeight - headingHeight)
    : headingArea.top + Math.max(0, (room - block) / 2);

  if (kickerLines.length) {
    ctx.font = `800 34px ${FONT}`;
    ctx.fillStyle = split ? headingWords : accentOn(d.accent, headingArea.bg, d.text);
    y = drawLines(ctx, kickerLines, PAD, y, 34, 1.3) + 28;
  }
  ctx.font = `800 ${h.size}px ${FONT}`;
  ctx.fillStyle = headingWords;
  y = drawLines(ctx, h.lines, PAD, y, h.size, 1.12);

  if (b) {
    const top = split ? Math.round(H * 0.56) + 64 : y + 48;
    ctx.font = `400 ${b.size}px ${FONT}`;
    ctx.fillStyle = bodyWords;
    drawLines(ctx, b.lines, PAD, top, b.size, 1.4);
  }

  if (footer) {
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = bodyWords;
    ctx.globalAlpha = 0.85;
    const [line] = wrap(ctx, footer, inner);
    ctx.fillText(line ?? '', PAD, H - PAD);
    ctx.globalAlpha = 1;
  }
}

/** Each page of the design, as a PNG, in order. */
export async function drawDesign(d: Design): Promise<Buffer[]> {
  const lib = await canvasLib();
  const out: Buffer[] = [];
  for (const [i, page] of d.pages.entries()) {
    const canvas = lib.createCanvas(PICTURE_WIDTH, PICTURE_HEIGHT);
    drawPage(canvas.getContext('2d'), d, page, i + 1, d.pages.length);
    out.push(await canvas.encode('png'));
  }
  return out;
}
