/**
 * What quick setup's answers do (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): the answers a business
 * starts from, and the plan Save carries out, with what will change in words. Browser-safe: the web and the phone
 * show the same list `ai_setup.finish` then carries out.
 */
import { applyTeammatePatch, type TeammateConfig, type TeammatePatch } from '../ai-team/config';
import { diffTeammateConfigs, type TeammateNames } from '../ai-team/diff';
import { teammateConfigFromPreset } from '../ai-team/presets';
import type { WeeklyHours } from '../calendar/config';
import { formatHours } from '../calendar/format';
import type { KnowledgeProfile } from '../knowledge/profile';
import { money } from '../money/format';
import type { OnboardingGoal } from '../onboarding/steps';
import { DEFAULT_OPEN_HOURS } from '../schemas/workspace';
import { AiSetupAnswers, type AiSetupTone } from './answers';
import {
  quickFactsFor,
  SETUP_JOBS,
  SETUP_KIND_INFO,
  SETUP_TONES,
  setupFor,
  type SetupJob,
  type SetupKind,
} from './kinds';
import type { AiSetupState } from './state';
import { AI_SETUP_TONE_TEXTS } from './words';

// ---- Where it starts ----

/** The jobs a Getting started goal ticks: "Getting booked" books; every other goal replies to new leads. */
export function goalJobs(goal: OnboardingGoal | null): SetupJob[] {
  return goal === 'booked' ? ['answer', 'book', 'follow_up'] : ['reply', 'answer', 'follow_up'];
}

/** What a business new to quick setup starts with ticked: its goal's jobs, and its kind's. */
export function startingJobs(goal: OnboardingGoal | null, kind: SetupKind): SetupJob[] {
  const on = new Set<SetupJob>([...goalJobs(goal), ...SETUP_KIND_INFO[kind].adds]);
  return SETUP_JOBS.filter((j) => on.has(j));
}

/** The jobs a saved teammate does. */
export function jobsOf(config: TeammateConfig): SetupJob[] {
  const on: Record<SetupJob, boolean> = {
    reply: config.respond.enabled && config.respond.newLeads.enabled,
    answer: config.answer.enabled,
    book: config.book.enabled,
    qualify: config.qualify.enabled,
    follow_up: config.followUp.enabled,
  };
  return SETUP_JOBS.filter((j) => on[j]);
}

/** The tone a profile's tone of voice is: one of quick setup's own, its kind's when empty, else the person's own. */
export function toneOfProfile(tone: string, kind: SetupKind): AiSetupTone {
  const t = tone.trim();
  if (!t) return SETUP_KIND_INFO[kind].tone;
  return SETUP_TONES.find((k) => AI_SETUP_TONE_TEXTS[k] === t) ?? 'keep';
}

const saved = (state: AiSetupState, title: string) =>
  state.facts.find((f) => f.title === title && f.status !== 'archived') ?? null;

/** The quick facts as the facts quick setup saved say them. One a person rewrote is theirs, so it isn't answered. */
export function factAnswersOf(state: AiSetupState): Record<string, 'yes' | 'no'> {
  const out: Record<string, 'yes' | 'no'> = {};
  for (const f of quickFactsFor(state.industry)) {
    const live = saved(state, f.title);
    if (live?.body === f.yes) out[f.key] = 'yes';
    else if (live && f.no !== null && live.body === f.no) out[f.key] = 'no';
    // A No with nothing worth telling customers archived the Yes.
    else if (
      !live &&
      f.no === null &&
      state.facts.some((x) => x.title === f.title && x.status === 'archived' && x.body === f.yes)
    )
      out[f.key] = 'no';
  }
  return out;
}

/**
 * The quick facts as the website answers them (`state.found`), for the ones the business hasn't answered and has
 * no fact for: a fact a person wrote or rewrote is theirs.
 */
function factsFromSite(state: AiSetupState): Record<string, 'yes' | 'no'> {
  const read = state.found?.facts ?? {};
  const out: Record<string, 'yes' | 'no'> = {};
  for (const f of quickFactsFor(state.industry)) {
    const answer = read[f.key];
    if (answer && !saved(state, f.title)) out[f.key] = answer;
  }
  return out;
}

/**
 * The answers an agency can save to start its clients from: none of them is about one business. The open hours are
 * the onboarding setup's "hours" (the owner's 54A): a client starts from them only when neither it nor its website
 * says when it's open.
 */
export const AI_SETUP_TEMPLATE_FIELDS = [
  'jobs',
  'openHours',
  'answerWhen',
  'customHours',
  'name',
  'disclosure',
  'tone',
  'allowPrices',
  'questions',
] as const satisfies readonly (keyof AiSetupAnswers)[];
export type AiSetupTemplate = Pick<AiSetupAnswers, (typeof AI_SETUP_TEMPLATE_FIELDS)[number]>;

/** A field's value when it reads, else its default, so a stored value that no longer fits never stops the setup. */
function fieldOr<K extends keyof AiSetupAnswers>(key: K, value: unknown): AiSetupAnswers[K] {
  const shape = AiSetupAnswers.shape[key];
  const r = shape.safeParse(value);
  return (r.success ? r.data : shape.parse(undefined)) as AiSetupAnswers[K];
}

/**
 * Every answer picked before anyone answers. A business with a teammate starts from what's saved now; one without
 * starts from its Getting started goal and its kind of business, or from its agency's saved answers (each one that
 * still reads, `aiSetupTemplateOf`). What the business hasn't said yet (what it does, its services, where it works,
 * its hours, quick facts, questions for leads) starts from what Ava read on its website; hours the website doesn't
 * give come from the saved answers.
 */
export function startingAiSetupAnswers(
  state: AiSetupState,
  template: Partial<AiSetupTemplate> | null = null,
): AiSetupAnswers {
  const t = state.teammate?.config ?? null;
  const tpl = t ? null : template;
  const p = state.profile;
  const read = state.found;
  const tone =
    tpl?.tone && tpl.tone !== 'keep' && !p.tone.trim()
      ? tpl.tone
      : toneOfProfile(p.tone, state.kind);
  return {
    jobs: fieldOr('jobs', tpl?.jobs ?? (t ? jobsOf(t) : startingJobs(state.goal, state.kind))),
    description: fieldOr('description', p.description.trim() || read?.description),
    services: fieldOr(
      'services',
      p.services.length
        ? p.services.map((s) => ({ name: s.name, description: s.description }))
        : state.services.length
          ? state.services.map((s) => ({ name: s.name, description: '' }))
          : read?.services,
    ),
    area: fieldOr('area', p.serviceArea.trim() || read?.area),
    openHours: fieldOr(
      'openHours',
      state.openHours ?? read?.openHours ?? tpl?.openHours ?? DEFAULT_OPEN_HOURS,
    ),
    answerWhen: fieldOr('answerWhen', tpl?.answerWhen ?? t?.hours.mode),
    customHours: fieldOr('customHours', tpl?.customHours ?? t?.hours.custom),
    facts: { ...factsFromSite(state), ...factAnswersOf(state) },
    name: fieldOr('name', tpl?.name ?? t?.identity.name),
    disclosure: fieldOr('disclosure', tpl?.disclosure ?? t?.identity.disclosure),
    tone,
    allowPrices: tpl?.allowPrices !== undefined && !p.allowPrices ? tpl.allowPrices : p.allowPrices,
    topQuestions: [],
    keepFindings: [],
    dropFindings: [],
    questions: fieldOr(
      'questions',
      t?.qualify.questions.length
        ? t.qualify.questions
        : tpl?.questions?.length
          ? tpl.questions
          : read?.questions.length
            ? read.questions
            : setupFor(state.industry).questions,
    ),
    chat: (!!state.website || !!state.page) && !state.chat,
  };
}

// ---- The teammate ----

/** Ids for what Save makes, while the plan is only shown: the calendar and the chat. */
export const AI_SETUP_NEW_CALENDAR = '00000000-0000-4000-8000-00000000ca1e';
export const AI_SETUP_NEW_CHAT = '00000000-0000-4000-8000-0000000c4a75';

export interface AiSetupMade {
  /** The booking calendar Save made. */
  readonly calendarId?: string | null;
  /** The website chat Save added. */
  readonly widgetId?: string | null;
}

/**
 * The teammate's settings after quick setup: its jobs, name, how it says it's AI, when it answers, its questions,
 * the hand-off topics its kind adds, and the chat Save added. A new teammate starts with today's defaults for
 * everything not asked: texts on, email and chat once they're set up, alerts on the phone app and by text.
 */
export function teammateFromAiSetup(
  state: AiSetupState,
  answers: AiSetupAnswers,
  made: AiSetupMade = {},
): TeammateConfig {
  const base =
    state.teammate?.config ??
    teammateConfigFromPreset('blank', {
      industry: state.industry,
      emailAddressId: state.emailAddress?.id ?? null,
      widgetId: state.chat?.id ?? null,
    });
  const on = new Set(answers.jobs);
  const calendarIds = state.calendars.length
    ? state.calendars.map((c) => c.id)
    : made.calendarId
      ? [made.calendarId]
      : [];
  const replies = on.has('reply');
  const topics = [...base.handOff.sensitiveTopics];
  for (const topic of SETUP_KIND_INFO[state.kind].sensitiveTopics)
    if (!topics.some((x) => x.toLowerCase() === topic.toLowerCase())) topics.push(topic);
  const patch: TeammatePatch = {
    identity: { name: answers.name, disclosure: answers.disclosure },
    // Only when the answer changed: the section can be on with new leads off, which is the same No.
    ...(replies === jobsOf(base).includes('reply')
      ? {}
      : { respond: { enabled: replies, newLeads: { enabled: replies } } }),
    answer: { enabled: on.has('answer') },
    qualify: on.has('qualify')
      ? {
          enabled: true,
          questions: answers.questions,
          // When a lead qualifies, owners and admins hear.
          ...(base.qualify.whenQualified.notify
            ? {}
            : { whenQualified: { notify: { kind: 'admins' } } }),
        }
      : { enabled: false },
    book: {
      enabled: on.has('book'),
      ...(on.has('book') && !base.book.calendarIds.length ? { calendarIds } : {}),
    },
    followUp: { enabled: on.has('follow_up') },
    hours: {
      mode: answers.answerWhen,
      ...(answers.answerWhen === 'custom' ? { custom: answers.customHours } : {}),
    },
    handOff: { sensitiveTopics: topics.slice(0, 20) },
    // The chat Save added. A chat the business had stays as it is: who answers it is decided on its own page.
    ...(made.widgetId ? { channels: { chat: true, widgetId: made.widgetId } } : {}),
  };
  return applyTeammatePatch(base, patch);
}

// ---- The plan ----

/** A service's name as two lists match it: "Drain  Cleaning" is "drain cleaning". */
export const serviceNameKey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
const nameKey = serviceNameKey;
const hoursKey = (h: WeeklyHours | null) =>
  h
    ? JSON.stringify(
        [...h].sort(
          (a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
        ),
      )
    : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const joinAnd = (items: readonly string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const the = (noun: string, names: readonly string[]) =>
  `the ${names.length === 1 ? noun : `${noun}s`} ${joinAnd(names)}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The ZIP codes an answer to "Which cities or ZIP codes do you serve?" lists, when it's nothing else. */
export function zipCodesOnly(area: string): string[] | null {
  const parts = area
    .split(/[\s,;/]+|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || !parts.every((p) => /^\d{5}$/.test(p))) return null;
  return [...new Set(parts)];
}

/** The site's host, for its chat: "lonestarhvac.com". */
export function websiteHost(website: string): string {
  try {
    return new URL(website).host.replace(/^www\./i, '');
  } catch {
    return website;
  }
}

/** Where a new website chat goes: the website's host, else "your page" (the simple page). */
export const aiSetupChatPlace = (state: Pick<AiSetupState, 'website'>): string =>
  state.website ? websiteHost(state.website) : 'your page';

/** "Adds a website chat for lonestarhvac.com", or "Adds a chat to your page". */
export const aiSetupChatLine = (state: Pick<AiSetupState, 'website'>): string =>
  state.website
    ? `Adds a website chat for ${websiteHost(state.website)}`
    : 'Adds a chat to your page';

const PROFILE_FIELD_WORDS: Readonly<Partial<Record<keyof KnowledgeProfile, string>>> = {
  description: 'what you do',
  services: 'services',
  serviceArea: 'where you work',
  hours: 'hours',
  tone: 'tone of voice',
};

/** A service to add to Calendars → Services. */
export interface AiSetupServiceWrite {
  readonly name: string;
  readonly description: string;
  /** Null: an hour, as a new service starts. */
  readonly minutes: number | null;
  readonly priceCents: number | null;
}

/** A service as Calendars → Services takes it: its length when said (an hour otherwise), and its price. */
export const serviceWriteOf = (s: AiSetupAnswers['services'][number]): AiSetupServiceWrite => ({
  name: s.name,
  description: s.description,
  minutes: s.minutes ?? null,
  priceCents: s.priceCents ?? null,
});

export interface AiSetupFactWrite {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

export interface AiSetupPlan {
  /** Knowledge → Business profile after Save; null when it doesn't change. */
  readonly profile: KnowledgeProfile | null;
  /** Settings → Workspace's open hours; null when they don't change. */
  readonly openHours: WeeklyHours | null;
  readonly facts: {
    readonly create: readonly AiSetupFactWrite[];
    readonly update: readonly (AiSetupFactWrite & { readonly id: string })[];
    /** A No with nothing worth telling customers. */
    readonly archive: readonly { readonly id: string; readonly title: string }[];
  };
  /** "What do customers ask you most?", as FAQs. */
  readonly faqs: readonly { readonly question: string; readonly answer: string }[];
  /** Website findings to keep, and to turn down (only those still waiting are). */
  readonly keep: readonly string[];
  readonly drop: readonly string[];
  /** When Book is ticked and no calendar takes online bookings yet. */
  readonly booking: {
    /** Services to add to Calendars → Services, with their length and price when the business said. */
    readonly services: readonly AiSetupServiceWrite[];
    /** The calendar to make with every service on it, or null. */
    readonly calendar: string | null;
    /** A service area from a list of ZIP codes (home services only), or null. */
    readonly zipCodes: readonly string[] | null;
  };
  /** Add a website chat for the website. */
  readonly chat: boolean;
  /** The teammate's settings after Save; what Save makes is filled in as it's made. */
  readonly teammate: TeammateConfig;
  /** There's no teammate yet, so Save sets it up. */
  readonly creates: boolean;
  /** What will change, one line each. */
  readonly changes: readonly string[];
}

/** What "About your business" and "When are you open?" save: the open hours, and those parts of the profile. */
export interface AiSetupAboutPlan {
  /** Settings → Workspace's open hours; null when they don't change. */
  readonly openHours: WeeklyHours | null;
  /** Knowledge → Business profile with what you do, your services, where you work and your hours; null when same. */
  readonly profile: KnowledgeProfile | null;
  /** What will change, one line each. */
  readonly changes: readonly string[];
}

/** The open hours as answered, when they change, and what will change in words. */
function openHoursChange(state: Pick<AiSetupState, 'openHours'>, answers: AiSetupAnswers) {
  const openHours =
    hoursKey(answers.openHours) !== hoursKey(state.openHours) ? answers.openHours : null;
  const lines = openHours
    ? [
        state.openHours
          ? `Open hours: ${formatHours(state.openHours)} → ${formatHours(openHours)}`
          : `Open hours: ${formatHours(openHours)}`,
      ]
    : [];
  return { openHours, lines };
}

/** The profile with what "About your business" and "When are you open?" say; the rest of it as it is. */
function aboutProfile(
  state: Pick<AiSetupState, 'profile'>,
  answers: AiSetupAnswers,
  hoursChanged: boolean,
): KnowledgeProfile {
  const priceOf = new Map(state.profile.services.map((s) => [nameKey(s.name), s.price]));
  return {
    ...state.profile,
    description: answers.description,
    // A price said in the setup, else the one the profile has for that name.
    services: answers.services.map((s) => ({
      name: s.name,
      description: s.description,
      price: s.priceCents != null ? money(s.priceCents) : (priceOf.get(nameKey(s.name)) ?? null),
    })),
    serviceArea: answers.area,
    hours:
      answers.openHours.length && (hoursChanged || !state.profile.hours.trim())
        ? formatHours(answers.openHours)
        : state.profile.hours,
  };
}

/** "Business profile: what you do and services updated", for the parts of the profile that change. */
function profileLines(before: KnowledgeProfile, after: KnowledgeProfile): string[] {
  const lines: string[] = [];
  const fields = (Object.keys(PROFILE_FIELD_WORDS) as (keyof KnowledgeProfile)[])
    .filter((k) => !same(before[k], after[k]))
    .map((k) => PROFILE_FIELD_WORDS[k]!);
  if (fields.length) lines.push(`Business profile: ${joinAnd(fields)} updated`);
  if (before.allowPrices !== after.allowPrices)
    lines.push(`Tells customers your prices: ${after.allowPrices ? 'off → on' : 'on → off'}`);
  return lines;
}

/**
 * What "About your business" and "When are you open?" save on their own: the open hours, and what you do, your
 * services, where you work and your hours in the profile. Save does it with everything else; onboarding's simple
 * page does it as the page goes live, so the page shows them.
 */
export function planAiSetupAbout(
  state: Pick<AiSetupState, 'openHours' | 'profile'>,
  answers: AiSetupAnswers,
): AiSetupAboutPlan {
  const hours = openHoursChange(state, answers);
  const next = aboutProfile(state, answers, !!hours.openHours);
  const profile = same(next, state.profile) ? null : next;
  return {
    openHours: hours.openHours,
    profile,
    changes: [...hours.lines, ...(profile ? profileLines(state.profile, profile) : [])],
  };
}

/** What Save does with these answers. */
export function planAiSetup(state: AiSetupState, answers: AiSetupAnswers): AiSetupPlan {
  const lines: string[] = [];

  // Open hours, asked once for Settings and Knowledge.
  const hours = openHoursChange(state, answers);
  const openHours = hours.openHours;
  lines.push(...hours.lines);

  // The business profile.
  const nextProfile: KnowledgeProfile = {
    ...aboutProfile(state, answers, !!openHours),
    tone: answers.tone === 'keep' ? state.profile.tone : AI_SETUP_TONE_TEXTS[answers.tone],
    allowPrices: answers.allowPrices,
  };
  const profile = same(nextProfile, state.profile) ? null : nextProfile;
  if (profile) lines.push(...profileLines(state.profile, profile));

  // Quick facts. A fact a person rewrote stays theirs.
  const create: AiSetupFactWrite[] = [];
  const update: (AiSetupFactWrite & { id: string })[] = [];
  const archive: { id: string; title: string }[] = [];
  for (const f of quickFactsFor(state.industry)) {
    const answer = answers.facts[f.key];
    if (!answer) continue;
    const live = saved(state, f.title);
    if (live && live.body !== f.yes && live.body !== f.no) continue;
    const body = answer === 'yes' ? f.yes : f.no;
    if (body === null) {
      if (live) archive.push({ id: live.id, title: f.title });
    } else if (!live) create.push({ key: f.key, title: f.title, body });
    else if (live.body !== body) update.push({ id: live.id, key: f.key, title: f.title, body });
  }
  if (create.length)
    lines.push(
      `Adds ${the(
        'fact',
        create.map((f) => f.title),
      )}`,
    );
  if (update.length)
    lines.push(
      `Changes ${the(
        'fact',
        update.map((f) => f.title),
      )}`,
    );
  if (archive.length)
    lines.push(
      `Archives ${the(
        'fact',
        archive.map((f) => f.title),
      )}`,
    );

  const faqs = answers.topQuestions.map((q) => ({ question: q.question, answer: q.answer }));
  if (faqs.length) lines.push(`Adds ${count(faqs.length, 'answer', 'answers')} to Knowledge`);
  if (answers.keepFindings.length)
    lines.push(`Keeps ${count(answers.keepFindings.length, 'thing', 'things')} from your website`);
  if (answers.dropFindings.length)
    lines.push(
      `Turns down ${count(answers.dropFindings.length, 'thing', 'things')} from your website`,
    );

  // Booking: the services on "About your business" become a calendar customers can book.
  const book = answers.jobs.includes('book');
  const needsCalendar =
    book && !state.calendars.length && !state.teammate?.config.book.calendarIds.length;
  const known = new Set(state.services.map((s) => nameKey(s.name)));
  const newServices = needsCalendar
    ? answers.services.filter((s) => !known.has(nameKey(s.name))).map(serviceWriteOf)
    : [];
  const calendar =
    needsCalendar && state.services.length + newServices.length > 0
      ? setupFor(state.industry).calendar
      : null;
  const zipCodes =
    book && state.kind === 'home' && !state.territories ? zipCodesOnly(answers.area) : null;
  if (newServices.length)
    lines.push(
      `Adds ${the(
        'service',
        newServices.map((s) => s.name),
      )} to Calendars`,
    );
  if (calendar) lines.push(`Makes the booking calendar ${calendar}, with your services on it`);
  if (zipCodes)
    lines.push(
      `Checks ZIP codes before booking: adds a service area with ${count(zipCodes.length, 'ZIP code', 'ZIP codes')}`,
    );

  // The website chat, on the website or else the simple page.
  const chat = answers.chat && (!!state.website || !!state.page) && !state.chat;
  if (chat) lines.push(aiSetupChatLine(state));

  // The teammate.
  const teammate = teammateFromAiSetup(state, answers, {
    calendarId: calendar ? AI_SETUP_NEW_CALENDAR : null,
    widgetId: chat ? AI_SETUP_NEW_CHAT : null,
  });
  if (state.teammate) {
    const bookable = (id: string, name: string) => ({
      id,
      name,
      description: null,
      archived: false,
      bookableOnline: true,
      color: '',
      lengths: [],
    });
    const names: TeammateNames = {
      calendars: [
        ...state.calendars.map((c) => bookable(c.id, c.name)),
        ...(calendar ? [bookable(AI_SETUP_NEW_CALENDAR, calendar)] : []),
      ],
      chatWidgets: [
        ...(state.chat ? [state.chat] : []),
        ...(chat ? [{ id: AI_SETUP_NEW_CHAT, name: aiSetupChatPlace(state) }] : []),
      ],
      ...(state.emailAddress ? { emailAddresses: [state.emailAddress] } : {}),
    };
    lines.push(...diffTeammateConfigs(state.teammate.config, teammate, names));
  } else lines.unshift(`Sets up ${teammate.identity.name}, your AI teammate`);

  return {
    profile,
    openHours,
    facts: { create, update, archive },
    faqs,
    keep: answers.keepFindings,
    drop: answers.dropFindings,
    booking: { services: newServices, calendar, zipCodes },
    chat,
    teammate,
    creates: !state.teammate,
    changes: lines,
  };
}
