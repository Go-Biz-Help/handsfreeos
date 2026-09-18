#!/usr/bin/env node
/**
 * The phone app's icons and splash mark, generated from one master: design/brand/handsfreeos-icon.png.
 *
 *   node scripts/mobile-icons.mjs            write every file listed in TARGETS
 *   node scripts/mobile-icons.mjs --list     say what would be written, and write nothing
 *
 * Run it by hand when the brand mark changes; nothing in CI depends on it, because the only thing checked in is its
 * output. The per-density files each platform installs (iOS's AppIcon.appiconset, Android's mipmap-*dpi) are not
 * checked in either: `expo prebuild` makes them from these, so app.json is the one place a size is decided.
 *
 * Why sharp: it is already in the tree (next's optional dependency), and it is the only installed resizer that can do
 * Lanczos downscaling, flatten onto a colour, and keep a 16-bit-clean alpha channel. pnpm doesn't hoist it, so it is
 * looked up in the store below; if that fails the message says what to install.
 *
 * The master is a blue gradient "H" on transparency, 1254×1254, with the glyph in a 1023×963 box. Every target here
 * trims the master to that box and re-centres it, so the glyph's size is decided per target rather than inherited:
 *   - an iOS icon leaves room for the system's corner mask (`GLYPH.ios`);
 *   - an Android adaptive layer has to stay inside the 66dp safe circle of its 108dp canvas (`GLYPH.adaptive`);
 *   - a splash mark is trimmed tight, and app.json's `imageWidth` sizes it on screen.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = join(root, 'design/brand/handsfreeos-icon.png');
const IMAGES = join(root, 'apps/mobile/assets/images');
const STORE = join(root, 'apps/mobile/store/assets');

/** Colours, all of them tokens the app already uses (apps/mobile/src/theme/tokens.ts). */
const COLOR = {
  /** `light.card`: the icon's field, so the blue mark carries the colour. */
  field: '#ffffff',
  /** `dark.bg`: the field of the dark iOS icon. */
  fieldDark: '#0f131a',
  /** `light.accentSoft`: the Android adaptive background, a hair of blue behind the mark. */
  adaptive: '#e9f0fd',
  /** iOS composes the tinted icon itself from a greyscale image, so that one is white on black. */
  tintedField: '#000000',
};

/**
 * How much of the canvas the glyph's longest side takes.
 *
 * `adaptive` is the one with a rule behind it rather than an eye: Android promises only the 66dp circle of the 108dp
 * canvas, so the glyph's *diagonal* has to fit inside it. The mark is 1023×963, so a longest side of f gives a diagonal
 * of f × 1.375, and 0.611 ÷ 1.375 = 0.444 — hence 0.44, which no launcher mask can clip.
 */
const GLYPH = { ios: 0.62, adaptive: 0.44, feature: 0.34 };

/** @typedef {{ to: string, size: [number, number], glyph: number | 'trim', background?: string, white?: boolean, why: string }} Target */

/** @type {Target[]} */
const TARGETS = [
  {
    to: join(IMAGES, 'icon.png'),
    size: [1024, 1024],
    glyph: GLYPH.ios,
    background: COLOR.field,
    why: 'iOS light + the Android legacy launcher icon + the web favicon. Opaque: the App Store rejects alpha.',
  },
  {
    to: join(IMAGES, 'icon-dark.png'),
    size: [1024, 1024],
    glyph: GLYPH.ios,
    background: COLOR.fieldDark,
    why: "iOS 18's dark icon.",
  },
  {
    to: join(IMAGES, 'icon-tinted.png'),
    size: [1024, 1024],
    glyph: GLYPH.ios,
    background: COLOR.tintedField,
    white: true,
    why: "iOS 18's tinted icon: white on black, and iOS maps the brightness to the tint.",
  },
  {
    to: join(IMAGES, 'android-icon-foreground.png'),
    size: [1024, 1024],
    glyph: GLYPH.adaptive,
    why: 'The adaptive icon’s foreground layer, inside the 66dp safe circle.',
  },
  {
    to: join(IMAGES, 'android-icon-background.png'),
    size: [1024, 1024],
    glyph: 0,
    background: COLOR.adaptive,
    why: 'The adaptive icon’s background layer. Flat, so a launcher can move it behind the mark.',
  },
  {
    to: join(IMAGES, 'android-icon-monochrome.png'),
    size: [1024, 1024],
    glyph: GLYPH.adaptive,
    white: true,
    why: 'The themed-icon layer: Android keeps only the shape and paints it in the wallpaper’s colour.',
  },
  {
    to: join(IMAGES, 'splash-icon.png'),
    size: [512, 512],
    glyph: 'trim',
    why: 'The mark on the splash, on the light field and the dark one. app.json sizes it.',
  },
  {
    to: join(STORE, 'app-store-icon-1024.png'),
    size: [1024, 1024],
    glyph: GLYPH.ios,
    background: COLOR.field,
    why: 'App Store Connect’s listing icon: 1024×1024, opaque, no alpha channel at all.',
  },
  {
    to: join(STORE, 'play-icon-512.png'),
    size: [512, 512],
    glyph: GLYPH.ios,
    background: COLOR.field,
    why: 'Play Console’s listing icon: 512×512, 32-bit PNG.',
  },
  {
    to: join(STORE, 'play-feature-graphic-1024x500.png'),
    size: [1024, 500],
    glyph: GLYPH.feature,
    background: COLOR.adaptive,
    why: 'Play Console’s feature graphic: 1024×500, no alpha, and nothing important near the edges.',
  },
];

/** sharp, wherever pnpm put it. */
function loadSharp() {
  const require = createRequire(import.meta.url);
  try {
    return require('sharp');
  } catch {
    // pnpm keeps every version in a store folder of its own and hoists nothing, so look for it there.
    const store = join(root, 'node_modules/.pnpm');
    const folder = existsSync(store)
      ? readdirSync(store)
          .filter((name) => name.startsWith('sharp@'))
          .sort()
          .pop()
      : undefined;
    if (folder) {
      try {
        return require(join(store, folder, 'node_modules/sharp'));
      } catch {
        // fall through to the message below
      }
    }
    throw new Error(
      'sharp is missing. It comes with the web app’s dependencies, so `pnpm install` at the root usually brings it;\n' +
        'on a machine where next skipped its optional dependencies, `pnpm add -Dw sharp` and try again.',
    );
  }
}

/**
 * The master, trimmed to the glyph and resized so its longest side is `side` px.
 * @param {import('sharp').default} sharp
 */
async function glyphAt(sharp, side, white) {
  const trimmed = await sharp(MASTER).ensureAlpha().trim({ threshold: 4 }).toBuffer();
  const one = sharp(trimmed).resize({
    width: side,
    height: side,
    fit: 'inside',
    kernel: 'lanczos3',
    withoutEnlargement: false,
  });
  if (!white) return one.png().toBuffer();
  // Keep the shape, throw the colour away: every pixel white, with the mark's own alpha.
  const { data, info } = await one.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    out[i * 4] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = data[i * info.channels + 3] ?? 255;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** @param {Target} target */
async function write(sharp, target) {
  const [width, height] = target.size;
  const canvas = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: target.background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  const layers = [];
  if (target.glyph !== 0) {
    const side =
      target.glyph === 'trim'
        ? Math.min(width, height)
        : Math.round(Math.min(width, height) * target.glyph);
    const glyph = await glyphAt(sharp, side, target.white === true);
    const { width: gw, height: gh } = await sharp(glyph).metadata();
    layers.push({
      input: glyph,
      left: Math.round((width - (gw ?? side)) / 2),
      top: Math.round((height - (gh ?? side)) / 2),
    });
  }
  const composed = await canvas.composite(layers).png().toBuffer();
  // An opaque target drops its alpha channel: App Store Connect refuses an icon that has one, even a full one. It takes
  // a second pass, because sharp flattens before it composites however the calls are ordered.
  const out = target.background
    ? sharp(composed).flatten({ background: target.background })
    : sharp(composed);
  mkdirSync(dirname(target.to), { recursive: true });
  return out.png({ compressionLevel: 9, palette: false }).toFile(target.to);
}

async function main() {
  if (!existsSync(MASTER)) throw new Error(`The master is missing: ${relative(root, MASTER)}`);
  const list = process.argv.includes('--list');
  const sharp = list ? null : loadSharp();
  for (const target of TARGETS) {
    const name = relative(root, target.to);
    if (list) {
      console.log(`${name}  ${target.size.join('×')}  ${target.why}`);
      continue;
    }
    const info = await write(sharp, target);
    console.log(
      `wrote ${name}  ${info.width}×${info.height}  ${info.channels}ch  ${info.size} bytes`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
