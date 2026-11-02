/**
 * How a form looks to the people filling it in (the editor's Design tab): its colours, font, shape and layout.
 * It's part of the definition, so a new look goes live with Publish like any other change, and a half-done one
 * never shows on a client's website. Browser-safe: the public page and the editor's preview work the look out
 * with the same `formLook`, so the preview is what goes live.
 *
 * - Every colour left unset follows the business: its buttons take the business's own colour (Settings →
 *   Workspace, under the logo), darkened just enough for white words, as on its booking page; the rest are
 *   worked out from the background.
 * - A form on a website with no background of its own is see-through, so it sits on the site's own background.
 * - Match my website fills this in from the business's website, and says which site and when (`matched`).
 */
import { z } from 'zod';
import { contrastRatio, readableTextOn } from '../chat/origins';
import { buttonColorFor, isLookColor, LOOK_DEFAULT_COLOR, mixColors } from '../look/colour';

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
const FONT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]| (?! ))*[A-Za-z0-9]$/;

const colour = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isLookColor, { error: 'Use a colour like #2d69d8.' })
  .nullable()
  .default(null);

export const FormDesignColors = z.object({
  /** The send and Next buttons, a picked answer, the progress bar. Unset: the business's own colour. */
  button: colour,
  /** The words on those buttons. Unset: white or near-black, whichever reads on the button. */
  buttonText: colour,
  /** Behind the whole form. Unset: white (or near-black when dark), and see-through on a website. */
  background: colour,
  /** The questions and answers. Unset: near-black or white, whichever reads on the background. */
  text: colour,
  /** Inside the boxes people type in. */
  field: colour,
  /** Around those boxes and the answers to pick. */
  fieldBorder: colour,
  /** A mistake ("Answer this one") and the stars on questions that need an answer. */
  error: colour,
});
export type FormDesignColors = z.infer<typeof FormDesignColors>;

export const FORM_TEXT_SIZES = ['small', 'medium', 'large'] as const;
export const FORM_CORNERS = ['square', 'slight', 'round'] as const;
export const FORM_FIELD_STYLES = ['boxed', 'filled', 'underline'] as const;
export const FORM_SPACINGS = ['compact', 'normal', 'roomy'] as const;
export const FORM_LABEL_PLACES = ['above', 'inside'] as const;
export const FORM_WIDTHS = ['narrow', 'medium', 'wide', 'full'] as const;

export const FormDesign = z.object({
  /** Light or dark: what the colours left unset are worked out from. */
  scheme: z.enum(['light', 'dark']).default('light'),
  colors: FormDesignColors.prefault({}),
  /** A Google font's name; null is HandsFreeOS's own. */
  font: z
    .string()
    .trim()
    .max(60)
    .regex(FONT_NAME, { error: 'Pick a font from the list.' })
    .nullable()
    .default(null),
  textSize: z.enum(FORM_TEXT_SIZES).default('medium'),
  corners: z.enum(FORM_CORNERS).default('slight'),
  /** Boxed all round, filled in, or a line underneath. */
  fields: z.enum(FORM_FIELD_STYLES).default('boxed'),
  button: z
    .object({
      style: z.enum(['filled', 'outline']).default('filled'),
      /** As wide as the form, or as wide as its words. */
      fullWidth: z.boolean().default(true),
    })
    .prefault({}),
  spacing: z.enum(FORM_SPACINGS).default('normal'),
  /** Each question's words above its box, or inside it until they start typing (boxes people type in only). */
  labels: z.enum(FORM_LABEL_PLACES).default('above'),
  /** How wide the form gets before it stops growing. */
  width: z.enum(FORM_WIDTHS).default('medium'),
  /** The business's logo at the top. */
  showLogo: z.boolean().default(false),
  /** Filled in from a website by Match my website: which site, and when. A person's change leaves it be. */
  matched: z
    .object({ site: z.string().trim().max(300), at: z.iso.datetime() })
    .nullable()
    .default(null),
});
export type FormDesign = z.infer<typeof FormDesign>;
export type FormDesignInput = z.input<typeof FormDesign>;

/** A design with nothing set: what every form had before the Design tab. */
export const DEFAULT_FORM_DESIGN: FormDesign = FormDesign.parse({});

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

const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";

const RADII: Record<FormDesign['corners'], { control: string; menu: string; card: string }> = {
  square: { control: '0px', menu: '0px', card: '0px' },
  slight: { control: '8px', menu: '10px', card: '12px' },
  // Pills for buttons and one-line boxes (they're 36 to 44 high); a box for a long answer stops at 16 (globals.css).
  round: { control: '22px', menu: '22px', card: '20px' },
};
const ZOOM: Record<FormDesign['textSize'], string> = { small: '0.93', medium: '1', large: '1.12' };
/** Space between questions. */
const GAP: Record<FormDesign['spacing'], string> = {
  compact: '1rem',
  normal: '1.5rem',
  roomy: '2.25rem',
};
const MAX_WIDTH: Record<FormDesign['width'], string> = {
  narrow: '480px',
  medium: '672px',
  wide: '880px',
  full: 'none',
};

const LIGHT = { background: '#ffffff', text: '#191d25', error: '#c43335', success: '#008743' };
const DARK = { background: '#191d25', text: '#f2f4f8', error: '#ff7b73', success: '#3ccf7a' };

/** b mixed into a, as a share of b (0 to 1). */
const tint = (base: string, toward: string, share: number) => mixColors(base, toward, share);

/** A colour moved toward `toward` in small steps until it reads at `ratio` on `on`. */
function readableOn(color: string, on: string, toward: string, ratio: number): string {
  let out = color;
  for (let t = 0.05; contrastRatio(out, on) < ratio && t <= 1; t += 0.05)
    out = mixColors(color, toward, t);
  return out;
}

export interface FormLook {
  /** CSS custom properties for the element the form sits in: the app's colour tokens, the corners and the rest. */
  readonly vars: Readonly<Record<string, string>>;
  /** Data attributes the stylesheet reads (globals.css, `.form-look`): field and button styles, labels. */
  readonly data: Readonly<Record<string, string>>;
  /** Whether the form paints a background of its own; false on a website with no background set. */
  readonly paintsBackground: boolean;
  /** The Google font to load, or null for ours. */
  readonly fontHref: string | null;
  readonly dark: boolean;
  readonly labelsInside: boolean;
  readonly showLogo: boolean;
}

/**
 * A design worked out into what the page needs: every colour token the form's components use, so the visitor's
 * own dark mode never turns a form on a light website dark, and the business's colour where nothing else was
 * picked.
 */
export function formLook(
  design: FormDesign | null | undefined,
  options: {
    /** The business's own colour; null for HandsFreeOS's blue. */
    readonly businessColor?: string | null;
    /** On someone else's website (`?embed=1`). */
    readonly embedded?: boolean;
  } = {},
): FormLook {
  const d = design ?? DEFAULT_FORM_DESIGN;
  const c = d.colors;
  const dark = d.scheme === 'dark';
  const scheme = dark ? DARK : LIGHT;
  const base = c.background ?? scheme.background;
  const text = c.text ?? readableTextOnSurface(base, scheme.text);
  // The business's colour is darkened for white words, as on its booking page; one picked here is kept as it is.
  const accent =
    c.button ??
    buttonColorFor(isLookColor(options.businessColor) ? options.businessColor : LOOK_DEFAULT_COLOR);
  const onAccent = c.buttonText ?? readableTextOn(accent);
  const accentText = readableOn(accent, base, text, 4.5);
  const error = c.error ?? scheme.error;
  const errorText = readableOn(error, base, text, 4.5);
  const field = c.field ?? (dark ? tint(base, text, 0.05) : '#ffffff');
  const border = c.fieldBorder ?? tint(base, text, 0.2);
  const radii = RADII[d.corners];
  const font = formFontOf(d.font);
  const paintsBackground = !options.embedded || c.background !== null;
  const vars: Record<string, string> = {
    '--bg': base,
    '--card': field,
    '--card-2': tint(base, text, 0.05),
    '--card-3': tint(base, text, 0.1),
    '--border': c.fieldBorder ?? tint(base, text, 0.12),
    '--border-strong': border,
    '--text': text,
    '--text-2': tint(text, base, 0.25),
    '--text-3': tint(text, base, 0.38),
    '--placeholder': tint(text, base, 0.55),
    '--accent': accent,
    '--accent-hover': tint(accent, dark ? '#ffffff' : '#000000', 0.14),
    '--accent-text': accentText,
    '--accent-soft': tint(base, accent, 0.1),
    '--accent-soft-2': tint(base, accent, 0.18),
    '--ring': `color-mix(in oklab, ${accent} ${dark ? 45 : 28}%, transparent)`,
    '--danger': error,
    '--danger-text': errorText,
    '--danger-soft': tint(base, error, 0.1),
    '--success': scheme.success,
    '--success-text': readableOn(scheme.success, base, text, 4.5),
    '--success-soft': tint(base, scheme.success, 0.12),
    '--on-solid': onAccent,
    '--form-on-accent': onAccent,
    '--form-surface': paintsBackground ? base : 'transparent',
    '--radius-control': radii.control,
    '--radius-menu': radii.menu,
    '--radius-card': radii.card,
    '--form-zoom': ZOOM[d.textSize],
    '--form-gap': GAP[d.spacing],
    '--form-max-width': MAX_WIDTH[d.width],
  };
  if (font)
    vars['--form-font'] =
      `'${font.name}', ${font.kind === 'serif' ? SERIF_FALLBACK : SANS_FALLBACK}`;
  return {
    vars,
    data: {
      'data-fields': d.fields,
      'data-button': d.button.style,
      'data-button-width': d.button.fullWidth ? 'full' : 'auto',
      'data-labels': d.labels,
    },
    paintsBackground,
    fontHref: formFontHref(d.font),
    dark,
    labelsInside: d.labels === 'inside',
    showLogo: d.showLogo,
  };
}

/** The scheme's own text colour when it reads on the background, else whichever of white and near-black does. */
function readableTextOnSurface(background: string, preferred: string): string {
  if (contrastRatio(background, preferred) >= 4.5) return preferred;
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#191d25')
    ? '#ffffff'
    : '#191d25';
}
