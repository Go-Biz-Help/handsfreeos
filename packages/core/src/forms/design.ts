/**
 * How a form looks to the people filling it in (the editor's Design tab): its colours, font, shape and layout.
 * It's part of the definition, so a new look goes live with Publish like any other change, and a half-done one
 * never shows on a client's website. Browser-safe: the public page and the editor's preview work the look out
 * with the same `formLook`, so the preview is what goes live.
 *
 * - Every colour left unset follows the business: its buttons take the business's own colour (Settings →
 *   Workspace, under the logo), darkened just enough for white words, as on its booking page; the rest are
 *   worked out from the background.
 * - An unset font or corners follow the brand kit (Settings → Workspace → Brand kit, `FormKit`), then HandsFreeOS's
 *   own: `designFontOf` and `designCornersOf` decide, and `formLook` takes the kit as `options.kit`.
 * - A form on a website with no background of its own is see-through, so it sits on the site's own background.
 * - Match my website fills this in from the business's website, and says which site and when (`matched`).
 */
import { z } from 'zod';
import { contrastRatio, readableTextOn } from '../chat/origins';
import { buttonColorFor, isLookColor, LOOK_DEFAULT_COLOR, mixColors } from '../look/colour';
import { FONT_NAME, fontStackOf, formFontHref } from '../look/fonts';
import { PictureRef } from '../look/pictures';

export {
  fontStackOf,
  FORM_DEFAULT_FONT,
  FORM_FONTS,
  formFontHref,
  formFontOf,
  isFontName,
  type FormFont,
} from '../look/fonts';

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
/** Where the top (logo, name and intro) and the send button sit: on the left, or in the middle. */
export const FORM_ALIGNS = ['left', 'center'] as const;
export type FormAlign = (typeof FORM_ALIGNS)[number];

export const FormDesign = z.object({
  /** Light or dark: what the colours left unset are worked out from. */
  scheme: z.enum(['light', 'dark']).default('light'),
  colors: FormDesignColors.prefault({}),
  /** A Google font's name; null follows the brand kit's, and HandsFreeOS's own when it has none. */
  font: z
    .string()
    .trim()
    .max(60)
    .regex(FONT_NAME, { error: 'Pick a font from the list.' })
    .nullable()
    .default(null),
  textSize: z.enum(FORM_TEXT_SIZES).default('medium'),
  /** Null follows the brand kit's (Settings → Workspace), and slight corners when it has none. */
  corners: z.enum(FORM_CORNERS).nullable().default(null),
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
  /** The form's name at the top. Hidden, screen readers still hear it; a website's own heading often says it. */
  showTitle: z.boolean().default(true),
  /** Line up: the logo, name and intro, and the send button, on the left or in the middle. */
  align: z.enum(FORM_ALIGNS).default('left'),
  /** A wide picture across the top (Your pictures), above the logo and name. */
  cover: PictureRef.nullable().default(null),
  /**
   * A picture behind the whole form (Your pictures), filling the page around it. The form keeps its own background
   * on top, so the questions always read.
   */
  backdrop: PictureRef.nullable().default(null),
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

export type FormCorners = (typeof FORM_CORNERS)[number];

/**
 * What a design leaves unset follows: the business's brand kit (Settings → Workspace, look/look.ts). Its colour is
 * `businessColor`; a font and corners it has none of are HandsFreeOS's own.
 */
export interface FormKit {
  readonly font?: string | null;
  readonly corners?: FormCorners | null;
}

/** The font a design is drawn in: its own, else the kit's; null is HandsFreeOS's own. */
export const designFontOf = (
  design: Pick<FormDesign, 'font'> | null | undefined,
  kit?: FormKit | null,
): string | null => design?.font ?? kit?.font ?? null;

/** The corners a design is drawn with: its own, else the kit's, else slight. */
export const designCornersOf = (
  design: Pick<FormDesign, 'corners'> | null | undefined,
  kit?: FormKit | null,
): FormCorners => design?.corners ?? kit?.corners ?? 'slight';

const RADII: Record<FormCorners, { control: string; menu: string; card: string }> = {
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
/**
 * A booking page's widths (a calendar's Design → Layout): the open times, then the details. Medium is what every
 * booking page had before it could pick.
 */
const BOOKING_WIDTH: Record<FormDesign['width'], readonly [times: string, details: string]> = {
  narrow: ['640px', '480px'],
  medium: ['860px', '560px'],
  wide: ['1040px', '640px'],
  full: ['none', '720px'],
};
/** A booking page's space between its parts, and between the boxes of its details; normal is as before. */
const BOOKING_GAP: Record<FormDesign['spacing'], readonly [parts: string, boxes: string]> = {
  compact: ['0.75rem', '0.625rem'],
  normal: ['1rem', '0.875rem'],
  roomy: ['1.5rem', '1.25rem'],
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
  /** The wide picture across the top, and the one behind the form (Your pictures), when the design has them. */
  readonly cover: PictureRef | null;
  readonly backdrop: PictureRef | null;
  /** Where the top and the send button sit. */
  readonly align: FormAlign;
  readonly dark: boolean;
  readonly labelsInside: boolean;
  readonly showLogo: boolean;
  readonly showTitle: boolean;
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
    /** The brand kit's font and corners, which a design that leaves them unset follows. */
    readonly kit?: FormKit | null;
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
  const radii = RADII[designCornersOf(d, options.kit)];
  const fontName = designFontOf(d, options.kit);
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
    '--booking-max-width': BOOKING_WIDTH[d.width][0],
    '--booking-details-width': BOOKING_WIDTH[d.width][1],
    '--booking-gap': BOOKING_GAP[d.spacing][0],
    '--booking-box-gap': BOOKING_GAP[d.spacing][1],
  };
  const stack = fontStackOf(fontName);
  if (stack) vars['--form-font'] = stack;
  return {
    vars,
    data: {
      'data-fields': d.fields,
      'data-button': d.button.style,
      'data-button-width': d.button.fullWidth ? 'full' : 'auto',
      'data-align': d.align,
      'data-labels': d.labels,
    },
    paintsBackground,
    fontHref: formFontHref(fontName),
    cover: d.cover,
    backdrop: d.backdrop,
    align: d.align,
    dark,
    labelsInside: d.labels === 'inside',
    showLogo: d.showLogo,
    showTitle: d.showTitle,
  };
}

/** The scheme's own text colour when it reads on the background, else whichever of white and near-black does. */
function readableTextOnSurface(background: string, preferred: string): string {
  if (contrastRatio(background, preferred) >= 4.5) return preferred;
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#191d25')
    ? '#ffffff'
    : '#191d25';
}
