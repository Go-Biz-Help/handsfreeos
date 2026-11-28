/**
 * The copy of a business's templates and links that the HandsFreeOS keyboard reads (docs/phone-keyboard.md).
 *
 * The keyboard is native code (Swift on iPhone, Kotlin on Android) that never goes online and holds no sign-in, so
 * the app works everything out here and writes the result where the keyboard can read it: the App Group on iPhone,
 * the app's own preferences on Android. Every template is split into parts ahead of time: the business's own details
 * and links are filled in already, a first name is a part the keyboard asks for (the owner's pick, 27 Nov 2026), and a
 * placeholder nothing on a phone can fill (a lead's title) stays as typed, named in the template's note. All the
 * keyboard does is join the parts.
 *
 * Browser-safe and pure: the phone gathers the rows, this decides what they say.
 */
import { formatPhone } from '../crm/phone';
import { publicFormPath } from '../forms/links';
import { parseTag, render } from '../workflows/templates';
import {
  KEYBOARD_NAME_FALLBACK,
  KEYBOARD_PANEL_WORDS,
  keyboardGapsNote,
  type KeyboardPanelWords,
} from './words';

/** Bumped when the shape changes: a keyboard reads only the versions it knows, and says to update the app. */
export const KEYBOARD_DATA_VERSION = 1;

/** Where the app keeps the copy, under the shared store (modules/hfos-shared). */
export const KEYBOARD_DATA_KEY = 'keyboard';
/** What the iPhone keyboard writes back when it opens with Full Access, so the setup screen can say it works. */
export const KEYBOARD_SEEN_KEY = 'keyboard-seen';

/**
 * Kept small on purpose: the App Group isn't the encrypted copy of the business, a keyboard has little memory, and
 * nobody scrolls past a couple of hundred templates on a keyboard.
 */
export const KEYBOARD_LIMITS = {
  templates: 200,
  templateChars: 4000,
  links: 80,
  businesses: 10,
} as const;

export type KeyboardPart =
  | { readonly text: string }
  /** A first name the keyboard asks for; `fallback` goes in when it's skipped. */
  | {
      readonly ask: 'first_name';
      readonly fallback: string;
      readonly transform: 'upper' | 'lower' | null;
    };

export interface KeyboardTemplate {
  readonly id: string;
  readonly name: string;
  /** Its folder in Settings → Templates; null for none. */
  readonly folder: string | null;
  readonly channel: 'sms' | 'email';
  readonly parts: readonly KeyboardPart[];
  /** True when one of the parts asks for a first name. */
  readonly asks: boolean;
  /** One line to show under the name, with the first name shown as its fallback. */
  readonly preview: string;
  /** "Fill in {{lead.title}} before you send it.", or null when nothing is left to fill. */
  readonly note: string | null;
}

export type KeyboardLinkKind = 'booking' | 'form' | 'review' | 'website';

export interface KeyboardLink {
  readonly kind: KeyboardLinkKind;
  readonly name: string;
  /** What it is, under its name: "Booking page", "Survey". */
  readonly detail: string;
  readonly url: string;
}

export interface KeyboardBusiness {
  readonly id: string;
  readonly name: string;
  readonly templates: readonly KeyboardTemplate[];
  readonly links: readonly KeyboardLink[];
  /** When the app last built it (ISO). */
  readonly updatedAt: string;
}

export interface KeyboardData {
  readonly v: typeof KEYBOARD_DATA_VERSION;
  /** The business the app had open last: the keyboard starts on it until the person picks another there. */
  readonly current: string | null;
  readonly businesses: readonly KeyboardBusiness[];
  readonly words: KeyboardPanelWords;
}

// ---------- what the phone gathers ----------

export interface KeyboardTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly channel: string;
  readonly body: string;
  readonly folder: string | null;
  readonly archivedAt?: string | null;
}

export interface KeyboardCalendarRow {
  readonly name: string;
  readonly slug: string | null;
  readonly status: string;
  /** 1 or true when customers can book it themselves. */
  readonly public: boolean | number | null;
  readonly createdAt: string | null;
}

export interface KeyboardFormRow {
  readonly name: string;
  readonly slug: string | null;
  readonly mode: string;
}

export interface KeyboardBusinessInput {
  readonly id: string;
  /** The business's name (the workspace's). */
  readonly name: string;
  /** The workspace's settings: `website`, `links.review` (or the older `reviewUrl`). */
  readonly settings: unknown;
  /** Its booking site: the name customers see, its link name and whether it's on. */
  readonly site: {
    readonly slug: string | null;
    readonly name: string | null;
    readonly enabled: boolean;
  } | null;
  /** Where its public pages are: its own domain once one is serving, else HandsFreeOS's address. No trailing slash. */
  readonly origin: string;
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly calendars: readonly KeyboardCalendarRow[];
  readonly forms: readonly KeyboardFormRow[];
  /** Null when the templates couldn't be read (no signal, or no Inbox here): the business gets links only. */
  readonly templates: readonly KeyboardTemplateRow[] | null;
  readonly now: string;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const truthy = (v: boolean | number | null) => v === true || v === 1;

/** The business's name as customers see it: its booking site's, else its own (as the worker's {{business.name}}). */
export function keyboardBusinessName(input: Pick<KeyboardBusinessInput, 'name' | 'site'>): string {
  return text(input.site?.name) ?? input.name;
}

/** The calendars customers can book, oldest first, as {{links.booking}} picks its main one (worker's RunData). */
function bookable(input: KeyboardBusinessInput) {
  if (!input.site?.enabled || !text(input.site.slug)) return [];
  return input.calendars
    .filter((c) => c.status === 'active' && truthy(c.public) && text(c.slug))
    .slice()
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/** Every link the keyboard offers for the business: booking pages, live forms, the review link and the website. */
export function keyboardLinks(input: KeyboardBusinessInput): KeyboardLink[] {
  const k = KEYBOARD_PANEL_WORDS.kinds;
  const links: KeyboardLink[] = [];
  const site = text(input.site?.slug);
  for (const c of bookable(input))
    links.push({
      kind: 'booking',
      name: c.name,
      detail: k.booking,
      url: `${input.origin}/book/${site}/${c.slug}`,
    });
  if (site)
    for (const f of [...input.forms].sort((a, b) => a.name.localeCompare(b.name))) {
      // A live poll is asked in a video call, never sent as a link (webinars, part 2).
      if (!text(f.slug) || f.mode === 'poll') continue;
      links.push({
        kind: 'form',
        name: f.name,
        detail: f.mode === 'survey' ? k.survey : f.mode === 'quiz' ? k.quiz : k.form,
        url: `${input.origin}${publicFormPath(site, f.slug!)}`,
      });
    }
  const settings = record(input.settings);
  const review = text(record(settings['links'])['review']) ?? text(settings['reviewUrl']);
  if (review) links.push({ kind: 'review', name: k.review, detail: review, url: review });
  const website = text(settings['website']);
  if (website) links.push({ kind: 'website', name: k.website, detail: website, url: website });
  return links.slice(0, KEYBOARD_LIMITS.links);
}

/** What a template's placeholders read on the keyboard, before any customer is known. */
function businessValues(input: KeyboardBusinessInput): Record<string, unknown> {
  const settings = record(input.settings);
  const [main] = bookable(input);
  const site = text(input.site?.slug);
  return {
    business: {
      name: keyboardBusinessName(input),
      phone: input.phoneE164 ? formatPhone(input.phoneE164) : null,
      email: input.email,
      website: text(settings['website']),
    },
    links: {
      booking: main && site ? `${input.origin}/book/${site}/${main.slug}` : null,
      review: text(record(settings['links'])['review']) ?? text(settings['reviewUrl']),
    },
  };
}

const TAG = /\{\{([^{}]*)\}\}/g;

/**
 * Splits a template's words into the keyboard's parts: the business's details filled in, a first name asked for,
 * and anything else that can't be known (a lead's title, an appointment's time) left as typed and named in `left`.
 */
export function keyboardParts(
  body: string,
  values: Record<string, unknown>,
): { readonly parts: KeyboardPart[]; readonly left: string[] } {
  const parts: KeyboardPart[] = [];
  const left: string[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && 'text' in last) parts[parts.length - 1] = { text: last.text + t };
    else parts.push({ text: t });
  };
  let at = 0;
  for (const m of body.matchAll(TAG)) {
    pushText(body.slice(at, m.index));
    at = m.index + m[0].length;
    const tag = parseTag(m[1] ?? '');
    if (tag.valid && tag.path === 'person.first_name') {
      const fallback = tag.filters.find((f) => f.name === 'default')?.arg;
      const transform = [...tag.filters]
        .reverse()
        .find((f) => f.name === 'upper' || f.name === 'lower')?.name as
        'upper' | 'lower' | undefined;
      parts.push({
        ask: 'first_name',
        fallback: fallback && fallback.trim() ? fallback : KEYBOARD_NAME_FALLBACK,
        transform: transform ?? null,
      });
      continue;
    }
    const out = tag.valid ? render(m[0], values) : { text: '', missing: [tag.path] };
    if (out.missing.length || !tag.valid) {
      pushText(m[0]);
      for (const p of out.missing.length ? out.missing : [tag.path])
        if (!left.includes(p)) left.push(p);
    } else pushText(out.text);
  }
  pushText(body.slice(at));
  return { parts, left };
}

/** The words a template types with every first name as its fallback, on one line. */
function previewOf(parts: readonly KeyboardPart[]): string {
  const whole = parts.map((p) => ('text' in p ? p.text : p.fallback)).join('');
  return whole.replace(/\s+/g, ' ').trim();
}

/** One business, as the keyboard holds it. */
export function buildKeyboardBusiness(input: KeyboardBusinessInput): KeyboardBusiness {
  const values = businessValues(input);
  const templates = (input.templates ?? [])
    .filter((t) => !t.archivedAt && (t.channel === 'sms' || t.channel === 'email') && t.body.trim())
    .slice(0, KEYBOARD_LIMITS.templates)
    .map((t): KeyboardTemplate => {
      const { parts, left } = keyboardParts(t.body.slice(0, KEYBOARD_LIMITS.templateChars), values);
      return {
        id: t.id,
        name: t.name,
        folder: text(t.folder),
        channel: t.channel as 'sms' | 'email',
        parts,
        asks: parts.some((p) => 'ask' in p),
        preview: previewOf(parts),
        note: left.length ? keyboardGapsNote(left) : null,
      };
    });
  return {
    id: input.id,
    name: keyboardBusinessName(input),
    templates,
    links: keyboardLinks(input),
    updatedAt: input.now,
  };
}

/**
 * The whole copy: the business just built goes first (it's the one open), the others the person opened on this phone
 * stay as they were, and any business they're no longer in is dropped.
 */
export function buildKeyboardData(
  previous: KeyboardData | null,
  business: KeyboardBusiness,
  stillMember: ReadonlySet<string>,
): KeyboardData {
  const others = (previous?.businesses ?? []).filter(
    (b) => b.id !== business.id && stillMember.has(b.id),
  );
  return {
    v: KEYBOARD_DATA_VERSION,
    current: business.id,
    businesses: [business, ...others].slice(0, KEYBOARD_LIMITS.businesses),
    words: KEYBOARD_PANEL_WORDS,
  };
}

/** Reads a copy written before, or null for anything else (an older shape, a broken file). */
export function readKeyboardData(json: string | null): KeyboardData | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<KeyboardData> | null;
    if (!value || value.v !== KEYBOARD_DATA_VERSION || !Array.isArray(value.businesses))
      return null;
    return value as KeyboardData;
  } catch {
    return null;
  }
}

/** What the iPhone keyboard last said when it opened with Full Access. */
export interface KeyboardSeen {
  readonly at: string;
  readonly fullAccess: boolean;
}

export function readKeyboardSeen(json: string | null): KeyboardSeen | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<KeyboardSeen> | null;
    return value && typeof value.at === 'string'
      ? { at: value.at, fullAccess: value.fullAccess === true }
      : null;
  } catch {
    return null;
  }
}
