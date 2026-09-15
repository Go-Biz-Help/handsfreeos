/**
 * The follow-up nudge: the business's own words, sent once by HandsFreeOS to a stale lead or an overdue follow-up
 * (never before an owner has read them once). Browser-safe, so Settings shows the same verdict and preview the
 * worker sends with.
 *
 * It may fill in only {firstName} {businessName} {leadTitle} {senderName} {businessPhone}. It never gives an amount
 * or a price (the AI teammate's money check), a link other than the business's own, another phone number or
 * address, or asks for a reply the carriers read as a keyword (CANCEL is STOP, YES is START).
 */
import {
  checkTeammateReply,
  plainSmsText,
  REPLY_LIMITS,
  type ReplyCheckContext,
} from '../ai-team/guardrails';
import { smsKeyword } from '../messaging/sms';

export const NUDGE_PLACEHOLDERS = [
  'firstName',
  'businessName',
  'leadTitle',
  'senderName',
  'businessPhone',
] as const;
export type NudgePlaceholder = (typeof NUDGE_PLACEHOLDERS)[number];

const isPlaceholder = (name: string): name is NudgePlaceholder =>
  (NUDGE_PLACEHOLDERS as readonly string[]).includes(name);

/** Straight apostrophes: a curly one sends a text in the slower encoding. */
export const DEFAULT_NUDGE_TEMPLATE =
  "Hi {firstName}, it's {senderName} at {businessName}. Just checking in: are you still looking for help? Reply here and we'll take it from there.";

/** What a blank value becomes. businessName and businessPhone have none: a nudge without them isn't sent. */
const FALLBACKS: Readonly<Partial<Record<NudgePlaceholder, string>>> = {
  firstName: 'there',
  senderName: 'the team',
  leadTitle: 'your project',
};

export type NudgeValues = Readonly<Partial<Record<NudgePlaceholder, string | null>>>;

export interface NudgeRender {
  readonly text: string;
  /** Placeholders with no value and no fallback: the worker skips the nudge and says why. */
  readonly missing: readonly NudgePlaceholder[];
}

/** `{name}`, and `{{name}}` (the workflow form, which nudges don't use). */
const TOKEN_RE = /\{\{[^{}]*\}\}|\{[^{}]*\}/g;

const tidy = (text: string) =>
  plainSmsText(text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .trim();

/** Fills the template. Unknown slots stay as written (the check reports them). */
export function renderNudge(template: string, values: NudgeValues): NudgeRender {
  const missing: NudgePlaceholder[] = [];
  const text = template.replace(TOKEN_RE, (whole) => {
    const name = whole.slice(1, -1).trim();
    if (whole.startsWith('{{') || !isPlaceholder(name)) return whole;
    const value = values[name]?.trim() || FALLBACKS[name];
    if (value) return value;
    if (!missing.includes(name)) missing.push(name);
    return '';
  });
  return { text: tidy(text), missing };
}

const USE = 'Use {firstName}, {businessName}, {leadTitle}, {senderName} or {businessPhone}.';

/** Every slot the template can't fill, in plain words. */
export function nudgePlaceholderProblems(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN_RE)) {
    const whole = m[0];
    let message: string | null = null;
    if (whole.startsWith('{{')) {
      const inner = whole.slice(2, -2).trim();
      message = isPlaceholder(inner)
        ? `Use single braces: {${inner}}, not ${whole}.`
        : `${whole} can’t be filled in. ${USE}`;
    } else if (!isPlaceholder(whole.slice(1, -1).trim())) {
      message = `${whole} can’t be filled in. ${USE}`;
    }
    if (message && !out.includes(message)) out.push(message);
  }
  return out;
}

/** The first slot the template can't fill, or null. */
export function nudgePlaceholderProblem(template: string): string | null {
  return nudgePlaceholderProblems(template)[0] ?? null;
}

// ---- The check Settings shows ----

export const NUDGE_PROBLEM_CODES = [
  'empty',
  'placeholder',
  'money',
  'link',
  'phone',
  'email',
  'keyword',
  'length',
] as const;
export type NudgeProblemCode = (typeof NUDGE_PROBLEM_CODES)[number];

export interface NudgeProblem {
  readonly code: NudgeProblemCode;
  /** Plain words for Settings, under the message box. */
  readonly message: string;
}

export interface NudgeCheck {
  readonly ok: boolean;
  readonly problems: readonly NudgeProblem[];
}

export interface NudgeCheckContext {
  readonly businessName: string;
  /** How {businessPhone} reads; a sample when the business has no number yet. */
  readonly businessPhone?: string | null;
  /** The business's own links, numbers and addresses: the only ones a nudge may give. */
  readonly allowed: Pick<
    ReplyCheckContext['allowed'],
    'domains' | 'urlPrefixes' | 'phones' | 'emails'
  >;
}

/** What the preview and the check fill in. */
export const NUDGE_SAMPLE = {
  firstName: 'Maria',
  leadTitle: 'AC replacement',
  senderName: 'Dale',
  businessPhone: '(512) 555-0100',
} as const;

const ASK_RE =
  /\b(?:reply|text|respond|send|type|write)\s+(?:back\s+)?(?:with\s+)?(?:the\s+word\s+)?["'“”‘’]?([a-z]+)\b/gi;

/** Carrier keywords the message asks for, other than STOP itself (the standard opt-out wording). */
function keywordAsks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ASK_RE)) {
    const word = m[1]!.toUpperCase();
    if (word !== 'STOP' && smsKeyword(word) && !out.includes(word)) out.push(word);
  }
  return out;
}

function keywordMessage(word: string): string {
  switch (smsKeyword(word)) {
    case 'stop':
      return `Don’t ask them to reply ${word}: carriers treat it like STOP and opt them out of texts.`;
    case 'start':
      return `Don’t ask them to reply ${word}: carriers treat it as START, a request to get texts.`;
    default:
      return `Don’t ask them to reply ${word}: carriers answer it with an automatic help message.`;
  }
}

/** The guardrail's words, said about a template. */
function guardMessage(rule: string, message: string): string {
  const given = /^It gives (.+?), which/.exec(message)?.[1];
  if (rule === 'phone' && given)
    return `The message gives ${given}, which isn’t the business’s number.`;
  if (rule === 'email' && given)
    return `The message gives ${given}, which isn’t the business’s address.`;
  return message.replace(/^It /, 'The message ');
}

/**
 * Whether a template may be saved and sent, with every problem in plain words. It fills the template with a
 * sample customer, then runs the AI teammate's checks for money, links, numbers, addresses and leftover
 * placeholders, and the carrier-keyword and length checks.
 */
export function checkNudgeTemplate(template: string, ctx: NudgeCheckContext): NudgeCheck {
  if (!template.trim())
    return { ok: false, problems: [{ code: 'empty', message: 'Write the follow-up message.' }] };
  const problems: NudgeProblem[] = [];
  const add = (code: NudgeProblemCode, message: string) => {
    if (!problems.some((p) => p.message === message)) problems.push({ code, message });
  };
  for (const message of nudgePlaceholderProblems(template)) add('placeholder', message);

  const phone = ctx.businessPhone?.trim() || NUDGE_SAMPLE.businessPhone;
  const { text } = renderNudge(template, {
    firstName: NUDGE_SAMPLE.firstName,
    businessName: ctx.businessName,
    leadTitle: NUDGE_SAMPLE.leadTitle,
    senderName: NUDGE_SAMPLE.senderName,
    businessPhone: phone,
  });
  // Unknown slots are reported above; the guardrail shouldn't report them again.
  const filled = tidy(text.replace(TOKEN_RE, ' '));

  const verdict = checkTeammateReply(filled, {
    channel: 'sms',
    disclosure: 'when_asked',
    firstMessage: false,
    askedIfHuman: false,
    allowed: {
      domains: ctx.allowed.domains,
      urlPrefixes: ctx.allowed.urlPrefixes,
      urls: [],
      phones: [...ctx.allowed.phones, phone],
      emails: ctx.allowed.emails,
    },
    allowPrices: false,
    knowledge: [],
    done: { booked: false, rescheduled: false, cancelled: false },
    discountPercent: null,
  });
  for (const p of verdict.problems)
    if (
      p.rule === 'placeholder' ||
      p.rule === 'money' ||
      p.rule === 'link' ||
      p.rule === 'phone' ||
      p.rule === 'email'
    )
      add(p.rule, guardMessage(p.rule, p.message));

  for (const word of keywordAsks(filled)) add('keyword', keywordMessage(word));

  const length = [...filled].length;
  if (length > REPLY_LIMITS.sms)
    add(
      'length',
      `With a name filled in, this text is ${length} characters. Keep it to ${REPLY_LIMITS.sms}.`,
    );
  return { ok: problems.length === 0, problems };
}
