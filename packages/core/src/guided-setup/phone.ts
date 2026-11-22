/**
 * The guided phone number setup (the owner, 22 Nov 2026, "all your picks except 8b"): seven questions, one at a time,
 * then Check it over, where the number is bought and everything is set the way they said. People who don't want to
 * text skip the EIN question and quiet hours. The same answers open again later from Settings → Texting & calls
 * ("Run the guided setup again"), without the questions about getting a number.
 *
 * What the web and the phone both decide lives here: the answers as they are saved (guided_setup.save_draft, under
 * `phone`), which questions a path asks, what is wrong with an answer, the lines beside the questions, and what the
 * last screen sends (phone_setup.save). Browser-safe.
 */
import type { z } from 'zod';
import { formatPhone, normalizePhone } from '../crm/phone';
import type { PhoneSetupSaveInput } from '../schemas/telephony';

export const PHONE_SETUP_QUESTIONS = [
  'have',
  'texting',
  'ein',
  'number',
  'ring',
  'missed',
  'quiet',
] as const;
export type PhoneSetupQuestion = (typeof PHONE_SETUP_QUESTIONS)[number];
/** A question, or the last screen. */
export type PhoneSetupScreen = PhoneSetupQuestion | 'review';

export type PhoneSetupHave = 'new' | 'keep' | 'twilio';
export type PhoneSetupThen = 'teammate' | 'voicemail' | 'nothing';
export type PhoneSetupTeammateMode = 'no_answer' | 'after_hours' | 'always';
export type PhoneSetupQuiet = 'night' | 'custom' | 'never';
export type PhoneSetupNumberType = 'local' | 'toll_free';

/** A cell or desk phone that rings too, as typed: the number is checked when they press Next. */
export interface PhoneSetupPhone {
  readonly label: string;
  readonly number: string;
  readonly enabled: boolean;
}

/** The number picked from the search, kept with how it was shown so a return visit can say which one it was. */
export interface PhoneSetupPicked {
  readonly e164: string;
  readonly display: string;
  readonly numberType: PhoneSetupNumberType;
  /** "Huntsville, AL", or null for a toll-free number. */
  readonly place: string | null;
}

export interface PhoneSetupSearch {
  readonly city: string;
  readonly state: string;
  /** '' is the city itself; else a radius around it, in miles. */
  readonly miles: string;
  readonly areaCode: string;
  readonly digits: string;
}

export interface PhoneSetupAnswers {
  /** The screen they were last on, so coming back opens there. */
  readonly at: PhoneSetupScreen;
  readonly have: PhoneSetupHave | null;
  readonly texting: boolean | null;
  readonly ein: boolean | null;
  /** Toll-free or local, when they changed it on the number screen themselves; else the EIN answer decides. */
  readonly numberType: PhoneSetupNumberType | null;
  readonly number: PhoneSetupPicked | null;
  readonly search: PhoneSetupSearch;
  /** "A cell phone or desk phone too" is ticked. */
  readonly morePhones: boolean;
  readonly phones: readonly PhoneSetupPhone[];
  readonly callerId: 'customer' | 'business';
  readonly ringSeconds: number;
  readonly then: PhoneSetupThen | null;
  readonly teammateMode: PhoneSetupTeammateMode;
  /** The voicemail greeting; '' is the usual one. */
  readonly greeting: string;
  readonly quiet: PhoneSetupQuiet | null;
  readonly quietStart: string;
  readonly quietEnd: string;
}

export const PHONE_SETUP_RING_SECONDS = [15, 20, 25] as const;
export const PHONE_SETUP_MAX_PHONES = 3;
export const PHONE_SETUP_GREETING_MAX = 500;
/** What most businesses pick: no automatic texts from 8 PM until 8 AM. */
export const PHONE_SETUP_NIGHT = { start: '20:00', end: '08:00' } as const;

/** What the questions need to know about the business they are asked in. */
export interface PhoneSetupContext {
  /** `new`: no number yet, every question. `again`: the business has its number, so only what it does. */
  readonly mode: 'new' | 'again';
  readonly businessName: string;
  /** The business's AI teammate, or null when it has none yet. */
  readonly teammate: {
    readonly name: string;
    readonly on: boolean;
    /** Whether this person may change what the teammate does. */
    readonly canManage: boolean;
  } | null;
  /** In `again`: the carriers already have, or approved, the registration, so "do you want to text" isn't asked. */
  readonly textingSettled: boolean;
  /** In `again`: the business number, which a forwarding phone can't be. */
  readonly businessE164: string | null;
}

const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | null =>
  typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : null;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The answers a new setup starts from: the picks marked Best, and nothing chosen where only they can know. */
export function phoneSetupStart(
  ctx: Pick<PhoneSetupContext, 'teammate'>,
  near?: { readonly city: string; readonly state: string } | null,
): PhoneSetupAnswers {
  return {
    at: 'have',
    have: 'new',
    texting: true,
    ein: null,
    numberType: null,
    number: null,
    search: {
      city: near?.city ?? '',
      state: near?.state ?? '',
      miles: near ? '25' : '',
      areaCode: '',
      digits: '',
    },
    morePhones: false,
    phones: [],
    callerId: 'customer',
    ringSeconds: 20,
    then: !ctx.teammate || ctx.teammate.canManage ? 'teammate' : 'voicemail',
    teammateMode: 'no_answer',
    greeting: '',
    quiet: 'night',
    quietStart: PHONE_SETUP_NIGHT.start,
    quietEnd: PHONE_SETUP_NIGHT.end,
  };
}

/**
 * Saved answers read back, whatever shape they were left in: anything missing or unreadable falls back to `start`,
 * so an older draft never breaks the screens.
 */
export function phoneSetupAnswersOf(raw: unknown, start: PhoneSetupAnswers): PhoneSetupAnswers {
  const a = obj(raw);
  const n = obj(a['number']);
  const s = obj(a['search']);
  const e164 = str(n['e164'], 20);
  const numberType = oneOf(n['numberType'], ['local', 'toll_free'] as const);
  const number: PhoneSetupPicked | null =
    /^\+[1-9][0-9]{6,14}$/.test(e164) && numberType
      ? {
          e164,
          display: str(n['display'], 40) || formatPhone(e164),
          numberType,
          place: str(n['place'], 80) || null,
        }
      : null;
  const phones = Array.isArray(a['phones'])
    ? a['phones'].slice(0, PHONE_SETUP_MAX_PHONES).map((p) => {
        const row = obj(p);
        return {
          label: str(row['label'], 40),
          number: str(row['number'], 40),
          enabled: bool(row['enabled']) ?? true,
        };
      })
    : start.phones;
  const seconds = Number(a['ringSeconds']);
  const quietStart = str(a['quietStart'], 5);
  const quietEnd = str(a['quietEnd'], 5);
  return {
    at: oneOf(a['at'], [...PHONE_SETUP_QUESTIONS, 'review'] as const) ?? start.at,
    have: 'have' in a ? oneOf(a['have'], ['new', 'keep', 'twilio'] as const) : start.have,
    texting: 'texting' in a ? bool(a['texting']) : start.texting,
    ein: 'ein' in a ? bool(a['ein']) : start.ein,
    numberType: oneOf(a['numberType'], ['local', 'toll_free'] as const) ?? start.numberType,
    number: 'number' in a ? number : start.number,
    search:
      'search' in a
        ? {
            city: str(s['city'], 40),
            state: str(s['state'], 2),
            miles: oneOf(s['miles'], ['', '15', '25', '50'] as const) ?? '',
            areaCode: str(s['areaCode'], 3),
            digits: str(s['digits'], 10),
          }
        : start.search,
    morePhones: bool(a['morePhones']) ?? start.morePhones,
    phones,
    callerId: oneOf(a['callerId'], ['customer', 'business'] as const) ?? start.callerId,
    ringSeconds:
      Number.isInteger(seconds) && seconds >= 10 && seconds <= 25 ? seconds : start.ringSeconds,
    then:
      'then' in a ? oneOf(a['then'], ['teammate', 'voicemail', 'nothing'] as const) : start.then,
    teammateMode:
      oneOf(a['teammateMode'], ['no_answer', 'after_hours', 'always'] as const) ??
      start.teammateMode,
    greeting: 'greeting' in a ? str(a['greeting'], PHONE_SETUP_GREETING_MAX) : start.greeting,
    quiet: 'quiet' in a ? oneOf(a['quiet'], ['night', 'custom', 'never'] as const) : start.quiet,
    quietStart: CLOCK.test(quietStart) ? quietStart : start.quietStart,
    quietEnd: CLOCK.test(quietEnd) ? quietEnd : start.quietEnd,
  };
}

/** What the business's number does today, as the setup's answers: where "Run the guided setup again" starts. */
export function phoneSetupAnswersFromNow(now: {
  readonly routing: {
    readonly forwarding: readonly {
      readonly e164: string;
      readonly label: string;
      readonly enabled: boolean;
    }[];
    readonly ringSeconds: number;
    readonly voicemailEnabled: boolean;
    readonly voicemailGreeting: string | null;
    readonly forwardedCallerId: 'customer' | 'business';
  };
  readonly settings: {
    readonly quietHours: {
      readonly enabled: boolean;
      readonly start: string;
      readonly end: string;
    };
    readonly texting: 'on' | 'not_now';
    readonly teammateAnswers: PhoneSetupTeammateMode | null;
  };
  readonly teammate: {
    readonly answersCalls: boolean;
    readonly answer: PhoneSetupTeammateMode;
  } | null;
}): Pick<
  PhoneSetupAnswers,
  | 'texting'
  | 'morePhones'
  | 'phones'
  | 'callerId'
  | 'ringSeconds'
  | 'then'
  | 'teammateMode'
  | 'greeting'
  | 'quiet'
  | 'quietStart'
  | 'quietEnd'
> {
  const { routing, settings, teammate } = now;
  const missed = phoneMissedNow(now);
  const q = settings.quietHours;
  return {
    texting: settings.texting !== 'not_now',
    morePhones: routing.forwarding.length > 0,
    phones: routing.forwarding.map((f) => ({
      label: f.label,
      number: formatPhone(f.e164),
      enabled: f.enabled,
    })),
    callerId: routing.forwardedCallerId,
    ringSeconds: routing.ringSeconds,
    then: missed.then,
    teammateMode: teammate?.answer ?? settings.teammateAnswers ?? 'no_answer',
    greeting: routing.voicemailGreeting ?? '',
    quiet: !q.enabled
      ? 'never'
      : q.start === PHONE_SETUP_NIGHT.start && q.end === PHONE_SETUP_NIGHT.end
        ? 'night'
        : 'custom',
    quietStart: q.enabled ? q.start : PHONE_SETUP_NIGHT.start,
    quietEnd: q.enabled ? q.end : PHONE_SETUP_NIGHT.end,
  };
}

/**
 * What a caller gets today when the phones ring out. The AI teammate when it answers calls, or when the business
 * asked for that before it had one (callers get the voicemail meanwhile); else the voicemail, or nothing.
 */
export function phoneMissedNow(now: {
  readonly routing: { readonly voicemailEnabled: boolean };
  readonly settings: { readonly teammateAnswers: PhoneSetupTeammateMode | null };
  readonly teammate: {
    readonly answersCalls: boolean;
    readonly answer: PhoneSetupTeammateMode;
  } | null;
}): {
  readonly then: PhoneSetupThen;
  readonly mode: PhoneSetupTeammateMode;
  readonly waiting: boolean;
} {
  if (now.teammate?.answersCalls)
    return { then: 'teammate', mode: now.teammate.answer, waiting: false };
  if (!now.teammate && now.settings.teammateAnswers)
    return { then: 'teammate', mode: now.settings.teammateAnswers, waiting: true };
  return {
    then: now.routing.voicemailEnabled ? 'voicemail' : 'nothing',
    mode: 'no_answer',
    waiting: false,
  };
}

/** Local or toll-free: what they chose on the number screen, else what the EIN answer gives. */
export function phoneSetupNumberType(a: PhoneSetupAnswers): PhoneSetupNumberType {
  if (a.numberType) return a.numberType;
  // Without texting nothing waits on an approval, so the number with their own area code is the one to offer.
  return a.texting === true && a.ein === false ? 'toll_free' : 'local';
}

/** The questions this path asks, in order. Check it over comes after the last. */
export function phoneSetupQuestions(
  a: PhoneSetupAnswers,
  ctx: Pick<PhoneSetupContext, 'mode' | 'textingSettled'>,
): readonly PhoneSetupQuestion[] {
  const texts = ctx.textingSettled || a.texting === true;
  if (ctx.mode === 'again')
    return [
      ...(ctx.textingSettled ? [] : (['texting'] as const)),
      'ring',
      'missed',
      ...(texts ? (['quiet'] as const) : []),
    ];
  return [
    'have',
    'texting',
    ...(a.texting === true ? (['ein'] as const) : []),
    'number',
    'ring',
    'missed',
    ...(a.texting === true ? (['quiet'] as const) : []),
  ];
}

export interface PhoneSetupProblem {
  readonly path: string;
  readonly message: string;
}

/** The phones that ring too, as the command takes them; `problems` says what is wrong with each, by its row. */
export function phoneSetupForwarding(
  a: Pick<PhoneSetupAnswers, 'morePhones' | 'phones'>,
  businessE164: string | null,
): {
  readonly forwarding: { e164: string; label: string; enabled: boolean }[];
  readonly problems: PhoneSetupProblem[];
} {
  const forwarding: { e164: string; label: string; enabled: boolean }[] = [];
  const problems: PhoneSetupProblem[] = [];
  if (!a.morePhones) return { forwarding, problems };
  if (a.phones.length === 0)
    problems.push({
      path: 'phones',
      message: 'Add the phone that should ring, or untick “A cell phone or desk phone too”.',
    });
  const seen = new Set<string>();
  a.phones.forEach((p, i) => {
    const label = p.label.trim();
    const e164 = normalizePhone(p.number);
    if (!label)
      problems.push({
        path: `phones.${i}.label`,
        message: 'Say whose phone this is, like “Dale’s cell”.',
      });
    if (!p.number.trim())
      problems.push({ path: `phones.${i}.number`, message: 'Enter this phone’s number.' });
    else if (!e164)
      problems.push({
        path: `phones.${i}.number`,
        message: 'That doesn’t look like a phone number. Use all 10 digits, like (256) 555-0117.',
      });
    else if (e164 === businessE164)
      problems.push({
        path: `phones.${i}.number`,
        message: 'That’s your business number. Put in the cell or desk phone that should ring.',
      });
    else if (seen.has(e164))
      problems.push({ path: `phones.${i}.number`, message: 'This phone is already on the list.' });
    if (e164) seen.add(e164);
    if (label && e164) forwarding.push({ e164, label, enabled: p.enabled });
  });
  return { forwarding, problems };
}

/** What stops Next on a question, in words that say how to fix it. Empty when it can go on. */
export function phoneSetupProblems(
  question: PhoneSetupQuestion,
  a: PhoneSetupAnswers,
  ctx: PhoneSetupContext,
): readonly PhoneSetupProblem[] {
  switch (question) {
    case 'have':
      return a.have ? [] : [{ path: 'have', message: 'Pick the one that fits you.' }];
    case 'texting':
      return a.texting === null
        ? [{ path: 'texting', message: 'Pick yes or not now. You can change it later.' }]
        : [];
    case 'ein':
      return a.ein === null
        ? [
            {
              path: 'ein',
              message: 'Pick yes or no. Not sure? Pick No now; you can add a local number later.',
            },
          ]
        : [];
    case 'number':
      return a.number
        ? []
        : [
            {
              path: 'number',
              message: 'Pick one of the numbers. None showing? Press Show numbers to look.',
            },
          ];
    case 'ring':
      return phoneSetupForwarding(a, ctx.businessE164 ?? a.number?.e164 ?? null).problems;
    case 'missed': {
      if (!a.then)
        return [{ path: 'then', message: 'Pick what a caller gets when nobody picks up.' }];
      if (a.then === 'teammate' && ctx.teammate && !ctx.teammate.canManage)
        return [
          {
            path: 'then',
            message: `Only someone who manages the AI teammate can have ${ctx.teammate.name} answer calls. Pick voicemail for now, or ask an owner or admin.`,
          },
        ];
      return a.greeting.trim().length > PHONE_SETUP_GREETING_MAX
        ? [
            {
              path: 'greeting',
              message: `Keep the greeting under ${PHONE_SETUP_GREETING_MAX} characters.`,
            },
          ]
        : [];
    }
    case 'quiet':
      if (!a.quiet) return [{ path: 'quiet', message: 'Pick when texts should wait.' }];
      return a.quiet === 'custom' && a.quietStart === a.quietEnd
        ? [
            {
              path: 'quietEnd',
              message: 'Texts would stop and start at the same time. Pick two different times.',
            },
          ]
        : [];
  }
}

/** The first question on this path with something wrong: where Check it over sends them back to. */
export function phoneSetupFirstProblem(
  a: PhoneSetupAnswers,
  ctx: PhoneSetupContext,
): PhoneSetupQuestion | null {
  return phoneSetupQuestions(a, ctx).find((q) => phoneSetupProblems(q, a, ctx).length > 0) ?? null;
}

/** "8 PM", "8:30 AM". */
export function phoneSetupClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

const listOf = (names: readonly string[]): string =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** "Dale’s cell" stays; a phone with no name yet is "a phone". */
const phoneNames = (phones: readonly { readonly label: string; readonly enabled: boolean }[]) =>
  phones.filter((p) => p.enabled).map((p) => p.label.trim() || 'a phone');

/** What rings, in one line and the line under it: "HandsFreeOS and Bella’s cell". */
export function phoneRingSummary(
  phones: readonly { readonly label: string; readonly number: string; readonly enabled: boolean }[],
  callerId: 'customer' | 'business',
): { readonly value: string; readonly sub: string } {
  const ringing = phones.filter((p) => p.enabled);
  const names = phoneNames(phones);
  const shows = callerId === 'business' ? 'your business number' : 'the customer’s number';
  const first = ringing[0];
  const off = phones.length - ringing.length;
  return {
    value: listOf(['HandsFreeOS', ...names]),
    sub:
      ringing.length === 0
        ? off > 0
          ? `On the computer and in the phone app. ${off === 1 ? 'One other phone is' : `${off} other phones are`} switched off.`
          : 'On the computer and in the phone app, for anyone on your team who has it open.'
        : ringing.length === 1 && first
          ? `${first.label.trim() || 'That phone'} is ${first.number.trim()}. It shows ${shows}.`
          : `Those phones show ${shows}.`,
  };
}

/** What a caller gets when nobody picks up: "Ava answers after 20 seconds". */
export function phoneMissedSummary(
  m: {
    readonly then: PhoneSetupThen;
    readonly mode: PhoneSetupTeammateMode;
    readonly ringSeconds: number;
  },
  teammate: { readonly name: string; readonly on: boolean } | null,
): { readonly value: string; readonly sub: string } {
  const after = `after ${m.ringSeconds} seconds`;
  if (m.then === 'voicemail')
    return {
      value: `Voicemail ${after}`,
      sub: 'Messages show up in your Inbox, written out so you can read them.',
    };
  if (m.then === 'nothing')
    return {
      value: `Nothing ${after}`,
      sub: 'Callers hear “Sorry, nobody can take your call right now.” The missed call still shows in your Inbox.',
    };
  const name = teammate?.name ?? 'Your AI teammate';
  const value =
    m.mode === 'always'
      ? `${name} answers every call`
      : m.mode === 'after_hours'
        ? `${name} answers when you’re closed`
        : `${name} answers ${after}`;
  return {
    value,
    sub: !teammate
      ? 'You don’t have an AI teammate yet, so callers get your voicemail for now. It starts picking up the moment you set one up.'
      : !teammate.on
        ? `${teammate.name} is off right now, so callers get your voicemail. Turn ${teammate.name} on in AI teammate and it picks up.`
        : `If ${teammate.name} can’t take a call, the caller gets your voicemail.`,
  };
}

/** "8 PM to 8 AM", and what that means. */
export function phoneQuietSummary(q: {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
}): { readonly value: string; readonly sub: string } {
  return q.enabled
    ? {
        value: `${phoneSetupClock(q.start)} to ${phoneSetupClock(q.end)}`,
        sub: 'Automatic texts wait until quiet hours end.',
      }
    : { value: 'Never too late', sub: 'Automatic texts go out at any hour.' };
}

/** The answers' quiet hours as the setting keeps them. */
export function phoneSetupQuietHours(
  a: Pick<PhoneSetupAnswers, 'quiet' | 'quietStart' | 'quietEnd'>,
): { enabled: boolean; start: string; end: string } {
  if (a.quiet === 'never') return { enabled: false, ...PHONE_SETUP_NIGHT };
  if (a.quiet === 'custom') return { enabled: true, start: a.quietStart, end: a.quietEnd };
  return { enabled: true, ...PHONE_SETUP_NIGHT };
}

export interface PhoneSetupLine {
  readonly question: PhoneSetupQuestion;
  /** Its name beside the questions and on Check it over. */
  readonly label: string;
  /** What they said, or null until they have. */
  readonly value: string | null;
  /** A second line under it, on Check it over. */
  readonly sub: string | null;
}

/** Each question on this path with what was answered, for the list beside the questions and Check it over. */
export function phoneSetupLines(
  a: PhoneSetupAnswers,
  ctx: PhoneSetupContext,
): readonly PhoneSetupLine[] {
  const W = PHONE_SETUP_WORDS;
  return phoneSetupQuestions(a, ctx).map((question): PhoneSetupLine => {
    switch (question) {
      case 'have':
        return {
          question,
          label: W.lines.have,
          value: a.have ? W.haveShort[a.have] : null,
          sub: null,
        };
      case 'texting':
        return {
          question,
          label: W.lines.texting,
          value: a.texting === null ? null : a.texting ? W.textingYesShort : W.textingNoShort,
          sub:
            a.texting === null
              ? null
              : a.texting
                ? ctx.mode === 'new'
                  ? 'Getting approved starts as soon as the number is yours.'
                  : 'Getting approved is the next step, in Settings → Texting & calls.'
                : 'Turn it on any time in Settings → Texting & calls.',
        };
      case 'ein':
        return {
          question,
          label: W.lines.ein,
          value: a.ein === null ? null : a.ein ? W.localShort : W.tollFreeShort,
          sub: null,
        };
      case 'number':
        return {
          question,
          label: W.lines.number,
          value: a.number?.display ?? null,
          sub: a.number
            ? [
                a.number.numberType === 'local' ? 'Local' : 'Toll-free',
                a.number.place,
                'calls, texts and photos',
              ]
                .filter(Boolean)
                .join(' · ')
            : null,
        };
      case 'ring': {
        const s = phoneRingSummary(a.morePhones ? a.phones : [], a.callerId);
        return { question, label: W.lines.ring, value: s.value, sub: s.sub };
      }
      case 'missed': {
        if (!a.then) return { question, label: W.lines.missed, value: null, sub: null };
        const s = phoneMissedSummary(
          { then: a.then, mode: a.teammateMode, ringSeconds: a.ringSeconds },
          ctx.teammate,
        );
        return { question, label: W.lines.missed, value: s.value, sub: s.sub };
      }
      case 'quiet': {
        if (!a.quiet) return { question, label: W.lines.quiet, value: null, sub: null };
        const s = phoneQuietSummary(phoneSetupQuietHours(a));
        return { question, label: W.lines.quiet, value: s.value, sub: s.sub };
      }
    }
  });
}

type PhoneSetupSaveBody = Omit<z.input<typeof PhoneSetupSaveInput>, 'workspaceId'>;

/** A part of what the number does that Settings → Texting & calls changes on its own, behind Change. */
export type PhoneSetupPart = 'ring' | 'missed' | 'quiet';

/**
 * One part of the answers as phone_setup.save takes it: what rings and what those phones show, how long they ring
 * and what a caller gets after that, or quiet hours. Null while that part still has something wrong with it
 * (phoneSetupProblems says what).
 */
export function phoneSetupPartBody(
  part: PhoneSetupPart,
  a: PhoneSetupAnswers,
  ctx: PhoneSetupContext,
): Pick<PhoneSetupSaveBody, 'ring' | 'missed' | 'quietHours'> | null {
  if (phoneSetupProblems(part, a, ctx).length > 0) return null;
  if (part === 'ring')
    return {
      ring: {
        forwarding: phoneSetupForwarding(a, ctx.businessE164 ?? a.number?.e164 ?? null).forwarding,
        forwardedCallerId: a.callerId,
      },
    };
  if (part === 'quiet') return a.quiet ? { quietHours: phoneSetupQuietHours(a) } : null;
  if (!a.then) return null;
  const greeting = a.greeting.trim();
  return {
    missed: {
      ringSeconds: a.ringSeconds,
      then: a.then,
      ...(a.then === 'teammate' ? { teammateMode: a.teammateMode } : {}),
      // Only the voicemail pick shows the greeting: left empty there, callers hear the usual one.
      ...(a.then === 'voicemail' ? { voicemailGreeting: greeting || null } : {}),
    },
  };
}

/**
 * What the last screen sends to phone_setup.save, without the business's id: the number to buy (or the one being
 * changed), what rings, what happens when nobody picks up, whether they text, and quiet hours when they do. Null
 * while something on the way still needs an answer (phoneSetupFirstProblem says where).
 */
export function phoneSetupSaveBody(
  a: PhoneSetupAnswers,
  ctx: PhoneSetupContext,
  phoneNumberId: string | null,
): PhoneSetupSaveBody | null {
  if (phoneSetupFirstProblem(a, ctx)) return null;
  const asked = phoneSetupQuestions(a, ctx);
  const which =
    ctx.mode === 'new'
      ? a.number
        ? { buy: { e164: a.number.e164, numberType: a.number.numberType } }
        : null
      : phoneNumberId
        ? { phoneNumberId }
        : null;
  const ring = phoneSetupPartBody('ring', a, ctx);
  const missed = phoneSetupPartBody('missed', a, ctx);
  const quiet = asked.includes('quiet') ? phoneSetupPartBody('quiet', a, ctx) : {};
  if (!which || !ring || !missed || !quiet) return null;
  return {
    ...which,
    ...ring,
    ...missed,
    ...(asked.includes('texting') && a.texting !== null
      ? { texting: a.texting ? ('on' as const) : ('not_now' as const) }
      : {}),
    ...quiet,
  };
}

/** The usual voicemail greeting, said when the business hasn't written its own. */
export const phoneSetupDefaultGreeting = (businessName: string) =>
  `You’ve reached ${businessName}. Leave your name, number and what you need, and we’ll call you back today.`;

/** The setup's words, shared by the web and the phone. */
export const PHONE_SETUP_WORDS = {
  settingUp: (business: string) => `Setting up the number for ${business}`,
  stop: 'Your business number',
  soFar: 'Your number so far',
  lines: {
    have: 'Number',
    texting: 'Texting',
    ein: 'Local or toll-free',
    number: 'Your number',
    ring: 'What rings',
    missed: 'If nobody picks up',
    quiet: 'Quiet hours for texts',
  },
  haveShort: {
    new: 'A new one',
    keep: 'Keeping the one I have',
    twilio: 'From Twilio or HighLevel',
  },
  textingYesShort: 'Yes, text customers',
  textingNoShort: 'Not now, calls only',
  localShort: 'Local, with your area code',
  tollFreeShort: 'Toll-free',
  best: 'Best',

  have: {
    title: 'Do you already have a business number?',
    hint: 'It’s the number customers call and text.',
    new: {
      title: 'No, I need a new one',
      hint: 'You pick one in a minute. Calls work as soon as it’s yours.',
    },
    keep: {
      title: 'Yes, and I want to keep it',
      hint: 'We move it here from your phone company. Customers keep using the number they know.',
    },
    twilio: {
      title: 'Yes, it’s in Twilio or HighLevel',
      hint: 'We bring it across from that account. It takes a few days.',
    },
    note: 'You can start with a new number and move your old one over later.',
    moveNext: 'Move my number',
  },
  texting: {
    title: 'Do you want to text customers from this number?',
    hint: 'Calls work either way. Before a business can text, the phone carriers have to approve it.',
    yes: {
      title: 'Yes, I want to text customers',
      hint: 'Reminders, replies and follow-ups. Right after you get your number, we walk you through getting approved.',
      hintAgain:
        'Reminders, replies and follow-ups. Getting approved is the next step, in Settings → Texting & calls.',
    },
    no: {
      title: 'Not now, calls only',
      hint: 'You skip the approval and the questions about texts. Turn texting on any time in Settings → Texting & calls.',
    },
    takesTitle: 'What getting approved takes',
    takes: [
      'A few questions about your business, your texts and your website.',
      'Then the carriers take 1 to 3 weeks for a local number, or a few days for a toll-free one.',
      'The carriers charge a fee for a local number. You see the amount before anything is sent.',
    ],
  },
  ein: {
    title: 'Does your business have an EIN?',
    hint: 'It’s the 9-digit tax number the IRS gave your business, like 12-3456789. It decides which kind of number you can text from.',
    yes: {
      title: 'Yes',
      hint: 'You get a local number with your own area code. Texting approval takes 1 to 3 weeks.',
    },
    no: {
      title: 'No',
      hint: 'You get a toll-free number, like (833). Texting approval takes a few days.',
    },
    note: 'Calls work right away with either kind. Only texting waits for approval.',
    unsure:
      'Not sure? Look on a letter from the IRS, or ask whoever does your taxes. You can pick No now and add a local number later.',
  },
  number: {
    title: 'Pick your number',
    titleAgain: 'Pick a new number',
    hintNear: (place: string) => `These are free near ${place} right now.`,
    hintLocal: 'Search by city and state, by area code, or both.',
    hintTollFree: 'These toll-free numbers are free right now.',
    results: 'Numbers you can have',
    find: 'Find a number',
    looking: 'Looking for numbers…',
    different: 'Want a different one?',
    differentHint: 'Search by city and state, by area code, or both.',
    city: 'City',
    state: 'State',
    miles: 'How far out',
    areaCode: 'Area code (optional)',
    startsWith: 'Starts with',
    digits: 'Digits you’d like in it (optional)',
    show: 'Show numbers',
    tollFreeInstead: 'Show toll-free numbers instead',
    localInstead: 'Show local numbers instead',
    notYet: 'Nothing is bought yet. The number becomes yours on the last screen.',
    stateNeeded: 'Add the state too, like AL. There is a Huntsville in three of them.',
    noneWide: (city: string) =>
      `We couldn’t find ${city} to measure from. Try the city on its own, or just the area code.`,
    noneNarrow:
      'Nothing free matches all of that right now. Ask for less, like only the area code, and look again.',
    none: 'No numbers are free there right now. Try another area code.',
    broaden: 'Look again without the city or digits',
    /** The number they picked earlier isn't free any more. */
    goneTitle: (display: string) => `${display} was taken while you were away`,
    gone: 'Someone else got it before you finished. Nothing was bought, so nothing is lost. Pick another one and carry on.',
    goneHint: 'Your other answers are still here.',
    /** Buying it failed at the carrier. */
    failedTitle: (display: string) => `We couldn’t get ${display}`,
    failed: (reason: string | null) =>
      `${reason ? `${reason.replace(/[.\s]+$/, '')}. ` : ''}Nothing was bought. Pick another number and carry on.`,
    features: 'Calls · Texts · Photos',
  },
  ring: {
    title: 'When a customer calls, what should ring?',
    hint: 'Everything you pick rings at the same time. The first to answer takes the call.',
    app: 'HandsFreeOS',
    appAlways: 'Always on',
    appHint: 'On the computer and in the phone app, for anyone on your team who has it open.',
    more: 'A cell phone or desk phone too',
    moreHint: 'It rings like any other call, even when HandsFreeOS is closed. Up to 3 phones.',
    whose: 'Whose phone',
    whosePlaceholder: 'Dale’s cell',
    its: 'Its number',
    add: 'Add another phone',
    addFirst: 'Add a phone',
    remove: (label: string) => `Remove ${label || 'this phone'}`,
    used: (n: number) =>
      `${n} of ${PHONE_SETUP_MAX_PHONES} phones used. Switch one off for a day off without removing it.`,
    rings: 'Ring this phone',
    showsTitle: 'What should that phone show when a customer calls?',
    showsCustomer: 'The customer’s number',
    showsCustomerHint: 'You see who is calling before you pick up.',
    showsBusiness: 'Your business number',
    showsBusinessHint:
      'Best if your phone silences unknown callers. Save the business number as a contact and every call rings.',
    press1: (business: string) =>
      `On a cell, you hear “Call for ${business}” and press 1 to take it, so your own voicemail never answers a customer.`,
  },
  missed: {
    title: 'What if nobody picks up?',
    hint: 'Pick what a caller gets when your phones ring out.',
    ringFor: 'Ring for',
    seconds: (n: number) => `${n} seconds`,
    rings: (n: number) => `first. That’s about ${Math.round(n / 5)} rings.`,
    teammate: (name: string | null) => `${name ?? 'Your AI teammate'} answers`,
    teammateHint:
      'Your AI teammate picks up and talks with the caller: answers questions, books a time or takes a message. You read the call in your Inbox.',
    whenTitle: (name: string | null) => `When should ${name ?? 'your AI teammate'} pick up?`,
    when: {
      no_answer: 'When nobody picks up',
      after_hours: 'When you’re closed',
      always: 'Every call',
    },
    teammateCost: (name: string | null) =>
      `Calls ${name ?? 'your AI teammate'} takes use your AI balance. If it can’t take one, the caller gets your voicemail.`,
    noTeammate:
      'You don’t have an AI teammate yet. Pick this and callers get your voicemail for now. It starts picking up the moment you set your AI teammate up.',
    teammateOff: (name: string) =>
      `${name} is off right now. Callers get your voicemail until you turn ${name} on in AI teammate.`,
    cantManage: 'Only an owner or admin can change what the AI teammate does.',
    voicemail: 'Take a voicemail',
    voicemailHint:
      'Callers hear your greeting and leave a message. It shows up in your Inbox, written out so you can read it.',
    greeting: 'What callers hear',
    greetingHint: 'Read aloud by a natural-sounding voice.',
    nothing: 'Nothing',
    nothingHint:
      'Callers hear “Sorry, nobody can take your call right now. Please try again later.” The missed call still shows in your Inbox.',
  },
  quiet: {
    title: 'When is it too late to text customers?',
    hint: 'Automatic texts, like reminders and follow-ups, wait until morning.',
    night: 'After 8 PM, until 8 AM',
    nightHint: 'What most businesses pick. Nobody gets a text from you at night.',
    custom: 'I’ll pick the hours',
    customHint: 'Choose when texts stop and when they start again.',
    stop: 'Texts stop at',
    start: 'And start again at',
    never: 'It’s never too late',
    neverHint: 'Automatic texts go out at any hour.',
    stillCan:
      'You and your team can still text a customer at night. You get a “send anyway?” check first.',
    zone: (city: string) => `Times are ${city} time, the same as your business hours.`,
  },
  review: {
    title: 'Does this look right?',
    hintNew: 'Nothing is bought until you press Get my number.',
    hintAgain: 'Nothing changes until you press Save my answers.',
    finishNew: 'Get my number',
    finishAgain: 'Save my answers',
    setTitle: 'Already set for you. Change them any time in Settings.',
    set: [
      'Callers hear “This call may be recorded.” Every answered call is saved and written out in your Inbox.',
      'You get an email when a customer has waited 10 minutes for a text back.',
      'A customer who texts STOP is never texted again until they text START.',
    ],
    nextTitle: 'What happens next',
    next: {
      mine: ['The number is yours', 'It takes a few seconds. Calls ring right away.'],
      approval: [
        'Texting approval',
        'A few questions about your business, for the phone carriers.',
      ],
      carriersLocal: ['The carriers check it', 'Usually 1 to 3 weeks for a local number.'],
      carriersTollFree: ['The carriers check it', 'Usually a few days for a toll-free number.'],
      on: ['Texting turns on', 'We email you the moment it does.'],
      callsOnly: ['Calls only for now', 'Turn texting on any time in Settings → Texting & calls.'],
    },
    /** A newer number the carrier couldn't confirm is still free. */
    takenTitle: (display: string) => `${display} was just taken`,
    taken: 'Someone else got it a moment ago. Nothing was bought. Pick another number.',
  },
  getting: {
    title: (display: string) => `Getting ${display}`,
    hint: 'This takes a few seconds. You can stay here.',
  },
  done: {
    kicker: 'Your business number',
    mine: 'It’s yours, and it’s set up the way you said.',
    saved: 'It’s set up the way you said.',
    calls: 'Calls ring now',
    textingNeeds: 'Texting needs approval first',
    textingOff: 'Calls only',
    tryTitle: 'Try it now',
    tryCall: (display: string, rings: string) =>
      `Call ${display} from another phone. ${rings} ${rings.includes(' and ') ? 'both ring' : 'rings'}.`,
    nextTitle: 'Next, because you want to text',
    approveTitle: 'Get approved to text',
    approve:
      'The phone carriers check every business before it can text. You answer a few questions and we send them in for you.',
    approveTime: (local: boolean) =>
      `About 10 minutes for you. Then the carriers usually take ${local ? '1 to 3 weeks' : 'a few days'}, so it’s worth sending today.`,
    approveFee:
      'The carriers charge a fee for a local number. You see the amount before anything is sent.',
    approveHandy: 'Have your EIN and your business’s legal name handy.',
    start: 'Start texting approval',
    later: 'Do it later',
    toSettings: 'Go to Texting & calls',
  },
  /** Settings → Texting & calls, before there is a number. */
  startCard: {
    title: 'Get your business number',
    hint: 'A few short questions: the number, what rings, what happens when nobody picks up. Nothing is bought until the last screen.',
    start: 'Start',
    carryOn: 'Carry on where you left off',
    saved: (when: string) => `Your answers from ${when.replace(/^on /, '')} are saved.`,
  },
  again: 'Run the guided setup again',
  /** Settings → Texting & calls, once the business has its number: one card, with Change on every row. */
  card: {
    title: 'Your business number',
    callsWorking: 'Calls working',
    textingApproved: 'Texting approved',
    textingWaiting: 'Texting waiting on the carriers',
    textingNeeds: 'Texting needs approval',
    textingTurnedDown: 'Texting turned down',
    callsOnly: 'Calls only',
    addNumber: 'Add a number',
    testText: 'Text me a test',
    calls: 'Calls',
    texting: 'Texting',
    save: 'Save changes',
    cancel: 'Cancel',
    saved: 'Saved',
    recording: 'Call recording',
    recordingOn: 'Callers hear “This call may be recorded.”',
    recordingOff: 'Callers aren’t told calls are recorded',
    recordingSub: 'Every answered call is saved and written out in your Inbox.',
    recordingHint:
      'Every answered call is recorded and turned into words, so you can read it back in your Inbox. With this on, callers hear “This call may be recorded.” before it rings, and customers you call hear it when they pick up.',
    recordingSwitch: 'Tell callers the call may be recorded',
    recordingWarning:
      'Some states, including California, Florida and Washington, need everyone on a call to agree to a recording. Check with a lawyer before turning this off.',
    approval: 'Approval',
    approvalOff: 'Texting is off. Calls only.',
    approvalOffSub: 'Turn it on and we walk you through getting approved by the phone carriers.',
    turnOn: 'Turn on texting',
    approvalNeeds: 'Not approved yet',
    approvalNeedsSub:
      'The phone carriers check every business before it can text. It takes about 10 minutes to send.',
    startApproval: 'Start texting approval',
    carryOnApproval: 'Carry on',
    approvalWaiting: 'With the carriers',
    approvalWaitingSub: (local: boolean) =>
      `Usually ${local ? '1 to 3 weeks for a local number' : 'a few days for a toll-free number'}. We email you the moment it’s approved.`,
    approvalTurnedDown: 'The carriers turned it down',
    approvalTurnedDownSub: 'What to fix is below.',
    approved: 'Approved',
    approvedSub: 'Carriers deliver your texts.',
    monthly: (amount: string) =>
      `Your texting campaign is ${amount} a month, the carriers’ fee passed on at cost and charged to the card you paid with.`,
    seeSent: 'See what we sent',
    waits: 'When a customer waits',
    waitsTitle: 'When a customer waits for a text back',
    waitsHint:
      'One email to whoever the conversation is assigned to, or to every owner and admin when nobody is.',
    waitsAfter: 'Email the team after',
    waitsValue: (minutes: number) =>
      minutes === 0
        ? 'No reminder'
        : `Email the team after ${minutes === 60 ? '1 hour' : `${minutes} minutes`}`,
    waitsChoices: [
      [10, '10 minutes'],
      [5, '5 minutes'],
      [15, '15 minutes'],
      [30, '30 minutes'],
      [60, '1 hour'],
      [0, 'Never'],
    ],
    stop: 'STOP, START and HELP',
    stopValue: 'Handled for you',
    stopSub: 'A customer who texts STOP is never texted again until they text START.',
    account: 'Phone account and transfers',
    giveUp: (display: string) => `Give up ${display}`,
    onItsWay: 'Moving to us',
  },
} as const;
