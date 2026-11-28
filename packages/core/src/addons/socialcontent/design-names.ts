/**
 * The layouts and fonts a designed picture can take (decision 39), apart from the design AI's words in posts-ai.ts so
 * the settings' shapes can name them without loading the prompts. Browser-safe and pure.
 */

/**
 * The layouts a designed page can take, drawn by the worker (apps/worker/src/addons/socialcontent/draw.ts): ten with
 * words alone, and two with a photo under the words (decision 39). A carousel's pages share one font and one set of
 * colours, like a Canva template, and each page takes the layout that fits its words.
 */
export const DESIGN_STYLES = [
  'bold',
  'clean',
  'split',
  'number',
  'list',
  'quote',
  'myth',
  'beforeAfter',
  'note',
  'highlight',
  'photo',
  'framed',
] as const;
export type DesignStyle = (typeof DESIGN_STYLES)[number];
export const isDesignStyle = (v: unknown): v is DesignStyle =>
  typeof v === 'string' && (DESIGN_STYLES as readonly string[]).includes(v);
/** The layouts with a photo under the words: only ever the first page, and only when there's a photo. */
export const PHOTO_STYLES: readonly DesignStyle[] = ['photo', 'framed'];
/** The layouts that need nothing but a heading: what a layout that can't be drawn becomes, best first. */
export const PLAIN_STYLES: readonly DesignStyle[] = ['clean', 'split', 'bold', 'note'];

/** The fonts a design can take, each a pair the worker ships (decision 39). */
export const DESIGN_FONTS = ['modern', 'classic', 'loud', 'friendly'] as const;
export type DesignFont = (typeof DESIGN_FONTS)[number];
export const isDesignFont = (v: unknown): v is DesignFont =>
  typeof v === 'string' && (DESIGN_FONTS as readonly string[]).includes(v);

/** The fonts each design font draws in, as the screens name them. */
export const DESIGN_FONT_FACES: Readonly<Record<DesignFont, string>> = {
  modern: 'Inter',
  classic: 'Playfair Display',
  loud: 'Oswald',
  friendly: 'Poppins',
};
