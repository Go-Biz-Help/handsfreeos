/**
 * The fonts a business's pages can be in: its brand kit (look.ts), its forms and booking pages (forms/design.ts).
 * Google fonts, HandsFreeOS's own first; Match my website may find another Google font. Browser-safe.
 */

/** A font from Google Fonts: its name, the weights asked for, and what stands in while it loads. */
export interface FormFont {
  readonly name: string;
  readonly weights: string;
  readonly kind: 'sans' | 'serif';
}

/** The fonts the Design tab offers, HandsFreeOS's own first. Match my website may pick another Google font. */
export const FORM_FONTS: readonly FormFont[] = [
  { name: 'Hanken Grotesk', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Inter', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Roboto', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Open Sans', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Lato', weights: '400;700', kind: 'sans' },
  { name: 'Montserrat', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Poppins', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Nunito', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Nunito Sans', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Raleway', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Source Sans 3', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Work Sans', weights: '400;500;600;700', kind: 'sans' },
  { name: 'DM Sans', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Manrope', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Rubik', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Mulish', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Karla', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Barlow', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Archivo', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Figtree', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Outfit', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Plus Jakarta Sans', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Lexend', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Josefin Sans', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Quicksand', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Oswald', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Ubuntu', weights: '400;500;700', kind: 'sans' },
  { name: 'Noto Sans', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Cabin', weights: '400;500;600;700', kind: 'sans' },
  { name: 'Merriweather', weights: '400;700', kind: 'serif' },
  { name: 'Playfair Display', weights: '400;500;600;700', kind: 'serif' },
  { name: 'Lora', weights: '400;500;600;700', kind: 'serif' },
  { name: 'PT Serif', weights: '400;700', kind: 'serif' },
  { name: 'Libre Baskerville', weights: '400;700', kind: 'serif' },
  { name: 'EB Garamond', weights: '400;500;600;700', kind: 'serif' },
  { name: 'Roboto Slab', weights: '400;500;600;700', kind: 'serif' },
];

/** HandsFreeOS's own font, which every page already has: a form "in our font" loads nothing. */
export const FORM_DEFAULT_FONT = 'Hanken Grotesk';

/** A Google font's name as Google spells it: letters, numbers and single spaces. */
export const FONT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]| (?! ))*[A-Za-z0-9]$/;

/** Whether a name is spelt the way Google names fonts. */
export const isFontName = (name: unknown): name is string =>
  typeof name === 'string' && name.length <= 60 && FONT_NAME.test(name);

/** The font's Google entry: one of ours, or a Google font Match my website found (weights unknown, so none asked for). */
export function formFontOf(name: string | null | undefined): FormFont | null {
  if (!name || name === FORM_DEFAULT_FONT) return null;
  return (
    FORM_FONTS.find((f) => f.name.toLowerCase() === name.toLowerCase()) ?? {
      name,
      weights: '',
      kind: 'sans',
    }
  );
}

/** Where the browser gets a font from Google; null for HandsFreeOS's own, which every page has. */
export function formFontHref(name: string | null | undefined): string | null {
  const font = formFontOf(name);
  if (!font) return null;
  const family = font.name.replace(/ /g, '+');
  return `https://fonts.googleapis.com/css2?family=${family}${font.weights ? `:wght@${font.weights}` : ''}&display=swap`;
}

/** What stands in while a font loads, or where it never does. */
export const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
export const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";

/** A font as CSS writes it, with what stands in for it; null for HandsFreeOS's own (the page's already). */
export function fontStackOf(name: string | null | undefined): string | null {
  const font = formFontOf(name);
  if (!font) return null;
  return `'${font.name}', ${font.kind === 'serif' ? SERIF_FALLBACK : SANS_FALLBACK}`;
}
