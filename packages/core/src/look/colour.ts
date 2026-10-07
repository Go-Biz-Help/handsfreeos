/**
 * A business's colour, worked out the same way everywhere it shows (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §4, "Your logo and colour"). Browser-safe.
 *
 * The colour is kept as picked. Where it fills a button under white words (the booking page, invoices), it's darkened
 * just enough for the words to read (`buttonColorFor`); the website chat works out its own (`readableTextOn`).
 */
import { contrastRatio } from '../chat/origins';

/** HandsFreeOS's own blue: the colour a business has until it picks one. */
export const LOOK_DEFAULT_COLOR = '#2d69d8';

/** The colours offered beside the logo's own, as on the website chat's settings. */
export const LOOK_SWATCHES = [
  '#b42318',
  '#2d69d8',
  '#0e7490',
  '#008743',
  '#7c3aed',
  '#191d25',
] as const;

const HEX = /^#[0-9a-f]{6}$/i;

/** A colour as kept: #rrggbb, lower case. */
export const isLookColor = (hex: unknown): hex is string =>
  typeof hex === 'string' && HEX.test(hex);

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** a mixed toward b: t = 0 is a, 1 is b. */
export function mixColors(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

const WHITE = '#ffffff';
const BLACK = '#000000';

/**
 * The colour a button takes under white words: the business's own, darkened in small steps until the words reach
 * 4.5:1 (WCAG AA). Most colours are kept as they are; a yellow or a pale blue comes out deeper.
 */
export function buttonColorFor(hex: string | null | undefined): string {
  const color = isLookColor(hex) ? hex.toLowerCase() : LOOK_DEFAULT_COLOR;
  let out = color;
  for (let t = 0.05; contrastRatio(out, WHITE) < 4.5 && t <= 1; t += 0.05)
    out = mixColors(color, BLACK, t);
  return out;
}

/** Hue (0–360), saturation and lightness (0–1) of a colour. */
export function hslOf(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = channels(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** A colour with enough colour in it to stand for a business: not white, black or a grey. */
export const isColorful = (hex: string): boolean => {
  if (!isLookColor(hex)) return false;
  const { s, l } = hslOf(hex);
  return s >= 0.25 && l > 0.1 && l < 0.9;
};

/**
 * The colour a logo stands for, from its pixels (red, green, blue and alpha, 0–255, four to a pixel): the most
 * common strong colour, near enough. See-through, white and grey pixels don't count. A logo that's black on white
 * stands for black (#191d25, the darkest of the swatches); one with no colour at all, for nothing.
 */
export function colorOfPixels(rgba: Uint8Array | readonly number[]): string | null {
  // Pixels of much the same hue count together, however light or deep: a gradient is one colour.
  const groups = new Map<number, { r: number; g: number; b: number; n: number; weight: number }>();
  let solid = 0;
  let dark = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    const hex = toHex(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    const { h, s, l } = hslOf(hex);
    solid += 1;
    if (l < 0.2 && s < 0.35) dark += 1;
    if (s < 0.25 || l > 0.9 || l < 0.1) continue;
    const key = Math.floor(h / 15) % 24;
    const group = groups.get(key) ?? { r: 0, g: 0, b: 0, n: 0, weight: 0 };
    group.r += rgba[i]!;
    group.g += rgba[i + 1]!;
    group.b += rgba[i + 2]!;
    group.n += 1;
    group.weight += 0.5 + s;
    groups.set(key, group);
  }
  let best: { r: number; g: number; b: number; n: number; weight: number } | null = null;
  for (const group of groups.values()) if (!best || group.weight > best.weight) best = group;
  // A few stray pixels of colour (the edges round a black logo) don't make it a colourful one.
  if (best && best.n >= Math.max(4, solid * 0.03))
    return toHex(best.r / best.n, best.g / best.n, best.b / best.n);
  return solid > 0 && dark / solid >= 0.3 ? '#191d25' : null;
}
