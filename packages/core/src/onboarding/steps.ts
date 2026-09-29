/**
 * Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md): the steps a business goes through after Create
 * business, the order its answers put them in, and where each one stands. One copy, so the web, the phone and the
 * agency view agree. Browser-safe: the facts come from `onboarding/load.ts` on the server, and the phone and the
 * browser add what only they know (`DeviceFacts`).
 */
import type { PhoneNextStep } from '../schemas/telephony';

/** Shared by everyone who manages the business, and what the agency view counts. */
export const BUSINESS_STEPS = [
  'number',
  'payments',
  'customers',
  'calendar',
  'ai',
  'team',
  'email_chat',
] as const;
export type BusinessStepKey = (typeof BUSINESS_STEPS)[number];

/** One person's own: an owner sees the first two under "When you're ready", a teammate sees all four. */
export const PERSONAL_STEPS = ['app', 'sign_in', 'notifications', 'my_calendar'] as const;
export type PersonalStepKey = (typeof PERSONAL_STEPS)[number];

export type OnboardingStepKey = BusinessStepKey | PersonalStepKey;

export const isBusinessStep = (key: string): key is BusinessStepKey =>
  (BUSINESS_STEPS as readonly string[]).includes(key);

/** "What do you want help with first?" */
export const ONBOARDING_GOALS = ['leads', 'booked', 'paid', 'organized'] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

/** "Where are your customers now?" */
export const CUSTOMER_SOURCES = ['sheet', 'ghl', 'crm', 'phone', 'none'] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

/** "How many people work with you?" */
export const TEAM_SIZES = ['solo', 'small', 'big'] as const;
export type TeamSize = (typeof TEAM_SIZES)[number];

export interface OnboardingAnswers {
  readonly goal: OnboardingGoal;
  readonly customersIn: CustomerSource;
  readonly teamSize: TeamSize;
}

/**
 * Where a step stands. `waiting` is on someone else (the carriers, Stripe, an import running) with the person's
 * part done, so it counts as done; `needs_fix` is theirs to put right.
 */
export const STEP_STATES = ['todo', 'waiting', 'needs_fix', 'done', 'skipped'] as const;
export type StepState = (typeof STEP_STATES)[number];

export type StepGroup = 'basics' | 'later' | 'yours';

/** Who a person is to the guide: someone who sets the business up, or a teammate with a list of their own. */
export type OnboardingAudience = 'business' | 'personal';

/** What the server reads for a business and a person. Business facts are null for a teammate. */
export interface OnboardingFacts {
  readonly business: {
    readonly number: {
      readonly next: PhoneNextStep;
      /** The number as people read it, "(512) 555-0148". */
      readonly display: string | null;
      /** When the details went to the carriers, while they're reviewing them. */
      readonly since: string | null;
      /** The carriers' words when they turned it down. */
      readonly rejectionReason: string | null;
    };
    readonly payments: {
      readonly active: boolean;
      /** Connected, and the provider still checking it: nothing can be taken yet. */
      readonly checking: boolean;
      /** The provider wants more details from the business, in its own dashboard. */
      readonly needsInfo: boolean;
      /** Signed out or erroring, with none working. */
      readonly broken: boolean;
      readonly provider: 'stripe' | 'square' | null;
    };
    readonly customers: {
      /** People and companies, as Home counts them. */
      readonly count: number;
      readonly asYouGo: boolean;
      /** A spreadsheet importing, or a move from another CRM counting or moving. */
      readonly running: 'import' | 'migration' | null;
      /** A move from another CRM has counts to check, or something to look at. */
      readonly migrationNeedsYou: boolean;
    };
    readonly calendar: {
      readonly calendars: number;
      readonly services: number;
      readonly bookingOn: boolean;
    };
    readonly ai: {
      /** The AI teammate's name, once there is one. */
      readonly name: string | null;
      /** Published answers in the knowledge base. */
      readonly published: number;
      readonly profileFilled: number;
      readonly profileTotal: number;
      /** What a website scan found that nobody has kept or turned down. */
      readonly pendingSuggestions: number;
      readonly scanRunning: boolean;
    };
    readonly team: {
      readonly members: number;
      /** Invitations not accepted, revoked or expired. */
      readonly liveInvitations: number;
    };
    readonly emailChat: {
      readonly mailbox: boolean;
      /** The chat widget has been seen on the business's website. */
      readonly chat: boolean;
    };
  } | null;
  readonly person: {
    /** Phones this person gets notifications on. A phone registers only once notifications are allowed. */
    readonly phones: number;
    readonly calendarConnected: boolean;
  };
}

/**
 * What only the device knows. The browser reads the person's passkeys and Google sign-in; the phone knows it is
 * the app, and whether notifications are allowed on it.
 */
export interface DeviceFacts {
  readonly signIn?: boolean;
  readonly app?: boolean;
  readonly notifications?: boolean;
}

/** What a step's words need about where it stands. */
export interface StepNote {
  /** Which part of a longer step it's at: the number's next step, or what the customers step is waiting on. */
  readonly phase?: string;
  readonly number?: string | null;
  readonly reason?: string | null;
  readonly name?: string | null;
  readonly provider?: string | null;
  readonly count?: number;
  /** For a step with two halves (a mailbox and website chat). */
  readonly partsDone?: number;
  readonly partsTotal?: number;
}

export interface OnboardingStep {
  readonly key: OnboardingStepKey;
  readonly group: StepGroup;
  readonly mustDo: boolean;
  readonly state: StepState;
  /** When the wait began, for "In review · day 2". */
  readonly since: string | null;
  readonly note: StepNote;
}

export interface OnboardingProgress {
  readonly steps: readonly OnboardingStep[];
  /** Done or waiting, out of the steps not skipped. */
  readonly done: number;
  readonly total: number;
  readonly skipped: number;
  /** Every step is done, waiting or skipped: the guide can go away for good. */
  readonly complete: boolean;
  /** The step to put first: the first open must-do, else the first open step. */
  readonly next: OnboardingStepKey | null;
}

/**
 * The must-dos in order. The business number always goes first, because carrier review takes days to weeks and
 * everything else can happen while it runs; the goal puts its own step second. "Getting paid" makes payments a
 * must-do (Chris, 2026-09-29).
 */
export function mustDoOrder(goal: OnboardingGoal | null | undefined): readonly BusinessStepKey[] {
  switch (goal) {
    case 'leads':
      return ['number', 'ai', 'customers', 'calendar'];
    case 'booked':
      return ['number', 'calendar', 'ai', 'customers'];
    case 'paid':
      return ['number', 'payments', 'customers', 'calendar', 'ai'];
    default:
      return ['number', 'customers', 'calendar', 'ai'];
  }
}

/** "When you're ready", for someone who sets the business up. Just me hides Invite your team. */
export function laterOrder(
  answers: OnboardingAnswers | null | undefined,
): readonly OnboardingStepKey[] {
  const out: OnboardingStepKey[] = [];
  if (answers?.teamSize !== 'solo') out.push('team');
  if (answers?.goal !== 'paid') out.push('payments');
  out.push('email_chat', 'app', 'sign_in');
  return out;
}

/** A teammate's own list, in the order it's worth doing. */
export const TEAMMATE_ORDER: readonly PersonalStepKey[] = [
  'app',
  'notifications',
  'my_calendar',
  'sign_in',
];

type Standing = Pick<OnboardingStep, 'state' | 'since' | 'note'>;

const todo = (note: StepNote = {}): Standing => ({ state: 'todo', since: null, note });
const done = (note: StepNote = {}): Standing => ({ state: 'done', since: null, note });

/** Fewer published answers than this, or a profile under half full, is too little for the AI to go on. */
export const ENOUGH_KNOWLEDGE_ITEMS = 5;

function numberStanding(n: NonNullable<OnboardingFacts['business']>['number']): Standing {
  const note = { phase: n.next, number: n.display };
  switch (n.next) {
    case 'ready':
      return done(note);
    case 'awaiting_approval':
      return { state: 'waiting', since: n.since, note };
    // A number on its way: bought and being set up (a minute), or moving over from another carrier (weeks).
    case 'provisioning':
    case 'porting':
      return { state: 'waiting', since: null, note };
    case 'rejected':
      return { state: 'needs_fix', since: null, note: { ...note, reason: n.rejectionReason } };
    default:
      return todo(note);
  }
}

function standingOf(key: OnboardingStepKey, facts: OnboardingFacts, device: DeviceFacts): Standing {
  const b = facts.business;
  switch (key) {
    case 'number':
      return b ? numberStanding(b.number) : todo();
    case 'payments': {
      if (!b) return todo();
      const p = b.payments;
      const note = { provider: p.provider };
      if (p.active && p.needsInfo)
        return { state: 'needs_fix', since: null, note: { ...note, phase: 'needs_info' } };
      if (p.active) return p.checking ? { state: 'waiting', since: null, note } : done(note);
      if (p.broken) return { state: 'needs_fix', since: null, note: { ...note, phase: 'reauth' } };
      return todo(note);
    }
    case 'customers': {
      if (!b) return todo();
      const c = b.customers;
      if (c.count > 0) return done({ count: c.count });
      if (c.asYouGo) return done({ phase: 'as_you_go' });
      if (c.migrationNeedsYou) return todo({ phase: 'migration_check' });
      if (c.running) return { state: 'waiting', since: null, note: { phase: c.running } };
      return todo();
    }
    case 'calendar': {
      if (!b) return todo();
      const c = b.calendar;
      const parts = [c.calendars > 0 && c.services > 0, c.bookingOn];
      const note = {
        count: c.services,
        partsDone: parts.filter(Boolean).length,
        partsTotal: parts.length,
        phase: !parts[0] ? 'services' : 'booking',
      };
      return parts.every(Boolean) ? done(note) : todo(note);
    }
    case 'ai': {
      if (!b) return todo();
      const a = b.ai;
      const enough =
        a.published >= ENOUGH_KNOWLEDGE_ITEMS && a.profileFilled >= Math.ceil(a.profileTotal / 2);
      if (a.name && enough) return done({ name: a.name, count: a.published });
      if (a.pendingSuggestions > 0)
        return todo({ name: a.name, phase: 'suggestions', count: a.pendingSuggestions });
      if (a.scanRunning) return todo({ name: a.name, phase: 'scanning' });
      return todo({ name: a.name, phase: a.name ? 'thin' : 'none', count: a.published });
    }
    case 'team':
      if (!b) return todo();
      return b.team.members > 1 || b.team.liveInvitations > 0
        ? done({ count: b.team.members, phase: b.team.members > 1 ? 'joined' : 'invited' })
        : todo();
    case 'email_chat': {
      if (!b) return todo();
      const parts = [b.emailChat.mailbox, b.emailChat.chat];
      const note = {
        partsDone: parts.filter(Boolean).length,
        partsTotal: parts.length,
        phase: b.emailChat.mailbox ? 'mailbox' : b.emailChat.chat ? 'chat' : 'none',
      };
      return parts.every(Boolean) ? done(note) : todo(note);
    }
    case 'app':
      return (device.app ?? facts.person.phones > 0) ? done() : todo();
    case 'notifications':
      return (device.notifications ?? facts.person.phones > 0) ? done() : todo();
    case 'my_calendar':
      return facts.person.calendarConnected ? done() : todo();
    case 'sign_in':
      return device.signIn === true ? done() : todo();
  }
}

/**
 * Where every step stands for one person. A skip only matters while a step is still to do: one done since, or
 * waiting on someone else, shows as that.
 */
export function onboardingProgress(input: {
  readonly audience: OnboardingAudience;
  readonly answers: OnboardingAnswers | null;
  readonly facts: OnboardingFacts;
  readonly skipped: ReadonlySet<OnboardingStepKey>;
  readonly device?: DeviceFacts;
}): OnboardingProgress {
  const device = input.device ?? {};
  const layout: { key: OnboardingStepKey; group: StepGroup; mustDo: boolean }[] =
    input.audience === 'business'
      ? [
          ...mustDoOrder(input.answers?.goal).map((key) => ({
            key,
            group: 'basics' as const,
            mustDo: true,
          })),
          ...laterOrder(input.answers).map((key) => ({
            key,
            group: 'later' as const,
            mustDo: false,
          })),
        ]
      : TEAMMATE_ORDER.map((key) => ({ key, group: 'yours' as const, mustDo: false }));
  const steps = layout.map(({ key, group, mustDo }): OnboardingStep => {
    const s = standingOf(key, input.facts, device);
    const open = s.state === 'todo' || s.state === 'needs_fix';
    return {
      key,
      group,
      mustDo,
      ...s,
      state: open && input.skipped.has(key) ? 'skipped' : s.state,
    };
  });
  const counted = steps.filter((s) => s.state !== 'skipped');
  const isOpen = (s: OnboardingStep) => s.state === 'todo' || s.state === 'needs_fix';
  return {
    steps,
    done: counted.filter((s) => s.state === 'done' || s.state === 'waiting').length,
    total: counted.length,
    skipped: steps.length - counted.length,
    complete: !steps.some(isOpen),
    next: (steps.find((s) => s.mustDo && isOpen(s)) ?? steps.find(isOpen))?.key ?? null,
  };
}

/** Whole days since a wait began, counting the first day as day 1: "In review · day 2". */
export function waitingDay(since: string | null, now: Date = new Date()): number | null {
  if (!since) return null;
  const start = new Date(since).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(1, Math.floor((now.getTime() - start) / 86_400_000) + 1);
}
