/**
 * The chat window's colours from the widget's look. Light pages use the accent as picked; dark pages lighten it until
 * it stands out on the dark card, the way the design's dark board does. Text on either is the business's picked
 * colour, or else white or near-black, whichever reads better (readableTextOn). The top bar is the accent unless the
 * business picked a colour for it, which is then kept as picked on dark pages too.
 */
import type { CSSProperties } from 'react';
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
  /** The top bar, and the words on it. */
  readonly header: {
    readonly light: { readonly bg: string; readonly on: string };
    readonly dark: { readonly bg: string; readonly on: string };
  };
  /** The initials on the header's white square. */
  readonly mark: string;
}

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (v: string | null | undefined): string | null =>
  v && HEX.test(v) ? v.toLowerCase() : null;

export function widgetColors(
  accentHex: string,
  picked: { readonly header?: string | null; readonly text?: string | null } = {},
): WidgetColors {
  const accent = hexOr(accentHex) ?? '#2d69d8';
  const text = hexOr(picked.text);
  const header = hexOr(picked.header);
  // With a text colour picked, the accent stays as picked so those words keep reading on it.
  let dark = accent;
  if (!text)
    for (let t = 0.1; contrastRatio(dark, DARK_CARD) < 4.5 && t < 0.95; t += 0.1)
      dark = mix(accent, WHITE, t);
  const on = (bg: string) => text ?? readableTextOn(bg);
  return {
    light: { accent, on: on(accent) },
    dark: { accent: dark, on: on(dark) },
    header: {
      light: { bg: header ?? accent, on: on(header ?? accent) },
      dark: { bg: header ?? dark, on: on(header ?? dark) },
    },
    mark: contrastRatio(accent, WHITE) >= 3 ? accent : '#191d25',
  };
}

/** The chat's colours as the CSS variables its parts read (chat-parts.tsx's CSS picks light or dark). */
export function widgetVars(look: {
  readonly accentColor: string;
  /** The top bar's colour, when it isn't the accent. */
  readonly headerColor?: string | null;
  /** The business's picked text colour; null: worked out. */
  readonly pickedText?: string | null;
}): { readonly colors: WidgetColors; readonly vars: CSSProperties } {
  const header =
    look.headerColor && look.headerColor !== look.accentColor ? look.headerColor : null;
  const colors = widgetColors(look.accentColor, { header, text: look.pickedText });
  return {
    colors,
    vars: {
      '--wacc-l': colors.light.accent,
      '--wacc-on-l': colors.light.on,
      '--wacc-d': colors.dark.accent,
      '--wacc-on-d': colors.dark.on,
      '--whd-l': colors.header.light.bg,
      '--whd-on-l': colors.header.light.on,
      '--whd-d': colors.header.dark.bg,
      '--whd-on-d': colors.header.dark.on,
    } as CSSProperties,
  };
}
