/**
 * The business's logo and colour (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "Your logo and
 * colour"): what's kept, and where the logo is. Browser-safe.
 *
 * - They're kept in `workspaces.settings.look`, written only by the look commands (`workspace.update` refuses the
 *   key), and read forgivingly: a part that doesn't parse counts as never set.
 * - The logo is a PNG the worker made (`brand` bucket, public, so emails and the website chat can show it for
 *   good): from the business's website when it has one, else uploaded. Uploads land in the private
 *   `brand-uploads` bucket first, at a place `look.begin_upload` reserved, and the worker makes the PNG from them.
 * - The colour comes from the logo, or the website's own colour when the logo has none, until a person picks one.
 */
import { z } from 'zod';
import { isLookColor } from './colour';

export const LOOK_SETTINGS_KEY = 'look';

/** Where the logos the worker made are kept: public, so emails and websites can show them. */
export const LOOK_BUCKET = 'brand' as const;
/** Where uploaded pictures wait for the worker: private. */
export const LOOK_UPLOAD_BUCKET = 'brand-uploads' as const;

/** The pictures someone can upload as a logo, and the ending each is kept with. */
export const LOOK_UPLOAD_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
} as const;
export type LookUploadType = keyof typeof LOOK_UPLOAD_TYPES;
export const LOOK_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** How long the screens say the logo is being looked for or made ready, before they stop waiting. */
export const LOOK_WAIT_MS = 2 * 60_000;
/** A website is looked at again for its logo after this long, when nothing came of the last look. */
export const LOOK_ASK_AGAIN_MS = 10 * 60_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A logo the worker made: `<business>/logo/<id>.png`. */
export const LOOK_LOGO_PATH = new RegExp(`^${UUID}/logo/${UUID}\\.png$`);
/** A picture waiting in `brand-uploads`: `<business>/<id>.<ending>`. */
export const LOOK_UPLOAD_PATH = new RegExp(`^${UUID}/${UUID}\\.(?:png|jpg|webp|gif|svg)$`);

const at = z.iso.datetime();
const hex = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isLookColor, { error: 'Pick a colour like #2d69d8.' });

export const LookLogo = z.object({
  path: z.string().regex(LOOK_LOGO_PATH),
  width: z.int().min(1).max(4000),
  height: z.int().min(1).max(4000),
  /** Found on the business's website, or uploaded by someone. */
  from: z.enum(['website', 'upload']),
  at,
});
export type LookLogo = z.infer<typeof LookLogo>;

export const LookColor = z.object({
  hex,
  /** From the logo, the website's own colour, or picked by a person (which nothing found later replaces). */
  from: z.enum(['logo', 'website', 'person']),
  at,
});
export type LookColor = z.infer<typeof LookColor>;

/** A place reserved for an upload, and whether the picture's there for the worker yet. */
export const LookUpload = z.object({
  path: z.string().regex(LOOK_UPLOAD_PATH),
  name: z.string().max(200),
  by: z.uuid(),
  at,
  sent: z.boolean().default(false),
});
export type LookUpload = z.infer<typeof LookUpload>;

export const BusinessLookSchema = z.object({
  logo: LookLogo.nullable(),
  color: LookColor.nullable(),
  upload: LookUpload.nullable(),
  /** Why the last upload couldn't be used, in words for the person. */
  problem: z.object({ message: z.string().max(500), at }).nullable(),
  /** When the website was last looked at for a logo, and whether one was found there. */
  searched: z.object({ url: z.string().max(500), at, found: z.boolean() }).nullable(),
  /** When someone (or saving the website) asked for that. */
  asked: z.object({ url: z.string().max(500), at }).nullable(),
});
export type BusinessLook = z.infer<typeof BusinessLookSchema>;

export const NO_LOOK: BusinessLook = {
  logo: null,
  color: null,
  upload: null,
  problem: null,
  searched: null,
  asked: null,
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const part = <T>(schema: z.ZodType<T>, v: unknown): T | null => {
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
};

/** The business's look from its settings, a part at a time: one that doesn't parse counts as never set. */
export function lookOf(settings: unknown): BusinessLook {
  const look = asRecord(asRecord(settings)[LOOK_SETTINGS_KEY]);
  return {
    logo: part(LookLogo, look['logo']),
    color: part(LookColor, look['color']),
    upload: part(LookUpload, look['upload']),
    problem: part(BusinessLookSchema.shape.problem, look['problem']),
    searched: part(BusinessLookSchema.shape.searched, look['searched']),
    asked: part(BusinessLookSchema.shape.asked, look['asked']),
  };
}

/** A logo wider than this usually spells the name out, so it stands for the name on its own. */
export const LOOK_WIDE_LOGO = 1.6;

export const isWideLogo = (
  logo: { readonly width: number; readonly height: number } | null | undefined,
): boolean => !!logo && logo.width / logo.height > LOOK_WIDE_LOGO;

/**
 * The size a logo is drawn at in a mark `size` pixels high, on the web and the phone: 3 pixels in from its edges,
 * its shape kept, and a wide one up to five times as wide as the mark is high.
 */
export function logoBox(
  logo: { readonly width: number; readonly height: number },
  size: number,
): { width: number; height: number } {
  const inner = size - 6;
  const scale = Math.min(inner / logo.height, (isWideLogo(logo) ? size * 5 : inner) / logo.width);
  return {
    width: Math.max(1, Math.round(logo.width * scale)),
    height: Math.max(1, Math.round(logo.height * scale)),
  };
}

/** Where a logo the worker made can be seen by anyone: Supabase Storage's public address for it. */
export const logoUrlFor = (storageUrl: string, path: string): string =>
  `${storageUrl.replace(/\/+$/, '')}/storage/v1/object/public/${LOOK_BUCKET}/${path}`;

/**
 * What's happening with the look right now, for the screens: making an upload ready, or looking on the website (the
 * one last asked about, `look.asked.url`) until the worker says how it went or the screens stop waiting.
 */
export type LookProgress = 'idle' | 'making' | 'searching';

export function lookProgressOf(look: BusinessLook, now: Date): LookProgress {
  const recent = (iso: string) => now.getTime() - Date.parse(iso) < LOOK_WAIT_MS;
  if (look.upload?.sent && recent(look.upload.at)) return 'making';
  const asked = look.asked;
  if (
    !look.logo &&
    asked &&
    recent(asked.at) &&
    !(look.searched?.url === asked.url && look.searched.at >= asked.at)
  )
    return 'searching';
  return 'idle';
}

/**
 * Whether to look on the website for a logo: there's a website, no logo yet, and it hasn't been looked at (or asked
 * to be) lately at this address.
 */
export function lookSearchDue(look: BusinessLook, website: string | null, now: Date): boolean {
  if (!website || look.logo) return false;
  if (look.searched?.url === website) return false;
  const asked = look.asked?.url === website ? Date.parse(look.asked.at) : Number.NaN;
  return !Number.isFinite(asked) || now.getTime() - asked >= LOOK_ASK_AGAIN_MS;
}
