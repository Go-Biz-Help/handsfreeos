#!/usr/bin/env node
/**
 * The phone app's design tokens, generated from the web's (apps/web/src/app/globals.css), so both apps share one
 * set of colours, radii and type.
 *
 *   node scripts/mobile-tokens.mjs           write apps/mobile/src/theme/tokens.css and tokens.ts
 *   node scripts/mobile-tokens.mjs --check   fail when either file is out of date (CI runs this)
 *
 * Why generated: the web switches themes with `[data-theme]` blocks, which nothing on a phone can read. Uniwind reads
 * `@variant light` / `@variant dark` blocks instead. Names stay the web's own (`bg-card`, `text-text-2`,
 * `border-border-strong`), so a class means the same thing in both apps.
 *
 * The web's `color-mix(in oklab, …)` accents are worked out here, as browsers do (CSS Color 4, premultiplied alpha),
 * and written as colours with the web's expression beside each. Uniwind can't be left to mix them: a `var()` inside
 * `color-mix` is mixed at run time in plain RGB, and its CSS compiler (lightningcss 1.30) treats black as having no
 * hue, so the light theme's `--accent-hover` came out #1551be where Chrome shows #2355b0. tokens.ts holds the same
 * colours for the few places that need a value rather than a class (the navigation theme, icons, the status bar).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'apps/web/src/app/globals.css');
const CSS_OUT = join(root, 'apps/mobile/src/theme/tokens.css');
const TS_OUT = join(root, 'apps/mobile/src/theme/tokens.ts');

/** The web loads its fonts through next/font variables; the phone embeds the same families by name. */
const FONT_FAMILIES = { '--font-hanken': 'Hanken Grotesk', '--font-jetbrains': 'JetBrains Mono' };

// ---------------------------------------------------------------------------------------------- reading the web's CSS

/** Every top-level rule body whose selector list is exactly `selector` (comments removed). */
function blocks(css, selectorTest) {
  const out = [];
  let depth = 0;
  let start = 0;
  let selector = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        selector = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (selectorTest(selector.replace(/\s+/g, ' '))) out.push(css.slice(start, i));
        start = i + 1;
      }
    } else if (depth === 0 && ch === ';') {
      start = i + 1; // a top-level at-rule statement such as @import
    }
  }
  return out;
}

/** `--name: value;` declarations, in order. */
function declarations(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  return out;
}

export function readWebTokens(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const light = new Map();
  const dark = new Map();
  for (const body of blocks(clean, (s) => s === ":root, [data-theme='light']"))
    for (const [k, v] of declarations(body)) light.set(k, v);
  for (const body of blocks(clean, (s) => s === "[data-theme='dark']"))
    for (const [k, v] of declarations(body)) dark.set(k, v);
  const themeBodies = blocks(clean, (s) => s === '@theme inline');
  if (!light.size || !dark.size || themeBodies.length !== 1)
    throw new Error(`Could not find the light, dark and @theme inline blocks in ${SOURCE}`);
  return { light, dark, theme: declarations(themeBodies[0]) };
}

// ---------------------------------------------------------------------------------------------- colours

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` or `transparent`, as 0–1 channels. */
function parseColor(value) {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), alpha: hex.length === 8 ? n(6) : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(v);
  if (m)
    return {
      r: +m[1] / 255,
      g: +m[2] / 255,
      b: +m[3] / 255,
      alpha: m[4] === undefined ? 1 : +m[4],
    };
  return null;
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB to OKLab (Björn Ottosson's matrices, as CSS Color 4 uses them). */
function toOklab({ r, g, b, alpha }) {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    alpha,
  };
}

function fromOklab({ L, a, b, alpha }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  };
}

/** `color-mix(in oklab, A p%, B)`, with premultiplied alpha as CSS Color 4 specifies. */
function mixOklab(first, pct, second) {
  const p = pct / 100;
  const [x, y] = [toOklab(first), toOklab(second)];
  const alpha = x.alpha * p + y.alpha * (1 - p);
  const channel = (k) =>
    alpha === 0 ? 0 : (x[k] * x.alpha * p + y[k] * y.alpha * (1 - p)) / alpha;
  return fromOklab({ L: channel('L'), a: channel('a'), b: channel('b'), alpha });
}

function toHex({ r, g, b, alpha }) {
  const byte = (c) =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}${alpha < 1 ? byte(alpha) : ''}`;
}

/** A token's value with `var(--x)` written out from the same theme (dark falls back to light, as the web cascades). */
function inline(value, own, fallback) {
  return value.replace(/var\((--[\w-]+)\)/g, (_, name) => {
    const found = own.get(name) ?? fallback.get(name);
    if (found === undefined) throw new Error(`${name} is used but never set`);
    return inline(found, own, fallback);
  });
}

/** The colour a CSS value comes to, as hex (`#rrggbb` or `#rrggbbaa`). */
export function resolveColor(value) {
  const mix = /^color-mix\(\s*in oklab\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/.exec(value);
  if (mix) {
    const [first, second] = [parseColor(mix[1]), parseColor(mix[3])];
    if (!first || !second) throw new Error(`Can't mix ${value}`);
    return toHex(mixOklab(first, Number(mix[2]), second));
  }
  const color = parseColor(value);
  if (!color) throw new Error(`Not a colour: ${value}`);
  return toHex(color);
}

// ---------------------------------------------------------------------------------------------- output

const camel = (name) => name.replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());

export function buildTokens(css) {
  const { light, dark, theme } = readWebTokens(css);
  const colors = [];
  const radii = [];
  const fonts = [];
  for (const [name, value] of theme) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
    if (name.startsWith('--color-') && ref) colors.push({ name, ref });
    else if (name.startsWith('--radius-')) radii.push({ name, value });
    else if (name.startsWith('--font-')) {
      const family = FONT_FAMILIES[/var\((--[\w-]+)\)/.exec(value)?.[1] ?? ''];
      if (!family) throw new Error(`No phone font for ${name}: ${value}`);
      fonts.push({ name, family });
    }
  }
  // The web draws sheets' backdrops with `bg-[var(--scrim)]`; the phone names it as a colour, `bg-scrim`.
  for (const ref of PHONE_COLORS) colors.push({ name: `--color-${ref.slice(2)}`, ref });
  const themeValues = (own, fallback) =>
    colors.map(({ name, ref }) => {
      const raw = own.get(ref) ?? fallback.get(ref);
      if (raw === undefined) throw new Error(`${ref} (for ${name}) is not set`);
      const value = inline(raw, own, fallback);
      return { name, value, hex: resolveColor(value) };
    });
  const shadows = (own, fallback) =>
    SHADOWS.map((name) => {
      const value = own.get(name) ?? fallback.get(name);
      if (value === undefined) throw new Error(`${name} is not set`);
      return { name, value };
    });
  return {
    light: themeValues(light, light),
    dark: themeValues(dark, light),
    shadows: { light: shadows(light, light), dark: shadows(dark, light) },
    radii,
    fonts,
  };
}

/** Web variables that aren't Tailwind colours there but are colours the phone's classes need. */
const PHONE_COLORS = ['--scrim'];
/** The web's elevations, as React Native `boxShadow` values (it takes the same syntax, several layers included). */
const SHADOWS = ['--shadow-1', '--shadow-2', '--shadow-3'];

const HEADER = (kind) =>
  `/* Generated by scripts/mobile-tokens.mjs from apps/web/src/app/globals.css: don't edit. ${kind} */`;

export function renderCss(tokens) {
  const variant = (list) =>
    list
      .map(({ name, value, hex }) =>
        value.startsWith('color-mix(')
          ? `      ${name}: ${hex}; /* ${value} */`
          : `      ${name}: ${value};`,
      )
      .join('\n');
  return `${HEADER('Change the web’s tokens, then run `node scripts/mobile-tokens.mjs`.')}

@theme {
${tokens.radii.map(({ name, value }) => `  ${name}: ${value};`).join('\n')}
${tokens.fonts.map(({ name, family }) => `  ${name}: '${family}';`).join('\n')}
}

@layer theme {
  :root {
    @variant light {
${variant(tokens.light)}
    }

    @variant dark {
${variant(tokens.dark)}
    }
  }
}
`;
}

export function renderTs(tokens) {
  const shadowLines = (list) =>
    list
      .map(({ name, value }) => `    ${name.replace(/^--shadow-/, 'shadow')}: '${value}',`)
      .join('\n');
  const colors = (list) =>
    list
      .map(({ name, hex }) => `    ${camel(name.replace('--color-', '--'))}: '${hex}',`)
      .join('\n');
  return `${HEADER('The colours already worked out, for props that take a value.').replace('/*', '/**')}
export const colors = {
  light: {
${colors(tokens.light)}
  },
  dark: {
${colors(tokens.dark)}
  },
} as const;

export type ThemeName = keyof typeof colors;
export type ColorToken = keyof (typeof colors)['light'];

/** For \`style={{ boxShadow }}\`: shadow1 on cards and secondary buttons, shadow2 on toasts, shadow3 on sheets. */
export const shadows = {
  light: {
${shadowLines(tokens.shadows.light)}
  },
  dark: {
${shadowLines(tokens.shadows.dark)}
  },
} as const;

export const radius = {
${tokens.radii.map(({ name, value }) => `  ${camel(name.replace('--radius-', '--'))}: ${parseFloat(value)},`).join('\n')}
} as const;

export const fonts = {
${tokens.fonts.map(({ name, family }) => `  ${camel(name.replace('--font-', '--'))}: '${family}',`).join('\n')}
} as const;
`;
}

async function formatted(content, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(content, { ...options, filepath });
}

async function main() {
  const check = process.argv.includes('--check');
  const tokens = buildTokens(readFileSync(SOURCE, 'utf8'));
  const outputs = [
    [CSS_OUT, await formatted(renderCss(tokens), CSS_OUT)],
    [TS_OUT, await formatted(renderTs(tokens), TS_OUT)],
  ];
  let stale = 0;
  for (const [path, content] of outputs) {
    const rel = relative(root, path);
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // missing: stale
    }
    if (current === content) continue;
    if (check) {
      console.error(`${rel} is out of date with apps/web/src/app/globals.css.`);
      stale++;
    } else {
      writeFileSync(path, content);
      console.log(`wrote ${rel}`);
    }
  }
  if (check && stale) {
    console.error('Run `node scripts/mobile-tokens.mjs` and commit the result.');
    process.exit(1);
  }
  if (check) console.log('The phone app’s tokens match the web’s.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
