/**
 * What Ava read on the business's website for quick setup (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §6):
 * turning the model's reading into what the screens start from, and reading it back from the website's settings.
 * The model only proposes; a person checks everything on the screens. Browser-safe.
 */
import { QualifyingQuestion } from '../ai-team/config';
import { AiSetupHours, AiSetupService } from './answers';
import { asksAboutWhoSomeoneIs } from './kinds';
import { AI_SETUP_FOUND_KEY, AiSetupFound } from './state';

/** At most this many of each, so what's kept stays small and the screens stay short. */
export const AI_SETUP_FOUND_LIMITS = {
  services: 12,
  serviceDescription: 200,
  questions: 6,
  options: 6,
  optionLength: 60,
} as const;

/** The model's reading of the pages, before it's checked. */
export interface AiSetupSiteReading {
  readonly description: string;
  readonly services: readonly { readonly name: string; readonly description: string }[];
  readonly area: string;
  readonly hours: readonly { readonly day: number; readonly start: string; readonly end: string }[];
  /** The quick facts it was asked (`quickFactsFor`) that the pages answer. */
  readonly facts?: readonly { readonly key: string; readonly answer: string }[];
  readonly questions: readonly {
    readonly question: string;
    readonly kind: string;
    readonly options: readonly string[];
  }[];
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => {
  const t = squash(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const key = (s: string) => squash(s).toLowerCase();

/** A question's id from its words: "how_soon_do_you_need_it". */
function questionId(question: string, taken: ReadonlySet<string>): string {
  const base =
    key(question)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32)
      .replace(/_+$/, '') || 'question';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/**
 * The questions worth offering: none that asks who someone is (`PROTECTED_WORDS`), none with an apostrophe (a
 * text would drop to the slower encoding), no repeats, each one a valid question.
 */
function questionsOf(read: AiSetupSiteReading['questions']): QualifyingQuestion[] {
  const out: QualifyingQuestion[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const q of read) {
    const options = q.options
      .map(squash)
      .filter((o) => o && o.length <= AI_SETUP_FOUND_LIMITS.optionLength)
      .slice(0, AI_SETUP_FOUND_LIMITS.options);
    const words = [q.question, ...options].join(' ');
    if (/['’‘`]/.test(words) || asksAboutWhoSomeoneIs(words)) continue;
    if (seen.has(key(q.question))) continue;
    const kind = q.kind === 'choice' || q.kind === 'yes_no' ? q.kind : 'text';
    const parsed = QualifyingQuestion.safeParse({
      id: questionId(q.question, ids),
      question: squash(q.question),
      kind,
      options: kind === 'choice' ? options : [],
    });
    if (!parsed.success) continue;
    out.push(parsed.data);
    ids.add(parsed.data.id);
    seen.add(key(q.question));
    if (out.length >= AI_SETUP_FOUND_LIMITS.questions) break;
  }
  return out;
}

const Checked = AiSetupFound.omit({ at: true });

/** A time as "7:30" or "07:30", as the hours keep it ("07:30"). */
const clock = (s: string) => s.trim().replace(/^(\d):/, '0$1:');

/** The quick facts' answers: only the ones asked (`keys`), yes or no, the first answer for each. */
function factsOf(
  read: AiSetupSiteReading['facts'],
  keys: readonly string[],
): Record<string, 'yes' | 'no'> {
  const asked = new Set(keys);
  const out: Record<string, 'yes' | 'no'> = {};
  for (const f of read ?? []) {
    const answer = f.answer.trim().toLowerCase();
    if (!asked.has(f.key) || f.key in out || (answer !== 'yes' && answer !== 'no')) continue;
    out[f.key] = answer;
  }
  return out;
}

/**
 * What the screens can start from, from the model's reading of `url`: checked, trimmed and without repeats, as
 * `ai_setup.note_found` keeps it. Hours that can't be open hours (overlapping, or not times) count as none, and
 * only the quick facts asked (`factKeys`) are kept.
 */
export function aiSetupFoundFrom(
  read: AiSetupSiteReading,
  url: string,
  factKeys: readonly string[] = [],
): Omit<AiSetupFound, 'at'> {
  const names = new Set<string>();
  const services: AiSetupService[] = [];
  for (const s of read.services) {
    const parsed = AiSetupService.safeParse({
      name: clip(s.name, 120),
      description: clip(s.description, AI_SETUP_FOUND_LIMITS.serviceDescription),
    });
    if (!parsed.success || names.has(key(parsed.data.name))) continue;
    names.add(key(parsed.data.name));
    services.push(parsed.data);
    if (services.length >= AI_SETUP_FOUND_LIMITS.services) break;
  }
  const hours = AiSetupHours.safeParse(
    read.hours.map((h) => ({ day: h.day, start: clock(h.start), end: clock(h.end) })),
  );
  return Checked.parse({
    url,
    description: clip(read.description, 2000),
    services,
    area: clip(read.area, 500),
    openHours: hours.success && hours.data.length ? hours.data : null,
    facts: factsOf(read.facts, factKeys),
    questions: questionsOf(read.questions),
  });
}

/** Where the website's settings note that quick setup asked Ava to read it, and when. */
export const AI_SETUP_READ_ASKED_KEY = 'aiSetupReadAsked';
/** Asked again after this long when nothing came of it (the site was down, or no AI was set up). */
export const AI_SETUP_READ_AGAIN_MS = 10 * 60_000;
/** The screens wait this long for what Ava reads, then ask instead; it still fills them in if it comes later. */
export const AI_SETUP_READING_MS = 2 * 60_000;

/** When quick setup last asked Ava to read this address; null when it hasn't. */
function readAskedAt(source: { readonly url: string; readonly settings: unknown }): number | null {
  const settings =
    source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
      ? (source.settings as Record<string, unknown>)
      : {};
  const asked = (settings[AI_SETUP_READ_ASKED_KEY] ?? {}) as { url?: unknown; at?: unknown };
  const at = typeof asked.at === 'string' ? Date.parse(asked.at) : Number.NaN;
  return asked.url === source.url && Number.isFinite(at) ? at : null;
}

/** Whether to ask Ava to read the website: nothing read at its address, and not asked lately. */
export function aiSetupReadDue(
  source: { readonly url: string; readonly settings: unknown },
  now: Date,
): boolean {
  if (aiSetupFoundOf(source)) return false;
  const at = readAskedAt(source);
  return at === null || now.getTime() - at >= AI_SETUP_READ_AGAIN_MS;
}

/** Whether Ava is reading the website now: asked to lately, with nothing kept yet. */
export function aiSetupReading(
  source: { readonly url: string; readonly settings: unknown },
  now: Date,
): boolean {
  if (aiSetupFoundOf(source)) return false;
  const at = readAskedAt(source);
  return at !== null && now.getTime() - at < AI_SETUP_READING_MS;
}

/** What was read on the website, from its settings in Knowledge; null when nothing was, or it was another address. */
export function aiSetupFoundOf(source: {
  readonly url: string;
  readonly settings: unknown;
}): AiSetupFound | null {
  const settings =
    source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
      ? (source.settings as Record<string, unknown>)
      : {};
  const found = AiSetupFound.safeParse(settings[AI_SETUP_FOUND_KEY]);
  return found.success && found.data.url === source.url ? found.data : null;
}
