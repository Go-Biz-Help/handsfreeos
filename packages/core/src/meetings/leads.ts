/**
 * Who to follow up with after a HandsFreeOS video call with a live poll (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md,
 * part 5). Browser-safe, so the forms editor, the ranked list and the worker that scores everyone read it the same way.
 *
 * - **Points** (the owner's 21): each answer is worth what its question says (`live.points`, suggested by the AI and
 *   changed by the business), a button pressed is worth its own, and staying to the end is worth the poll's
 *   `leads.stayed`.
 * - **Hot, Warm or Cold** (22) from the points, at the lines the poll sets (`leads.hot`, `leads.warm`).
 * - **What happens to the hot ones** (23) is the poll's `leads.hotAction`: the ranked list; the list plus a card on
 *   Home each; or the AI teammate texts each one within minutes of the end (the default), as a draft to OK while it's
 *   on training wheels.
 * - **The AI's one line** on why is written by the worker once everyone is scored.
 */
import {
  allQuestions,
  liveOf,
  PollLeads,
  POLL_MAX_POINTS,
  type FormDefinition,
  type Question,
} from '../forms/definition';

export const LEAD_LABELS = ['hot', 'warm', 'cold'] as const;
export type LeadLabel = (typeof LEAD_LABELS)[number];
export const LEAD_FOLLOW_UPS = ['list', 'home', 'text'] as const;
export type LeadFollowUp = (typeof LEAD_FOLLOW_UPS)[number];
/** What became of the AI teammate's text to a hot one. */
export const LEAD_OUTCOMES = ['sent', 'drafted', 'card', 'skipped'] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

/** Still there this close to when the team finished counts as staying to the end. */
export const STAYED_GRACE_MS = 2 * 60_000;
/** The longest AI reason kept. */
export const LEAD_REASON_CHARS = 300;

/** The poll's follow-up, its defaults filled in. */
export function pollLeadsOf(definition: Pick<FormDefinition, 'leads'>): PollLeads {
  return PollLeads.parse(definition.leads ?? {});
}

/** Hot, Warm or Cold for so many points. */
export function leadLabelOf(points: number, leads: Pick<PollLeads, 'hot' | 'warm'>): LeadLabel {
  return points >= leads.hot ? 'hot' : points >= leads.warm ? 'warm' : 'cold';
}

/** One answer a question's points can be kept under, and what it says. */
export interface PointsKey {
  readonly key: string;
  readonly label: string;
}

/**
 * The answers a question's points are kept under: each choice, yes and no, each number of a rating or scale, any
 * short answer, or pressing a button. Other kinds of question score nothing.
 */
export function pointsKeysOf(question: Pick<Question, 'type' | 'config'>): PointsKey[] {
  const config = question.config as Record<string, unknown>;
  switch (question.type) {
    case 'choice':
    case 'checkboxes':
      return ((config.choices as { id: string; label: string }[] | undefined) ?? []).map((c) => ({
        key: c.id,
        label: c.label,
      }));
    case 'yes_no':
      return [
        { key: 'yes', label: typeof config.yesLabel === 'string' ? config.yesLabel : 'Yes' },
        { key: 'no', label: typeof config.noLabel === 'string' ? config.noLabel : 'No' },
      ];
    case 'rating':
    case 'scale': {
      const min = question.type === 'scale' && config.min === 0 ? 0 : 1;
      const max = typeof config.max === 'number' ? config.max : question.type === 'scale' ? 10 : 5;
      return Array.from({ length: max - min + 1 }, (_, i) => ({
        key: String(min + i),
        label: String(min + i),
      }));
    }
    case 'short_text':
      return [{ key: 'answered', label: 'Any answer' }];
    case 'button':
      return [{ key: 'pressed', label: 'Pressed it' }];
    default:
      return [];
  }
}

const clampPoints = (n: number) => Math.max(-POLL_MAX_POINTS, Math.min(POLL_MAX_POINTS, n));

/** What one answer is worth, and how it reads ("Yes", "9", "Option A, Option B"); null when it's worth nothing. */
export function answerPoints(
  question: Question,
  value: unknown,
): { readonly points: number; readonly said: string } | null {
  if (value === null || value === undefined || value === '') return null;
  const points = liveOf(question).points;
  const keys = pointsKeysOf(question);
  const labelOf = (key: string) => keys.find((k) => k.key === key)?.label ?? key;
  let total = 0;
  let said = '';
  switch (question.type) {
    case 'choice': {
      const key = String(value);
      total = points[key] ?? 0;
      said = labelOf(key);
      break;
    }
    case 'checkboxes': {
      const picked = (Array.isArray(value) ? value : [value]).map(String);
      total = picked.reduce((sum, key) => sum + (points[key] ?? 0), 0);
      said = picked.map(labelOf).join(', ');
      break;
    }
    case 'yes_no': {
      const key =
        value === true || value === 'yes' ? 'yes' : value === false || value === 'no' ? 'no' : null;
      if (!key) return null;
      total = points[key] ?? 0;
      said = labelOf(key);
      break;
    }
    case 'rating':
    case 'scale': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return null;
      total = points[String(Math.round(n))] ?? 0;
      said = String(Math.round(n));
      break;
    }
    case 'short_text':
      if (typeof value !== 'string' || !value.trim()) return null;
      total = points.answered ?? 0;
      said = 'answered';
      break;
    case 'button':
      if (value !== true) return null;
      total = points.pressed ?? 0;
      said = 'pressed';
      break;
    default:
      return null;
  }
  return total ? { points: total, said } : null;
}

/** One line of what someone's points came from. */
export interface LeadPart {
  readonly what: string;
  readonly points: number;
}

export interface LeadScore {
  readonly points: number;
  readonly label: LeadLabel;
  readonly parts: readonly LeadPart[];
}

/** Someone's points from their answers and staying to the end, Hot, Warm or Cold, and what the points came from. */
export function scoreLead(
  definition: Pick<FormDefinition, 'pages' | 'leads'>,
  answers: Readonly<Record<string, unknown>>,
  stayed: boolean,
): LeadScore {
  const leads = pollLeadsOf(definition);
  const parts: LeadPart[] = [];
  for (const question of allQuestions(definition)) {
    const got = answerPoints(question, answers[question.id]);
    if (!got) continue;
    const label = question.type === 'button' ? buttonLabelOf(question) : null;
    parts.push({
      what: label ? `Pressed “${label}”` : `“${question.title}”: ${got.said}`,
      points: clampPoints(got.points),
    });
  }
  if (stayed && leads.stayed) parts.push({ what: LEAD_WORDS.stayed, points: leads.stayed });
  const points = parts.reduce((sum, p) => sum + p.points, 0);
  return { points, label: leadLabelOf(points, leads), parts };
}

const buttonLabelOf = (question: Question): string => {
  const label = (question.config as { label?: unknown }).label;
  return typeof label === 'string' && label ? label : question.title;
};

/** The most a poll could give someone: every question's best answer, every button, and staying to the end. */
export function mostPoints(definition: Pick<FormDefinition, 'pages' | 'leads'>): number {
  let most = pollLeadsOf(definition).stayed;
  for (const question of allQuestions(definition)) {
    const points = liveOf(question).points;
    const values = pointsKeysOf(question).map((k) => points[k.key] ?? 0);
    most +=
      question.type === 'checkboxes'
        ? values.filter((v) => v > 0).reduce((a, b) => a + b, 0)
        : Math.max(0, ...values);
  }
  return most;
}

export const LEAD_LABEL_WORDS: Readonly<Record<LeadLabel, string>> = {
  hot: 'Hot',
  warm: 'Warm',
  cold: 'Cold',
};

export const LEAD_FOLLOW_UP_WORDS: Readonly<
  Record<LeadFollowUp, { readonly label: string; readonly help: string }>
> = {
  list: {
    label: 'Just the list',
    help: 'Everyone is ranked on the webinar’s appointment, hottest first.',
  },
  home: {
    label: 'The list, and a card on Home',
    help: 'Each hot one also gets a card at the top of Home, for someone on the team to reach out.',
  },
  text: {
    label: 'The AI teammate texts them',
    help: 'Within minutes of the end, the AI teammate texts each hot one, from their answers. While it’s on training wheels, each text waits for your OK.',
  },
};

export const LEAD_OUTCOME_WORDS: Readonly<Record<LeadOutcome, string>> = {
  sent: 'The AI teammate texted them',
  drafted: 'A text waits for your OK',
  card: 'On Home for someone to reach out',
  skipped: 'Not texted',
};

export const LEAD_WORDS = {
  title: 'Who to follow up with',
  stayed: 'Stayed to the end',
  points: (n: number) => (n === 1 ? '1 point' : `${n} points`),
  editorHelp:
    'After each call with this poll, everyone who came gets points for their answers, the buttons they pressed and staying to the end, then Hot, Warm or Cold.',
  stayedLabel: 'Points for staying to the end',
  hotFrom: 'Hot from',
  warmFrom: 'Warm from',
  pointsSuffix: 'points',
  hotAction: 'What happens to hot ones',
  answerPoints: 'Points for each answer',
  answerPointsHelp:
    'What each answer says about how ready they are. Leave 0 for answers that say nothing.',
  suggest: 'Suggest points for every question',
  suggestOne: 'Suggest points',
  suggesting: 'Suggesting…',
  most: (n: number) => `The most anyone can get is ${n}.`,
  none: 'Nobody came, so there’s nobody to follow up with.',
  waiting: 'Everyone is scored a minute after the call ends.',
  noPoll: 'Pick a live poll for the call, and everyone who came is scored when it ends.',
  workflowTrigger: 'Somebody is rated after a webinar',
  counts: (hot: number, warm: number, cold: number) => `${hot} hot · ${warm} warm · ${cold} cold`,
  timeline: (label: LeadLabel, what: string, points: number) =>
    `rated them ${LEAD_LABEL_WORDS[label]} after ${what} · ${points === 1 ? '1 point' : `${points} points`}`,
  homeTitle: 'Hot after your webinar',
} as const;
