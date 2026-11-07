/**
 * The guided setup and Getting started, for the Assistant: what their screens' own commands and queries need around
 * them to be used the way the screens use them.
 *
 * - A save sends the screens' whole answers, so the model's answers go over the ones the business kept, read as the
 *   person first: an answer it leaves out stays as it was, never a default (onb-2).
 * - The card says what saving would change, from the command tried and rolled back, and the answers it changes (onb-6).
 * - Finishing puts the chat on the business's real address, worked out here, never the model's guess (onb-9).
 * - The reads come back in the screens' own words, what matters first: which screen it's on, "3 of 15", what's left,
 *   and each Getting started step's title, line, button and where it goes (onb-3, onb-10, onb-16).
 */
import {
  addressLines,
  AGENCY_SETUP_WORDS,
  AI_SETUP_JOB_LABELS,
  aiSetupFinish,
  aiSetupFlowFactsOf,
  aiSetupGet,
  aiSetupSave,
  aiSetupStepTitle,
  executeQuery,
  onboardingSetupChecking,
  onboardingSetupFinish,
  onboardingSetupFirstScreen,
  onboardingSetupGet,
  onboardingSetupHint,
  onboardingSetupOwnerPart,
  onboardingSetupOwnerScreens,
  onboardingSetupProgress,
  onboardingSetupSave,
  onboardingSetupScreens,
  onboardingSetupStateOf,
  onboardingSetupStopName,
  onboardingSetupStopOf,
  onboardingSetupSummary,
  onboardingSetupTitle,
  PAY_WITH_LABELS,
  QUESTION_WORDS,
  screenPlace,
  stepPath,
  stepWords,
  type AiSetupStep,
  type BusinessAddress,
  type HandOverRole,
  type OnboardingSetupScreen,
  type OnboardingStep,
  type QueryDef,
  type RequestMeta,
  type ScreenActionTool,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { publicOriginFor } from './full-links';
import type { PreparedAction, ToolContext } from './runtime';
import { hoursLine, settingsCard } from './tools-settings-calendar';

type Args = Record<string, unknown>;

interface SetupCommand {
  /** The screens' own read, whose answers a save goes over. */
  readonly read: QueryDef;
  /** The answers hold the AI teammate's under `ai` (the guided setup), else they are its own (quick setup). */
  readonly nested: boolean;
  /** It saves everything: the chat goes on the business's page, at the address worked out here. */
  readonly finish: boolean;
}

/** By the commands' own names, so these stay the screens' commands (coverage.ts), never tools of their own. */
const SETUP: ReadonlyMap<string, SetupCommand> = new Map<string, SetupCommand>([
  [onboardingSetupSave.name, { read: onboardingSetupGet, nested: true, finish: false }],
  [onboardingSetupFinish.name, { read: onboardingSetupGet, nested: true, finish: true }],
  [aiSetupSave.name, { read: aiSetupGet, nested: false, finish: false }],
  [aiSetupFinish.name, { read: aiSetupGet, nested: false, finish: true }],
]);

export const isSetupCommand = (name: string) => SETUP.has(name);

const isObject = (v: unknown): v is Args => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The answers given over the ones kept: each answer given takes the place of its own, the AI part's one by one. */
export function mergedAnswers(saved: Args, given: unknown, nested: boolean): Args {
  if (!isObject(given)) return saved;
  const out: Args = { ...saved, ...given };
  if (nested && isObject(saved['ai']))
    out['ai'] = isObject(given['ai']) ? { ...saved['ai'], ...given['ai'] } : saved['ai'];
  return out;
}

/** Each answer that changes, by where it sits: `goal`, `ai.openHours`. */
export function changedAnswers(saved: Args, merged: Args, nested: boolean): [string, unknown][] {
  const own = Object.entries(merged).filter(
    ([k, v]) => !(nested && k === 'ai') && !same(v, saved[k]),
  );
  const ai =
    nested && isObject(merged['ai']) && isObject(saved['ai'])
      ? Object.entries(merged['ai'])
          .filter(([k, v]) => !same(v, (saved['ai'] as Args)[k]))
          .map(([k, v]): [string, unknown] => [`ai.${k}`, v])
      : [];
  return [...own, ...ai];
}

const meta = (ctx: ToolContext): RequestMeta => ({
  correlationId: ctx.correlationId,
  channel: 'assistant',
});

/** What the screens read, as the person. */
async function readSetup(db: Db, ctx: ToolContext, read: QueryDef): Promise<Args> {
  const got = await executeQuery(db, read, { workspaceId: ctx.workspaceId }, ctx.actor, meta(ctx));
  return (got ?? {}) as Args;
}

export interface SetupInput {
  readonly input: Args;
  /** The answers kept before this save, for what the card says changes. */
  readonly saved: Args;
  /** Handing it over invites the owner as this (`handOverAs`, as the screen shows it); null when it can't. */
  readonly handOverAs?: HandOverRole | null;
}

/**
 * A setup command's input, as its screen sends it: the model's answers over the ones kept, and, to finish, the
 * address of the business's page (its own domain once that serves, else the app's), for the chat a business with
 * no website gets there. Null for any other command.
 */
export async function setupInput(
  db: Db,
  ctx: ToolContext,
  tool: ScreenActionTool,
  input: Args,
  webUrl: string,
): Promise<SetupInput | null> {
  const setup = SETUP.get(tool.command.name);
  if (!setup) return null;
  const got = await readSetup(db, ctx, setup.read);
  const saved = isObject(got['answers']) ? got['answers'] : {};
  const origin = setup.finish ? await publicOriginFor(db, ctx, webUrl) : '';
  const role = got['handOverAs'];
  return {
    input: {
      ...input,
      answers: mergedAnswers(saved, input['answers'], setup.nested),
      ...(origin ? { pageOrigin: origin } : {}),
    },
    saved,
    handOverAs: role === 'owner' || role === 'admin' ? role : null,
  };
}

/** What each answer is called on its screen. */
const LABELS: Readonly<Record<string, string>> = {
  goal: QUESTION_WORDS.goal,
  teamSize: QUESTION_WORDS.teamSize,
  booksTime: 'Customers book a time',
  usePage: 'Use the simple page',
  customersIn: QUESTION_WORDS.customersIn,
  hasEin: 'Has an EIN',
  payWith: 'How customers pay',
  reviewLink: 'Review link',
  jobs: 'What the AI teammate helps with',
  description: 'What you do',
  services: 'Services',
  area: 'Where you work',
  openHours: 'Open hours',
  answerWhen: 'When the AI teammate answers',
  customHours: 'Its own hours',
  facts: 'Quick facts',
  name: 'AI teammate’s name',
  disclosure: 'Says it’s an AI',
  tone: 'Tone',
  allowPrices: 'Can tell customers prices',
  topQuestions: 'What customers ask most',
  keepFindings: 'What it learned, kept',
  dropFindings: 'What it learned, turned down',
  questions: 'Qualifying questions',
  chat: 'Add the AI teammate to the website',
};

const clip = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  goal: QUESTION_WORDS.goals,
  teamSize: QUESTION_WORDS.teams,
  customersIn: QUESTION_WORDS.sources,
  payWith: PAY_WITH_LABELS,
  jobs: AI_SETUP_JOB_LABELS,
};

/** An answer as its screen shows it. */
function answerValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'None';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return clip(WORDS[key]?.[v] ?? v);
  if (typeof v === 'number') return String(v);
  if ((key === 'openHours' || key === 'customHours') && Array.isArray(v))
    return hoursLine(v as Parameters<typeof hoursLine>[0]);
  if (Array.isArray(v)) {
    if (!v.length) return 'None';
    const names = v.map((x) =>
      isObject(x)
        ? String(x['name'] ?? x['question'] ?? x['label'] ?? '')
        : (WORDS[key]?.[String(x)] ?? String(x)),
    );
    return names.every(Boolean)
      ? clip(names.join(', '))
      : `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  }
  if (isObject(v)) return `${Object.keys(v).length} answered`;
  return clip(JSON.stringify(v));
}

const label = (path: string) => LABELS[path.replace(/^ai\./, '')] ?? path;

/** The first screen's business details, given with the save, a line each. */
function businessLines(business: unknown): { label: string; value: string }[] {
  if (!isObject(business)) return [];
  const b = business;
  return [
    ...(typeof b['name'] === 'string' ? [{ label: 'Business name', value: b['name'] }] : []),
    ...(typeof b['industry'] === 'string' ? [{ label: 'Kind', value: b['industry'] }] : []),
    ...(isObject(b['address'])
      ? [
          {
            label: 'Address',
            value: addressLines(b['address'] as BusinessAddress).replace(/\n/g, ', '),
          },
        ]
      : []),
    ...(typeof b['timezone'] === 'string' ? [{ label: 'Time zone', value: b['timezone'] }] : []),
    ...(b['website'] !== undefined
      ? [
          {
            label: 'Website',
            value: typeof b['website'] === 'string' ? b['website'] : QUESTION_WORDS.noWebsite,
          },
        ]
      : []),
  ];
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * The card for a setup command: the screen it saves, the answers it changes, and what saving would do to the
 * business, each from the command tried and rolled back; what it couldn't do as notes.
 */
export function setupCard(
  toolCallId: string,
  tool: ScreenActionTool,
  given: SetupInput,
  tried: unknown,
): PreparedAction {
  const setup = SETUP.get(tool.command.name)!;
  const input = given.input;
  const out = isObject(tried) ? tried : {};
  const screen =
    typeof input['screen'] === 'string' ? (input['screen'] as OnboardingSetupScreen) : null;
  const handing = isObject(input['owner']);
  const ownerEmail = handing ? (input['owner'] as Args)['email'] : undefined;
  // The first screen's answers come from where it starts from, never from what was given.
  const answers =
    screen === 'business' || input['step'] === 'business'
      ? []
      : changedAnswers(given.saved, input['answers'] as Args, setup.nested);
  const answerLines = answers.map(([k, v]) => ({
    label: label(k),
    value: answerValue(k.replace(/^ai\./, ''), v),
  }));
  const merged = input['answers'] as Args;
  const aiName = String(
    (setup.nested ? (merged['ai'] as Args | undefined) : merged)?.['name'] ?? '',
  );
  const place = screen
    ? onboardingSetupStopName(onboardingSetupStopOf(screen))
    : typeof input['step'] === 'string'
      ? aiSetupStepTitle(input['step'] as AiSetupStep, aiName)
      : null;
  const fields = [
    ...(place ? [{ label: 'Screen', value: place }] : []),
    ...businessLines(input['business']),
    ...(input['templateId'] !== undefined
      ? [
          {
            label: 'Start from',
            value: input['templateId'] ? 'The agency’s saved answers' : 'Our picks',
          },
        ]
      : []),
    ...(list(input['invite']).length
      ? [{ label: 'Invite', value: list(input['invite']).join(', ') }]
      : []),
    ...(handing
      ? [
          {
            label: 'Hand it to',
            value:
              typeof ownerEmail === 'string'
                ? ownerEmail
                : 'Nobody yet: invite the owner later from Members',
          },
        ]
      : []),
    // Who they join as, as the hand-over screen says it: only an owner of the agency can make someone an owner.
    ...(handing && typeof ownerEmail === 'string' && given.handOverAs
      ? [
          {
            label: 'Joins as',
            value:
              given.handOverAs === 'owner'
                ? 'The business’s owner'
                : 'An admin, since only an owner of your agency can make someone an owner',
          },
        ]
      : []),
    ...(answerLines.length > 7
      ? [
          ...answerLines.slice(0, 6),
          { label: 'And', value: `${answerLines.length - 6} more answers` },
        ]
      : answerLines),
  ];
  const changes = list(out['changes']);
  const notes = list(out['notes']);
  const shown = changes.slice(0, 12);
  const body = shown.length
    ? `What this changes in the business:\n${shown.map((c) => `• ${c}`).join('\n')}${
        changes.length > shown.length ? `\n• And ${changes.length - shown.length} more` : ''
      }`
    : setup.finish
      ? null
      : 'Nothing else in the business changes yet: the answers are kept for when the setup is saved.';
  const title = setup.finish
    ? handing
      ? 'Save it and hand it to the owner?'
      : 'Save the setup?'
    : place
      ? `Save “${place}”?`
      : 'Save these answers?';
  const warnings = [
    ...(tool.warning ? [{ kind: 'caution', text: tool.warning }] : []),
    ...notes.map((text) => ({ kind: 'note', text })),
  ];
  return {
    card: {
      ...settingsCard(toolCallId, tool.name, {
        title,
        fields: fields.length ? fields : [{ label: 'Answers', value: 'None change' }],
        confirmLabel: setup.finish ? (handing ? 'Hand it over' : 'Save') : 'Save',
        warnings,
      }),
      body,
    },
    result: {
      waiting: true,
      what: title,
      answersChanged: answers.map(([k]) => k),
      willChange: changes,
      ...(notes.length ? { notes } : {}),
      ...(handing && typeof ownerEmail === 'string' && given.handOverAs
        ? { ownerJoinsAs: given.handOverAs }
        : {}),
    },
  };
}

/** What the card says once saved: what changed, and what it couldn't do and how to, so neither is lost. */
export function setupOutcome(output: unknown): string {
  const o = isObject(output) ? output : {};
  const changes = list(o['changes']);
  const notes = list(o['notes']);
  const handed = isObject(o['handedOver']);
  const said = [
    handed ? 'Saved, and handed to the owner.' : 'Saved.',
    ...(changes.length ? [`${changes.join('. ')}.`] : []),
    ...notes,
  ].join(' ');
  return clip(said, 1500);
}

/** A public page's path: the executor writes it out whole on the business's own address. */
const bookPath = (slug: unknown) => (typeof slug === 'string' && slug ? `/book/${slug}` : null);

/** The parts of the state worth reading, with the page's and booking page's links; the teammate's settings left out. */
function stateOf(state: Args): Args {
  const teammate = isObject(state['teammate']) ? state['teammate'] : null;
  const page = isObject(state['page']) ? state['page'] : null;
  const booking = isObject(state['booking']) ? state['booking'] : null;
  const site = booking && isObject(booking['site']) ? booking['site'] : null;
  const found = isObject(state['found']) ? state['found'] : null;
  const facts = Array.isArray(state['facts']) ? (state['facts'] as Args[]) : [];
  return {
    ...state,
    page: page ? { ...page, link: bookPath(page['slug']) } : null,
    ...(booking
      ? { booking: { ...booking, site: site ? { ...site, link: bookPath(site['slug']) } : null } }
      : {}),
    teammate: teammate
      ? {
          id: teammate['id'],
          name: teammate['name'],
          status: teammate['status'],
          revision: teammate['revision'],
        }
      : null,
    facts: facts.map((f) => ({ title: f['title'], status: f['status'] })),
    found: found
      ? {
          url: found['url'],
          at: found['at'],
          services: Array.isArray(found['services']) ? found['services'].length : 0,
          questions: Array.isArray(found['questions']) ? found['questions'].length : 0,
        }
      : null,
  };
}

/**
 * The guided setup's read in its screens' words, what matters first: where it opens, "3 of 15", the screens this
 * business goes through, the summary its screens show (the checking and done screens' lines too), and Your part
 * when the owner is checking it. Then the answers and
 * the state, with Start over's picks last. The words fall back to the plain read should one not be worked out.
 */
export function setupRead(got: unknown): unknown {
  if (!isObject(got) || !isObject(got['state']) || !isObject(got['answers'])) return got;
  const { state, answers, starting, ...rest } = got;
  const words = (() => {
    try {
      const s = onboardingSetupStateOf(state as never);
      const a = answers as never;
      const facts = aiSetupFlowFactsOf(s);
      const name =
        s.teammate?.name ?? (answers['ai'] as { name?: string } | undefined)?.name ?? 'Ava';
      const forClient = s.forClient;
      const place = { website: !!s.website };
      const opensAt = onboardingSetupFirstScreen({
        state: s,
        answers: a,
        reached: (rest['reached'] ?? null) as OnboardingSetupScreen | null,
        finished: rest['finished'],
      });
      const p = onboardingSetupProgress(opensAt, a, facts);
      const checking = onboardingSetupChecking({
        state: s,
        handedOver: rest['handedOver'],
        finished: rest['finished'],
      });
      return {
        opensAt,
        opensOn: onboardingSetupTitle(opensAt, name, place, forClient),
        hint: onboardingSetupHint(opensAt, name, place, forClient),
        progress: `${p.at} of ${p.of} · ${onboardingSetupStopName(p.stop, forClient)}`,
        screens: onboardingSetupScreens(a, facts).map((screen) => ({
          screen,
          stop: onboardingSetupStopName(onboardingSetupStopOf(screen), forClient),
          title: onboardingSetupTitle(screen, name, place, forClient),
        })),
        summary: onboardingSetupSummary(s, a),
        // What the owner checking it still does, as "Your part" lists it.
        ...(checking
          ? { yourPart: onboardingSetupOwnerPart(onboardingSetupOwnerScreens(a, s), a) }
          : {}),
      };
    } catch {
      return {};
    }
  })();
  return {
    reached: rest['reached'] ?? null,
    ...words,
    finished: rest['finished'] ?? null,
    started: rest['started'] ?? null,
    handedOver: rest['handedOver'] ?? null,
    handOverAs: rest['handOverAs'] ?? null,
    answers,
    state: stateOf(state),
    templates: rest['templates'] ?? [],
    templateId: rest['templateId'] ?? null,
    templatePicked: rest['templatePicked'] ?? false,
    saveTo: rest['saveTo'] ?? null,
    ...(isObject(starting) ? { starting } : {}),
  };
}

/** Quick setup's read: the same state, the teammate's settings left out, with Start over's picks last. */
export function aiSetupRead(got: unknown): unknown {
  if (!isObject(got) || !isObject(got['state'])) return got;
  const { state, starting, ...rest } = got;
  return { ...rest, state: stateOf(state), ...(isObject(starting) ? { starting } : {}) };
}

/** Where a step's button goes, as the Assistant names places: a page of the business, the setup's own step, or the phone. */
function stepGoesTo(workspaceId: string, step: OnboardingStep): string {
  const phase = typeof step.note.phase === 'string' ? step.note.phase : undefined;
  const path = stepPath(workspaceId, step.key, { phase });
  if (path === null) return 'The phone app';
  if (path.startsWith('/onboarding/')) return 'Its own setup step, which its button opens';
  const inside = path.replace(`/app/w/${workspaceId}`, '') || '/';
  return screenPlace(inside)?.way ?? 'Its button on Getting started';
}

/**
 * Getting started's read as Home's card shows it: each step's title, its line, its button and badge, and where the
 * button goes; what's next by its title.
 */
export function gettingStartedRead(got: unknown): unknown {
  if (!isObject(got) || !Array.isArray(got['steps'])) return got;
  const workspaceId = String(got['workspaceId'] ?? '');
  const answers = (got['answers'] ?? null) as Parameters<typeof stepWords>[1];
  const steps = (got['steps'] as OnboardingStep[]).map((step) => {
    const w = stepWords(step, answers);
    return {
      key: step.key,
      title: w.title,
      line: w.detail,
      ...(w.badge ? { badge: w.badge } : {}),
      ...(w.action ? { button: w.action, goesTo: stepGoesTo(workspaceId, step) } : {}),
      state: step.state,
      mustDo: step.mustDo,
      group: step.group,
      ...(step.since ? { since: step.since } : {}),
    };
  });
  const next = steps.find((s) => s.key === got['next']);
  return {
    ...got,
    next: next ? { key: next.key, title: next.title } : null,
    steps,
  };
}

/** One client business as onboarding.clients gives it. */
interface OnboardingClient {
  workspaceId: string;
  name: string;
  owner: { name: string; email: string } | null;
  lastSignInAt: string | null;
  enabled: boolean;
  done: number;
  total: number;
  group: 'stuck' | 'setup' | 'done';
  badge: string;
  note: string;
  steps: OnboardingStep[];
  remindedAt: string | null;
}

/** Steps only a client's own owner can do, as the setup sheet says them instead of Do it for them. */
const OWNERS_CALL: Readonly<Record<string, string>> = {
  team: AGENCY_SETUP_WORDS.ownersCall,
  payments: AGENCY_SETUP_WORDS.ownerSignsIn,
};

/**
 * Client businesses' Setup column and each one's setup sheet, as the agency sees them (agency-1, agency-16): where it
 * stands and why, its own owner and when they last signed in, whether a reminder went today, and only the steps still
 * open, each by its title, its line and the whole link Do it for them opens (or that it's the owner's own call).
 */
export function clientsRead(got: unknown, webUrl: string): unknown {
  if (!isObject(got) || !Array.isArray(got['businesses'])) return got;
  const w = AGENCY_SETUP_WORDS;
  const businesses = (got['businesses'] as OnboardingClient[]).map((c) => {
    const open = c.steps.filter((s) => s.state === 'todo' || s.state === 'needs_fix');
    return {
      businessId: c.workspaceId,
      name: c.name,
      setup: `${c.done} of ${c.total} done`,
      group: w.filters[c.group],
      badge: c.badge,
      note: c.note,
      owner: c.owner,
      ownerLastSignedIn: c.lastSignInAt,
      ...(c.remindedAt ? { remindedToday: w.remindedToday } : {}),
      ...(!c.owner ? { noOwner: w.noOwner(c.name) } : {}),
      ...(c.enabled ? {} : { guideOff: w.off }),
      stillOpen: open.map((s) => {
        const words = stepWords(s);
        const owners = OWNERS_CALL[s.key];
        const phase = typeof s.note.phase === 'string' ? s.note.phase : undefined;
        const path = stepPath(c.workspaceId, s.key, { phase });
        return {
          step: words.title,
          ...(s.mustDo ? { basics: true } : {}),
          line: words.detail,
          ...(s.state === 'needs_fix' ? { needsAFix: true } : {}),
          ...(owners
            ? { ownersOwn: owners }
            : c.enabled && path
              ? { doItForThem: `${webUrl}${path}` }
              : {}),
        };
      }),
      openTheSetup: `${webUrl}/onboarding/${c.workspaceId}`,
      openTheirWorkspace: `${webUrl}/app/w/${c.workspaceId}`,
    };
  });
  return { counts: got['counts'], businesses };
}
