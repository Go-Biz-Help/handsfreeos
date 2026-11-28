/**
 * How the Content Creator's pictures look (design tools, part 6: HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md,
 * decision 9; docs/socialcontent.md, "How your pictures look"): the business's logo on them (in a corner of every page,
 * on the last page only, or never), and the fonts and layouts the design AI may use. The colours already come from the
 * brand kit's colour; the font follows the brand kit's too until the business picks its own here.
 *
 * Kept in `addon_socialcontent.settings.picture_look` and saved with `socialcontent.settings.save`. Browser-safe and
 * pure: the web, the phone and the worker read it alike.
 */
import { z } from 'zod';
import { FORM_FONTS } from '../../look/fonts';
import {
  DESIGN_FONTS,
  DESIGN_STYLES,
  isDesignFont,
  PHOTO_STYLES,
  PLAIN_STYLES,
  type DesignFont,
  type DesignStyle,
} from './design-names';

/** Where the business's logo goes on its pictures: in a corner of every page, on the last page only, or never. */
export const PICTURE_LOGO = ['corner', 'last', 'never'] as const;
export type PictureLogo = (typeof PICTURE_LOGO)[number];

/**
 * The look as kept. Unset is the logo in a corner (the owner's idea 13: pictures never carried it), the brand kit's font
 * (or all four when the kit has none, as before) and every layout.
 */
export interface PictureLook {
  readonly logo: PictureLogo;
  /** The fonts it may use; null follows the brand kit. */
  readonly fonts: DesignFont[] | null;
  /** The layouts it may use; null is all of them, ones added later too. */
  readonly layouts: DesignStyle[] | null;
}

export const NO_PICTURE_LOOK: PictureLook = { logo: 'corner', fonts: null, layouts: null };

/** A list of layouts it can design with: at least one that needs only a heading, and one that holds a photo. */
export const layoutsEnough = (layouts: readonly DesignStyle[]): boolean =>
  layouts.some((l) => PLAIN_STYLES.includes(l)) && layouts.some((l) => PHOTO_STYLES.includes(l));

/** The look as kept, read forgivingly: a part that doesn't make sense is left unset. */
export function pictureLookOf(raw: unknown): PictureLook {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const logo = (PICTURE_LOGO as readonly unknown[]).includes(r['logo'])
    ? (r['logo'] as PictureLogo)
    : NO_PICTURE_LOOK.logo;
  const fonts = Array.isArray(r['fonts'])
    ? DESIGN_FONTS.filter((f) => (r['fonts'] as unknown[]).includes(f))
    : [];
  const layouts = Array.isArray(r['layouts'])
    ? DESIGN_STYLES.filter((l) => (r['layouts'] as unknown[]).includes(l))
    : [];
  return {
    logo,
    fonts: fonts.length ? fonts : null,
    layouts: layouts.length && layoutsEnough(layouts) ? layouts : null,
  };
}

/** The look as the screens are given it. */
export const PictureLookShape = z.object({
  logo: z.enum(PICTURE_LOGO),
  fonts: z.array(z.enum(DESIGN_FONTS)).nullable(),
  layouts: z.array(z.enum(DESIGN_STYLES)).nullable(),
});

/** A change to the look: what's given changes, null puts it back to following the brand kit (or all layouts). */
export const PictureLookInput = z
  .object({
    logo: z.enum(PICTURE_LOGO).optional(),
    fonts: z
      .array(z.enum(DESIGN_FONTS))
      .min(1, 'Keep at least one font, or pick Like my brand kit.')
      .max(DESIGN_FONTS.length)
      .nullable()
      .optional(),
    layouts: z.array(z.enum(DESIGN_STYLES)).max(DESIGN_STYLES.length).nullable().optional(),
  })
  .refine((l) => !l.layouts || l.layouts.some((x) => PLAIN_STYLES.includes(x)), {
    error:
      'Keep at least one of Bold, Clean, Split or Sticky note: a page with only a heading needs one of them.',
    path: ['layouts'],
  })
  .refine((l) => !l.layouts || l.layouts.some((x) => PHOTO_STYLES.includes(x)), {
    error: 'Keep Photo or Framed: a picture with a photo needs one of them.',
    path: ['layouts'],
  });
export type PictureLookInput = z.infer<typeof PictureLookInput>;

/** The look with a change made: fonts and layouts that are every one there is are kept as unset. */
export function pictureLookChanged(was: PictureLook, change: PictureLookInput): PictureLook {
  const fonts =
    change.fonts === undefined
      ? was.fonts
      : change.fonts === null
        ? null
        : DESIGN_FONTS.filter((f) => change.fonts!.includes(f));
  const layouts =
    change.layouts === undefined
      ? was.layouts
      : change.layouts === null
        ? null
        : DESIGN_STYLES.filter((l) => change.layouts!.includes(l));
  return {
    logo: change.logo ?? was.logo,
    fonts: fonts?.length ? fonts : null,
    layouts: layouts && layouts.length < DESIGN_STYLES.length ? layouts : null,
  };
}

/** Fonts a brand kit's font is drawn as, by name, when it isn't one of the four the worker ships. */
const LOUD = /condensed|bebas|anton|oswald|league gothic|fjalla|archivo black|teko|big shoulders/i;
const FRIENDLY =
  /round|nunito|quicksand|comfortaa|baloo|fredoka|varela|rubik|lexend|outfit|figtree|mulish|poppins/i;
const CLASSIC =
  /serif|slab|garamond|baskerville|bodoni|caslon|merriweather|lora|crimson|spectral|playfair|cormorant|libre|prata/i;

/**
 * The design font closest to the brand kit's font (decision 9: the pictures take their font from the kit). The worker
 * ships four, so a kit in Lora draws in classic (Playfair Display headings), one in Nunito in friendly, and so on; a
 * sans font it can't place draws in modern (Inter). Null when the kit has no font.
 */
export function designFontForKit(name: string | null | undefined): DesignFont | null {
  const n = name?.trim();
  if (!n) return null;
  const exact: Record<string, DesignFont> = {
    Inter: 'modern',
    'Playfair Display': 'classic',
    Oswald: 'loud',
    Poppins: 'friendly',
  };
  if (exact[n]) return exact[n];
  if (LOUD.test(n)) return 'loud';
  if (FRIENDLY.test(n)) return 'friendly';
  if (FORM_FONTS.find((f) => f.name === n)?.kind === 'serif' || CLASSIC.test(n)) return 'classic';
  return 'modern';
}

/** The fonts the design AI may use: the ones picked, else the brand kit's, else all four (as before part 6). */
export function fontsFor(look: PictureLook, kitFont: string | null | undefined): DesignFont[] {
  if (look.fonts?.length) return [...look.fonts];
  const kit = designFontForKit(kitFont);
  return kit ? [kit] : [...DESIGN_FONTS];
}

/** The layouts the design AI may use. */
export const layoutsFor = (look: PictureLook): DesignStyle[] =>
  look.layouts && layoutsEnough(look.layouts) ? [...look.layouts] : [...DESIGN_STYLES];

/** What a design may use: its fonts and layouts. */
export interface DesignAllowed {
  readonly fonts: readonly DesignFont[];
  readonly layouts: readonly DesignStyle[];
}

export const ALL_DESIGNS: DesignAllowed = { fonts: DESIGN_FONTS, layouts: DESIGN_STYLES };

/** What a business's design may use, from its look and its brand kit's font. */
export const designAllowedOf = (
  look: PictureLook,
  kitFont: string | null | undefined,
): DesignAllowed => ({ fonts: fontsFor(look, kitFont), layouts: layoutsFor(look) });

/** A font the design may take: the one asked for when allowed, else the first allowed. */
export const allowedFont = (asked: unknown, allowed: readonly DesignFont[]): DesignFont =>
  isDesignFont(asked) && allowed.includes(asked) ? asked : (allowed[0] ?? 'modern');

/**
 * A layout the page may take: the one it would be drawn in when allowed; otherwise, on a page with the photo, the first
 * photo layout allowed, and on any other, the first plain layout allowed (clean, split, bold, then note).
 */
export function allowedLayout(
  layout: DesignStyle,
  allowed: readonly DesignStyle[],
  photoHere: boolean,
): DesignStyle {
  if (allowed.includes(layout)) return layout;
  const pool = photoHere ? PHOTO_STYLES : PLAIN_STYLES;
  return pool.find((l) => allowed.includes(l)) ?? (photoHere ? 'photo' : 'bold');
}

/** Whether a page carries the logo: every page with it in a corner, only the last with "last", none with "never". */
export const logoOnPage = (logo: PictureLogo, page: number, pages: number): boolean =>
  logo === 'corner' || (logo === 'last' && page === pages - 1);

// ------------------------------------------------------------------------------------------------ fixing words by hand

/** The words on one drawn picture, as kept on its design and changed by hand. */
export interface PictureWords {
  readonly layout: DesignStyle;
  readonly kicker: string | null;
  readonly heading: string;
  readonly body: string | null;
  readonly items: string[];
  readonly mark: string | null;
  readonly footer: string | null;
}

/** The parts of a page's words a person can change: what its layout draws. */
export type PageWordsField = 'kicker' | 'heading' | 'body' | 'items' | 'mark' | 'footer';

/**
 * What a layout draws, in the order it's shown to change: a list's items and a before and after's two sides, a number
 * page's number, and the highlighted words of a highlight page, beside the kicker, heading, body and footer every
 * layout has.
 */
export function pageFields(layout: DesignStyle): PageWordsField[] {
  return [
    'kicker',
    'heading',
    ...(layout === 'number' || layout === 'highlight' ? (['mark'] as const) : []),
    ...(layout === 'list' || layout === 'beforeAfter' ? (['items'] as const) : []),
    'body',
    'footer',
  ];
}

const textOr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * A post's picture words to change by hand (design tools, part 6), read from its design: null when they can't be,
 * because OpenAI made the picture words and all, or its first page sits on a photo that wasn't kept (pictures made
 * before part 6 kept only the finished picture).
 */
export function pictureWordsOf(design: unknown): PictureWords[] | null {
  if (typeof design !== 'object' || design === null) return null;
  const d = design as Record<string, unknown>;
  const graphic = d['graphic'] as { passed?: unknown } | undefined;
  if (graphic?.passed === true || !Array.isArray(d['pages']) || !d['pages'].length) return null;
  const pages: PictureWords[] = [];
  for (const raw of d['pages'] as unknown[]) {
    const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const layout = DESIGN_STYLES.find((s) => s === p['layout']) ?? 'bold';
    pages.push({
      layout,
      kicker: textOr(p['kicker']),
      heading: typeof p['heading'] === 'string' ? p['heading'] : '',
      body: textOr(p['body']),
      items: Array.isArray(p['items'])
        ? (p['items'] as unknown[]).filter((i): i is string => typeof i === 'string')
        : [],
      mark: textOr(p['mark']),
      footer: textOr(p['footer']),
    });
  }
  const onPhoto = PHOTO_STYLES.includes(pages[0]!.layout) && d['photo'] === true;
  if (onPhoto && !photoFileOf(design)) return null;
  return pages;
}

/** The photo a design's first page sits on, kept as a file on the post: the business's own, or the one OpenAI made. */
export function photoFileOf(design: unknown): string | null {
  if (typeof design !== 'object' || design === null) return null;
  const d = design as Record<string, unknown>;
  const id = typeof d['own'] === 'string' ? d['own'] : d['photoFile'];
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** The business's own photo that a design's words are over, to post it plain again; null when it isn't over one. */
export function ownPhotoOf(design: unknown): string | null {
  if (typeof design !== 'object' || design === null) return null;
  const id = (design as Record<string, unknown>)['own'];
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
