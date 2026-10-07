/**
 * How quick setup's screens behave, the same on the web and on the phone
 * (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7–§8): where they open, what a screen still needs before Next,
 * how what the server says meets what's on screen, the answers as they're kept, and the lists people edit. The web's
 * components/ai-setup/quick-setup.tsx and the phone's only draw them. Browser-safe.
 */
import type { QualifyingQuestion } from '../ai-team/config';
import type { TestOutcome } from '../ai-team/test-console';
import {
  AI_SETUP_STEP_FIELDS,
  AI_SETUP_STEPS,
  AiSetupAnswers,
  aiSetupNextStep,
  type AiSetupFlowFacts,
  type AiSetupStep,
} from './answers';
import type { AiSetupState } from './state';
import { aiSetupStepProblems } from './summary';
import { AI_SETUP_FIELD_WORDS as W } from './words';

type Field = keyof AiSetupAnswers;

/** Errors by path into the answers ("services.0.name"), as the answers' own checks and the API give them. */
export type AiSetupProblems = Readonly<Record<string, string>>;

/** The first problem at this path or under it. */
export function aiSetupProblemAt(problems: AiSetupProblems, path: string): string | undefined {
  if (problems[path]) return problems[path];
  const under = Object.keys(problems).find((k) => k.startsWith(`${path}.`));
  return under ? problems[under] : undefined;
}

/** What decides the screens that show only when they apply: a website or the business's simple page, and a chat. */
export const aiSetupFlowFactsOf = (state: {
  readonly website: string | null;
  readonly page: unknown;
  readonly chat: unknown;
}): AiSetupFlowFacts => ({ website: !!state.website, page: !!state.page, chat: !!state.chat });

/** What Ava reads on the website fills these in, on screens not finished yet. */
export const AI_SETUP_READ_FIELDS: readonly Field[] = [
  'description',
  'services',
  'area',
  'openHours',
  'facts',
  'questions',
];

/** The screen each answer is on. */
const STEP_OF = new Map<Field, AiSetupStep>(
  AI_SETUP_STEPS.flatMap((s) => AI_SETUP_STEP_FIELDS[s].map((f) => [f, s] as const)),
);
const at = (s: AiSetupStep | null | undefined) => (s ? AI_SETUP_STEPS.indexOf(s) : -1);

/**
 * Fresh answers over the ones on screen: every answer not changed on screen since the last save, or with `only`,
 * just those, on screens not finished yet. So what Ava reads fills in what's still to come, and never undoes what
 * someone typed or a screen they finished.
 */
export function mergeAiSetupAnswers(
  local: AiSetupAnswers,
  fresh: AiSetupAnswers,
  touched: ReadonlySet<Field>,
  reached: AiSetupStep | null,
  only?: readonly Field[],
): AiSetupAnswers {
  const out: Record<string, unknown> = { ...local };
  for (const key of Object.keys(fresh) as Field[]) {
    if (touched.has(key)) continue;
    if (only && (!only.includes(key) || at(STEP_OF.get(key)) <= at(reached))) continue;
    out[key] = fresh[key];
  }
  return out as AiSetupAnswers;
}

/** Where the screens open: the test chat after Save (`?at=try`), else the screen after the furthest one finished. */
export function aiSetupFirstStep(
  got: {
    readonly state: {
      readonly website: string | null;
      readonly page: unknown;
      readonly chat: unknown;
      readonly teammate: unknown;
    };
    readonly answers: Pick<AiSetupAnswers, 'jobs'>;
    readonly reached: AiSetupStep | null;
  },
  startAt: 'try' | null,
): AiSetupStep {
  if (startAt === 'try' && got.state.teammate) return 'try';
  if (!got.reached) return 'business';
  const next = aiSetupNextStep(got.reached, got.answers, aiSetupFlowFactsOf(got.state));
  return next && next !== 'try' ? next : got.reached;
}

/**
 * A refusal's messages by path into the answers. The API names "answers.services.0.name" (or
 * "/answers/services/0/name"); the screens name "services.0.name". The first message for a path wins.
 */
export function aiSetupProblemsOf(details: unknown): AiSetupProblems {
  if (!Array.isArray(details)) return {};
  const out: Record<string, string> = {};
  for (const d of details as { path?: unknown; message?: unknown }[]) {
    if (!d || typeof d !== 'object') continue;
    const raw = Array.isArray(d.path) ? d.path.join('.') : String(d.path ?? '');
    const path = raw
      .replace(/^\//, '')
      .replaceAll('/', '.')
      .replace(/^answers\./, '');
    if (typeof d.message === 'string' && path && !out[path]) out[path] = d.message;
  }
  return out;
}

/** The first screen's answers, saved to the business straight away. */
export interface AiSetupBusinessDraft {
  readonly name: string;
  readonly industry: string;
  /** As typed, without https://. */
  readonly site: string;
  /** "We don’t have one". */
  readonly noSite: boolean;
}

/** The website as people type it, without the https:// the box already shows. */
export const aiSetupBareSite = (url: string | null): string =>
  (url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

/** The first screen to start from: the business as it is. */
export const aiSetupBusinessDraftOf = (state: {
  readonly businessName: string;
  readonly industry: string | null;
  readonly website: string | null;
}): AiSetupBusinessDraft => ({
  name: state.businessName,
  industry: state.industry ?? '',
  site: aiSetupBareSite(state.website),
  noSite: false,
});

/** The first screen's answers as `ai_setup.save` takes them: no website when there's none, or none was typed. */
export function aiSetupBusinessOf(draft: AiSetupBusinessDraft): {
  name: string;
  industry: string;
  website: string | null;
} {
  const site = draft.site.trim();
  return {
    name: draft.name.trim(),
    industry: draft.industry,
    website: draft.noSite || !site ? null : site,
  };
}

/**
 * What a screen still needs before Next, by path: on the first screen the name and the kind of business; on the
 * others each answer's own checks for the screen's fields, then what `aiSetupStepProblems` says it needs beyond them.
 */
export function aiSetupScreenProblems(
  step: AiSetupStep,
  answers: AiSetupAnswers,
  state: AiSetupState,
  business: Pick<AiSetupBusinessDraft, 'name' | 'industry'>,
): AiSetupProblems {
  const out: Record<string, string> = {};
  if (step === 'business') {
    if (!business.name.trim()) out['business.name'] = W.businessNameMissing;
    if (!business.industry) out['business.industry'] = W.kindMissing;
    return out;
  }
  const fields = AI_SETUP_STEP_FIELDS[step];
  const parsed = AiSetupAnswers.safeParse(answers);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.');
      if (fields.includes(String(issue.path[0]) as Field) && !out[path]) out[path] = issue.message;
    }
  for (const p of aiSetupStepProblems(step, parsed.success ? parsed.data : answers, state))
    if (!out[p.path]) out[p.path] = p.message;
  return out;
}

/**
 * The answers as they're kept: checked (this throws on answers a screen didn't pass), and on "What Ava learned",
 * what's ticked kept and the rest turned down.
 */
export function cleanAiSetupAnswers(
  step: AiSetupStep,
  answers: AiSetupAnswers,
  findings: readonly { readonly id: string }[],
): AiSetupAnswers {
  const clean = AiSetupAnswers.parse(answers);
  if (step !== 'learned') return clean;
  const dropped = new Set(clean.dropFindings);
  return {
    ...clean,
    keepFindings: findings.filter((f) => !dropped.has(f.id)).map((f) => f.id),
    dropFindings: findings.filter((f) => dropped.has(f.id)).map((f) => f.id),
  };
}

/** One thing the website scan found, as "What Ava learned" lists it. */
export interface AiSetupFinding {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The scan's findings nobody has kept or turned down yet, in the order it found them, from
 * `knowledge_suggestion.list`. The list comes newest first; turned around, what arrives while the scan runs joins at
 * the end, so nothing moves while the person ticks.
 */
export const aiSetupFindingsOf = (
  items: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly reason: string;
    readonly proposed: { readonly title: string; readonly body: string };
  }[],
): AiSetupFinding[] =>
  items
    .filter((s) => s.status === 'pending' && s.reason === 'scan')
    .map((s) => ({ id: s.id, kind: s.kind, title: s.proposed.title, body: s.proposed.body }))
    .reverse();

/** The code a business pastes on its website for the chat Save added. */
export const aiSetupChatSnippet = (origin: string, publicKey: string): string =>
  `<script async src="${origin}/embed/v1/${publicKey}.js"></script>`;

// ---- Qualifying questions ----

/** The kinds of answer quick setup offers; a number or file question from the full settings keeps its own. */
export const AI_SETUP_QUESTION_KINDS = ['text', 'choice', 'yes_no'] as const;
export type AiSetupQuestionKind = (typeof AI_SETUP_QUESTION_KINDS)[number];

export const isAiSetupQuestionKind = (kind: string): kind is AiSetupQuestionKind =>
  (AI_SETUP_QUESTION_KINDS as readonly string[]).includes(kind);

/** A new, empty question for leads, answered in their own words, with an id none of these has. */
export function newAiSetupQuestion(
  questions: readonly Pick<QualifyingQuestion, 'id'>[],
): QualifyingQuestion {
  const taken = questions.map((q) => q.id);
  let n = taken.length + 1;
  while (taken.includes(`q${n}`)) n++;
  return {
    id: `q${n}`,
    question: '',
    kind: 'text',
    options: [],
    required: true,
    notAFitIf: { answers: [], below: null, above: null },
    notify: null,
  };
}

/** The question with another kind of answer: choices only for a choice, and no rule-out made for the old kind. */
export function withAiSetupQuestionKind(
  q: QualifyingQuestion,
  kind: AiSetupQuestionKind,
): QualifyingQuestion {
  return {
    ...q,
    kind,
    options: kind === 'choice' ? q.options : [],
    notAFitIf: { ...q.notAFitIf, answers: [], below: null, above: null },
  };
}

/** A choice question's choices, as typed: separated by commas. */
export const aiSetupChoicesOf = (text: string): string[] =>
  text
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

// ---- The test chat ----

/** The teammate didn't answer the question itself, so it's worth an answer in Knowledge. */
export const aiSetupWentToPerson = (outcome: TestOutcome | null | undefined): boolean =>
  outcome === 'handed_off' || outcome === 'no_reply';
