import { colorOfPixels, LOOK_PROBLEMS, LOOK_UPLOAD_MAX_BYTES } from '@hfos/core/server';
import sharp from 'sharp';

/**
 * Making a business's logo (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "Your logo and colour")
 * from a picture someone uploaded or one found on its website: a PNG everyone can see, with margins of plain
 * background trimmed off, no bigger than 800 × 400, and the colour it stands for.
 *
 * - Only PNG, JPG, WebP, GIF (its first frame) and SVG are opened, whatever the file says it is, and nothing so
 *   big that a small file unpacks into a huge picture.
 * - An SVG is drawn only when it's a plain picture: nothing that runs, nothing it would fetch from elsewhere (other
 *   files, web addresses), and no entities that expand. Anything else is refused with words saying so.
 */

export const LOGO_LIMITS = {
  /** The smallest a logo can be across (its longer side, once trimmed) and still look sharp. */
  minSide: 64,
  maxWidth: 800,
  maxHeight: 400,
  /** Pictures with more pixels than this aren't opened. */
  maxInputPixels: 40_000_000,
  /** How big an SVG is drawn across before it's fitted. */
  svgSide: 1_600,
  /** How far from the corner's colour a margin may be and still be trimmed. */
  trimThreshold: 12,
  /** How light (0–1) a pixel can be and still show on white. */
  light: 0.88,
} as const;

/** Why a picture can't be a logo, as LOOK_PROBLEMS says it to the person. */
export type LogoProblem = keyof typeof LOOK_PROBLEMS;

export class LogoError extends Error {
  constructor(readonly problem: LogoProblem) {
    super(LOOK_PROBLEMS[problem]);
    this.name = 'LogoError';
  }
}

export interface MadeLogo {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  /** The colour it stands for; null when it has none (white, grey or see-through). */
  readonly color: string | null;
}

const FORMATS = new Set(['png', 'jpeg', 'webp', 'gif', 'svg']);

/** The PNG everyone sees, made from a picture: a LogoError when it can't be a logo. */
export async function makeLogo(data: Buffer): Promise<MadeLogo> {
  if (data.length > LOOK_UPLOAD_MAX_BYTES) throw new LogoError('tooBig');
  const svg = svgText(data);
  if (svg !== null && !svgIsSafe(svg)) throw new LogoError('unsafeSvg');
  try {
    return await draw(data, svg !== null);
  } catch (e) {
    if (e instanceof LogoError) throw e;
    throw new LogoError('unreadable');
  }
}

async function draw(data: Buffer, isSvg: boolean): Promise<MadeLogo> {
  const open = (density?: number) =>
    sharp(data, {
      limitInputPixels: LOGO_LIMITS.maxInputPixels,
      ...(density ? { density } : {}),
    });
  const meta = await open().metadata();
  // Whatever it says it is: an SVG only when it read as one (svgText), and only the formats people can upload.
  if (!meta.format || !FORMATS.has(meta.format) || (meta.format === 'svg') !== isSvg)
    throw new LogoError(meta.format === 'svg' ? 'unsafeSvg' : 'unreadable');
  // An SVG is drawn big enough to fit sharply, whatever size it says it is.
  const density =
    isSvg && meta.width && meta.height
      ? Math.min(Math.max((72 * LOGO_LIMITS.svgSide) / Math.max(meta.width, meta.height), 1), 2_400)
      : undefined;
  const oriented = () => open(density).rotate();
  let full: { data: Buffer; info: { width: number; height: number } };
  try {
    full = await oriented()
      .trim({ threshold: LOGO_LIMITS.trimThreshold })
      .png()
      .toBuffer({ resolveWithObject: true });
  } catch {
    // Nothing to trim it to (all one colour): kept as it is.
    full = await oriented().png().toBuffer({ resolveWithObject: true });
  }
  if (Math.max(full.info.width, full.info.height) < LOGO_LIMITS.minSide)
    throw new LogoError('tooSmall');

  const { data: pixels, info: small } = await sharp(full.data)
    .resize(64, 64, { fit: 'inside' })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (small.channels !== 4) throw new LogoError('unreadable');
  // Nothing to see: every pixel see-through.
  let seen = false;
  for (let i = 3; i < pixels.length && !seen; i += 4) seen = pixels[i]! >= 16;
  if (!seen) throw new LogoError('unreadable');
  if (tooLight(pixels)) throw new LogoError('tooLight');

  const { data: png, info } = await sharp(full.data)
    .resize({
      width: LOGO_LIMITS.maxWidth,
      height: LOGO_LIMITS.maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    })
    // Eight bits a channel, so it always fits the `brand` bucket's 2 MB.
    .toColourspace('srgb')
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
  return { png, width: info.width, height: info.height, color: colorOfPixels(pixels) };
}

/**
 * A logo that wouldn't show on the white of the pages and emails it goes on: white or nearly (one made for a dark
 * header), on a see-through background. A picture with no see-through part is too light only when it's blank.
 */
export function tooLight(rgba: Uint8Array | Buffer): boolean {
  let solid = 0;
  let light = 0;
  let clear = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) {
      clear += 1;
      continue;
    }
    solid += 1;
    const lightness =
      (Math.max(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!) +
        Math.min(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!)) /
      510;
    if (lightness > LOGO_LIMITS.light) light += 1;
  }
  if (solid === 0) return false;
  return light / solid >= (clear > 0 ? 0.9 : 0.99);
}

/** The picture as SVG text when it is written as one (an XML document); null when it's an image file. */
export function svgText(data: Buffer): string | null {
  // Compressed SVG (.svgz) is never drawn: what it holds can't be checked first.
  if (data[0] === 0x1f && data[1] === 0x8b) throw new LogoError('unsafeSvg');
  const head = data
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  if (!head.trimStart().startsWith('<')) return null;
  const text = data.toString('utf8').replace(/^\uFEFF/, '');
  if (!/<svg[\s>/]/i.test(text)) throw new LogoError('unreadable');
  return text;
}

/** What an SVG may point to: a part of itself, or a picture inside it. */
const SAFE_REFERENCE = /^\s*(?:#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i;

/**
 * Whether an SVG is a plain picture, safe to draw: no scripts or event handlers, no HTML inside it, nothing
 * fetched from another file or address (links, styles and pictures alike), and no entities that expand into
 * more of themselves or come from elsewhere. Logos that only point at their own parts (gradients, shapes they
 * reuse) and carry their own pictures pass.
 */
export function svgIsSafe(svg: string): boolean {
  if (/<script[\s>/]/i.test(svg) || /<foreignObject[\s>/]/i.test(svg)) return false;
  if (/<(?:iframe|embed|object|audio|video|xi:include)\b/i.test(svg)) return false;
  if (/\son[a-z]+\s*=/i.test(svg) || /javascript:/i.test(svg)) return false;
  if (/@import/i.test(svg)) return false;
  for (const m of svg.matchAll(/<!ENTITY\s+%?\s*[^\s>]+\s+([\s\S]*?)>/gi)) {
    const body = m[1] ?? '';
    // From another file, or built from other entities.
    if (/^\s*(?:SYSTEM|PUBLIC)\b/i.test(body) || body.includes('&')) return false;
  }
  for (const m of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    if (!SAFE_REFERENCE.test(m[1] ?? m[2] ?? '')) return false;
  for (const m of svg.matchAll(/url\s*\(\s*(['"]?)([^'")]*)/gi))
    if (!(m[2] ?? '').trimStart().startsWith('#')) return false;
  return true;
}
