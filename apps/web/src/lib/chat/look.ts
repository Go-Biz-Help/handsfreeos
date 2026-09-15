/**
 * The chat window's colours from the widget's one accent. Light pages use the accent as picked; dark pages
 * lighten it until it stands out on the dark card, the way the design's dark board does. Text on either is
 * white or near-black, whichever reads better (readableTextOn).
 */
import { contrastRatio, readableTextOn } from '@hfos/core';

const DARK_CARD = '#191d25';
const WHITE = '#ffffff';

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** a mixed toward b: t = 0 is a, 1 is b. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const part = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${part(ar, br)}${part(ag, bg)}${part(ab, bb)}`;
}

/** A business's two letters on the chat's header: its first two words' ("Lone Star HVAC & Roofing" is LS). */
export const markOf = (name: string): string =>
  (name.match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('') || '?';

export interface WidgetColors {
  readonly light: { readonly accent: string; readonly on: string };
  readonly dark: { readonly accent: string; readonly on: string };
  /** The initials on the header's white square. */
  readonly mark: string;
}

export function widgetColors(accentHex: string): WidgetColors {
  const accent = /^#[0-9a-f]{6}$/i.test(accentHex) ? accentHex.toLowerCase() : '#2d69d8';
  let dark = accent;
  for (let t = 0.1; contrastRatio(dark, DARK_CARD) < 4.5 && t < 0.95; t += 0.1)
    dark = mix(accent, WHITE, t);
  return {
    light: { accent, on: readableTextOn(accent) },
    dark: { accent: dark, on: readableTextOn(dark) },
    mark: contrastRatio(accent, WHITE) >= 3 ? accent : '#191d25',
  };
}
