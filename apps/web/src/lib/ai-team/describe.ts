/**
 * Plain words about an AI teammate: the builder's module list and each module's one-line summary, "How Ava
 * works", training-wheels progress, and the names the test console and Activity give tools, checks and
 * results. Computed from the draft, so they change as it is edited.
 */
import {
  followUpLadderWords,
  followUpScheduleHours,
  formatHours,
  TEAMMATE_LABEL_NAMES,
  type DisclosureMode,
  type NotifyWho,
  type ReplyRule,
  type TeammateCatalogs,
  type TeammateConfig,
  type TeammateLabel,
  type TeammateToolName,
} from '@hfos/core';
import { dateOf, fmtMonthDay, fmtTime, todayIn } from '../calendar/time';
import type {
  RunOutcome,
  RunStatus,
  TeammateChannelKey,
  TeammateProgress,
  TeammateRevision,
  TeammateStatus,
  TeammateToolCall,
} from './types';

export const MODULES = [
  { key: 'identity', name: 'Identity' },
  { key: 'channels', name: 'Channels' },
  { key: 'respond', name: 'Respond' },
  { key: 'answer', name: 'Answer' },
  { key: 'qualify', name: 'Qualify' },
  { key: 'book', name: 'Book' },
  { key: 'followUp', name: 'Follow up' },
  { key: 'hours', name: 'Hours' },
  { key: 'autonomy', name: 'Autonomy' },
  { key: 'limits', name: 'Limits' },
  { key: 'handOff', name: 'Hand-off' },
] as const;
export type ModuleKey = (typeof MODULES)[number]['key'];

/** Which module a rule's settings path belongs to ('channels.emailAddressId' → channels). Money lives in
 * Limits, as on the canvas. */
const FIELD_MODULE: Readonly<Record<string, ModuleKey>> = {
  identity: 'identity',
  channels: 'channels',
  respond: 'respond',
  answer: 'answer',
  qualify: 'qualify',
  book: 'book',
  followUp: 'followUp',
  hours: 'hours',
  autonomy: 'autonomy',
  limits: 'limits',
  money: 'limits',
  handOff: 'handOff',
};

export function moduleOfField(field: string): ModuleKey | null {
  return FIELD_MODULE[field.split('.')[0] ?? ''] ?? null;
}

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** "Dale, Priya and Marco" / "text or email". */
export function joinWords(list: readonly string[], word = 'and'): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} ${word} ${list[list.length - 1]}`;
}

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** 30 → "30 min", 120 → "2 h", 90 → "1 h 30 min". */
export function shortDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const CHANNEL_NAMES: Readonly<Record<TeammateChannelKey, string>> = {
  sms: 'Text',
  email: 'Email',
  chat: 'Website chat',
};
const CHANNEL_NOUNS: Readonly<Record<TeammateChannelKey, string>> = {
  sms: 'texts',
  email: 'emails',
  chat: 'website chats',
};

export function channelsOn(config: TeammateConfig): TeammateChannelKey[] {
  return (['sms', 'email', 'chat'] as const).filter((k) => config.channels[k]);
}

/** Topics it always hands to a person, whatever the settings (core's guardrails find them). */
export const BUILT_IN_TOPICS = ['Refunds', 'Legal threats', 'Complaints', 'Cancelling service'];

/** "owners and admins", "Dale and Priya", "the lead’s assignee", or "no one". */
export function notifyWords(who: NotifyWho | null, members: TeammateCatalogs['members']): string {
  if (!who) return 'no one';
  switch (who.kind) {
    case 'admins':
      return 'owners and admins';
    case 'users':
      return joinWords(
        who.userIds.map((u) => {
          const m = typeof u === 'string' ? members.find((x) => x.userId === u) : undefined;
          return m ? firstName(m.name) : 'someone';
        }),
      );
    case 'lead_assignee':
      return 'the lead’s assignee';
    case 'person_owner':
      return 'the customer’s owner';
  }
}

/** The stage a qualified lead moves to, with its pipeline. */
export function stageOf(
  id: string | null,
  catalogs: TeammateCatalogs,
): { stage: string; pipeline: string } | null {
  if (!id) return null;
  for (const p of catalogs.pipelines ?? []) {
    const s = p.stages.find((x) => x.id === id);
    if (s) return { stage: s.name, pipeline: p.name };
  }
  return null;
}

const calendarName = (id: string, catalogs: TeammateCatalogs) =>
  catalogs.calendars.find((c) => c.id === id)?.name ?? 'a calendar';

/** A qualifying question with an answer that rules a lead out. */
export const rulesOut = (q: TeammateConfig['qualify']['questions'][number]): boolean =>
  q.notAFitIf.answers.length > 0 || q.notAFitIf.below !== null || q.notAFitIf.above !== null;

/** The line under each module's name in the builder's list. */
export function moduleSummary(
  key: ModuleKey,
  config: TeammateConfig,
  catalogs: TeammateCatalogs,
): string {
  switch (key) {
    case 'identity':
      return `${config.identity.name} · says it’s AI ${config.identity.disclosure === 'first_message' ? 'first' : 'when asked'}`;
    case 'channels': {
      const on = channelsOn(config).map((k) => CHANNEL_NAMES[k].toLowerCase());
      return on.length ? capital(joinWords(on)) : 'No channels';
    }
    case 'respond': {
      const r = config.respond;
      if (!r.enabled)
        return catalogs.newLeadTextWorkflows.length ? 'Off · a workflow does it' : 'Off';
      if (!r.newLeads.enabled) return 'Replies · no first message';
      return `First ${r.newLeads.channel === 'sms' ? 'text' : 'email'} ${r.newLeads.delayMinutes ? `after ${shortDuration(r.newLeads.delayMinutes)}` : 'right away'}`;
    }
    case 'answer':
      return config.answer.enabled
        ? plural(catalogs.knowledge.published, 'Knowledge item', 'Knowledge items')
        : 'Off';
    case 'qualify': {
      const q = config.qualify;
      if (!q.enabled) return 'Off';
      if (!q.questions.length) return 'No questions yet';
      const stage = stageOf(q.whenQualified.stageId, catalogs);
      return `${plural(q.questions.length, 'question', 'questions')}${stage ? ` · ${stage.stage}` : ''}`;
    }
    case 'book': {
      const b = config.book;
      if (!b.enabled) return 'Off';
      if (!b.calendarIds.length) return 'No calendar yet';
      return `${plural(b.calendarIds.length, 'calendar', 'calendars')}${b.reschedule ? ' · moves' : b.cancel ? ' · cancels' : ''}`;
    }
    case 'followUp':
      return config.followUp.enabled
        ? plural(followUpScheduleHours(config.followUp).length, 'follow-up', 'follow-ups')
        : 'Off';
    case 'hours':
      return config.hours.mode === 'always'
        ? 'Always'
        : config.hours.mode === 'after_hours'
          ? 'When you’re closed'
          : formatHours(config.hours.custom);
    case 'autonomy':
      return `${config.autonomy.approvalsNeeded} approvals · ${shortDuration(config.autonomy.draftExpiresMinutes)} drafts`;
    case 'limits':
      return `${config.limits.repliesPerConversationPerDay} a day · ${config.limits.dailySharePercent}% of AI`;
    case 'handOff':
      return `${plural(BUILT_IN_TOPICS.length + config.handOff.sensitiveTopics.length, 'topic', 'topics')} · ${capital(notifyWords(config.handOff.notify, catalogs.members))}`;
  }
}

/** "How Ava works": a handful of short sentences. */
export function describeTeammate(config: TeammateConfig, catalogs: TeammateCatalogs): string[] {
  const out: string[] = [];
  const nouns = channelsOn(config).map((k) => CHANNEL_NOUNS[k]);
  const when =
    config.hours.mode === 'always'
      ? ', day and night'
      : config.hours.mode === 'after_hours'
        ? ' while you’re closed'
        : ` ${formatHours(config.hours.custom)}`;
  if (!nouns.length) out.push('No channel is on, so it can’t answer anyone yet.');
  else if (config.answer.enabled)
    out.push(`Answers ${joinWords(nouns)} from your Knowledge${when}.`);
  else out.push(`Works on ${joinWords(nouns)}${when}.`);

  const r = config.respond;
  if (r.enabled && r.newLeads.enabled)
    out.push(
      `Messages new leads first by ${r.newLeads.channel === 'sms' ? 'text' : 'email'}${r.newLeads.delayMinutes ? `, ${shortDuration(r.newLeads.delayMinutes)} after they come in` : ', right away'}.`,
    );

  const q = config.qualify;
  if (q.enabled) {
    const n = plural(q.questions.length, 'question', 'questions');
    const stage = stageOf(q.whenQualified.stageId, catalogs);
    const tell = q.whenQualified.notify
      ? notifyWords(q.whenQualified.notify, catalogs.members)
      : null;
    const then = [
      ...(stage ? [`moves qualified leads to ${stage.stage}`] : []),
      ...(tell ? [`tells ${tell}`] : []),
      ...(q.whenQualified.offerTimes && config.book.enabled ? ['offers times to book'] : []),
    ];
    out.push(
      !q.questions.length
        ? 'Qualifies leads once you add questions.'
        : !then.length
          ? `Asks ${n} and keeps the answers on the lead.`
          : stage
            ? `Asks ${n}, ${joinWords(then)}.`
            : `Asks ${n}. When a lead qualifies, it ${joinWords(then)}.`,
    );
    if (q.whenNotAFit.tellTeam && q.questions.some(rulesOut))
      out.push('Tells the team when a lead isn’t a fit, so someone can mark it lost.');
  }

  const b = config.book;
  if (b.enabled) {
    const verbs = joinWords([
      'Books',
      ...(b.reschedule ? ['moves'] : []),
      ...(b.cancel ? ['cancels'] : []),
    ]);
    const cals = b.calendarIds.map((id) => calendarName(id, catalogs));
    out.push(
      cals.length
        ? `${verbs} visits on ${joinWords(cals)}.`
        : 'Books visits once you pick a calendar.',
    );
  }
  if (config.followUp.enabled)
    out.push(
      `Follows up when a customer goes quiet: ${followUpLadderWords(config.followUp.ladderHours)}${
        config.followUp.monthlyForMonths
          ? `, then monthly for ${plural(config.followUp.monthlyForMonths, 'month', 'months')}`
          : ''
      }.`,
    );
  out.push(
    `Says it’s an AI ${config.identity.disclosure === 'first_message' ? 'in its first message' : 'when asked'}. Never claims to be a person.`,
  );
  const h = config.handOff;
  const when2 = [
    'when asked',
    ...(h.onFrustration ? ['when they sound frustrated'] : []),
    ...(config.answer.whenUnsure === 'hand_off' ? ['when it can’t answer'] : []),
    `on ${plural(BUILT_IN_TOPICS.length + h.sensitiveTopics.length, 'sensitive topic', 'sensitive topics')}`,
  ];
  out.push(`Hands off to a person ${joinWords(when2, 'or')}.`);
  return out;
}

/** The skills a settings document has on, by module name. Respond counts when it messages new leads, as
 * the labels do. */
export function skillsOn(config: TeammateConfig): string[] {
  const on: string[] = [];
  if (config.respond.enabled && config.respond.newLeads.enabled) on.push('Respond');
  if (config.answer.enabled) on.push('Answer');
  if (config.qualify.enabled) on.push('Qualify');
  if (config.book.enabled) on.push('Book');
  if (config.followUp.enabled) on.push('Follow up');
  return on;
}

export const teammateLabelName = (tag: string): string =>
  TEAMMATE_LABEL_NAMES[tag as TeammateLabel] ?? capital(tag.replace(/_/g, ' '));

/** "Appointment Coordinator, Lead Qualifier". */
export const teammateLabelsText = (tags: readonly string[]): string =>
  (tags.length ? tags : ['custom']).map(teammateLabelName).join(', ');

/** "Revision 6 · saved by Dale today at 10:12 AM", or "Revision 6 · saved today" for phones. */
export function savedLine(
  revision: number,
  latest: Pick<TeammateRevision, 'createdAt' | 'changedBy'> | undefined,
  timeZone: string,
  short = false,
): string {
  if (!latest) return `Revision ${revision}`;
  const day = dateOf(latest.createdAt, timeZone);
  const today = day === todayIn(timeZone);
  if (short) return `Revision ${revision} · saved ${today ? 'today' : fmtMonthDay(day)}`;
  const by = latest.changedBy ? firstName(latest.changedBy.fullName) : 'HandsFreeOS';
  const when = today ? `today at ${fmtTime(latest.createdAt, timeZone)}` : `on ${fmtMonthDay(day)}`;
  return `Revision ${revision} · saved by ${by} ${when}`;
}

// ---- Status and training wheels ----

export const STATUS_NAMES: Readonly<Record<TeammateStatus, string>> = {
  off: 'Off',
  training: 'Training wheels',
  automatic: 'Automatic',
};

export function statusLine(status: TeammateStatus, name: string): string {
  switch (status) {
    case 'off':
      return `${name} doesn’t answer anyone.`;
    case 'training':
      return 'Every message to a customer waits for an OK.';
    case 'automatic':
      return `${name} replies on its own. Discounts still wait for an OK.`;
  }
}

export interface ProgressView {
  readonly approved: number;
  readonly edited: number;
  readonly rejected: number;
  readonly needed: number;
  readonly remaining: number;
  /** 0 to 100, for the bar. */
  readonly percent: number;
  /** "17 of 20 approved · 3 edited". */
  readonly text: string;
  /** "3 to go". */
  readonly toGo: string;
}

/** Training-wheels progress against the approvals the draft asks for (which may not be saved yet). */
export function progressView(p: TeammateProgress | null, needed: number): ProgressView {
  const approved = p?.approvedCount ?? 0;
  const edited = p?.editedCount ?? 0;
  const remaining = Math.max(0, needed - approved);
  return {
    approved,
    edited,
    rejected: p?.rejectedCount ?? 0,
    needed,
    remaining,
    percent: needed ? Math.min(100, Math.round((approved / needed) * 100)) : 0,
    text: `${approved} of ${needed} approved · ${edited} edited`,
    toGo: remaining ? `${remaining} to go` : 'Enough approvals',
  };
}

export function progressAfter(v: ProgressView, name: string): string {
  return v.remaining
    ? `After ${plural(v.remaining, 'more approval', 'more approvals')}, ${name} works on its own.`
    : `${name} has enough approvals and turns automatic with the next one.`;
}

// ---- Checks, tools, knowledge and results (the test console and Activity) ----

export const CHECK_NAMES: Readonly<Record<ReplyRule, string>> = {
  disclosure: 'Says it’s AI',
  money: 'No prices',
  link: 'No links',
  phone: 'No other numbers',
  email: 'No other emails',
  false_claim: 'Booking matches',
  placeholder: 'No blanks left',
  claims_human: 'Never claims to be a person',
  length: 'Right length',
};
const CHECK_ORDER = Object.keys(CHECK_NAMES);

export interface CheckView {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  /** Why it failed, in plain words. */
  readonly message: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function checkView(rule: string, ok: boolean, message: string | null): CheckView {
  return {
    key: rule,
    label: CHECK_NAMES[rule as ReplyRule] ?? capital(rule.replace(/_/g, ' ')),
    ok,
    message,
  };
}

function sortChecks(list: CheckView[]): CheckView[] {
  const rank = (k: string) => {
    const i = CHECK_ORDER.indexOf(k);
    return i < 0 ? CHECK_ORDER.length : i;
  };
  return list.sort((a, b) => rank(a.key) - rank(b.key));
}

/** A run's checks as stored: rule names that passed, `{ rule, ok, message }` rows, or a whole check with
 * its `problems`. */
export function checksOf(raw: readonly unknown[]): CheckView[] {
  const out = new Map<string, CheckView>();
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.set(item.trim(), checkView(item.trim(), true, null));
      continue;
    }
    if (!isRecord(item)) continue;
    if (Array.isArray(item.problems)) {
      for (const p of item.problems) {
        const rule = isRecord(p) ? textOf(p.rule) : null;
        if (rule && isRecord(p)) out.set(rule, checkView(rule, false, textOf(p.message)));
      }
      continue;
    }
    const rule = textOf(item.rule);
    if (rule) out.set(rule, checkView(rule, item.ok !== false, textOf(item.message)));
  }
  return sortChecks([...out.values()]);
}

/** The test console's check: what passed, then what didn't. */
export function checkViews(
  passed: readonly string[],
  problems: readonly { rule: string; message: string }[],
): CheckView[] {
  const out = new Map<string, CheckView>();
  for (const r of passed) out.set(r, checkView(r, true, null));
  for (const p of problems) out.set(p.rule, checkView(p.rule, false, p.message || null));
  return sortChecks([...out.values()]);
}

const TOOL_NAMES: Readonly<Record<TeammateToolName, string>> = {
  search_knowledge: 'Searched Knowledge',
  find_times: 'Found times',
  check_service_area: 'Checked the service area',
  my_appointments: 'Looked up their visits',
  read_call_transcript: 'Read a call',
  book: 'Booked a visit',
  reschedule: 'Moved a visit',
  book_repeating: 'Booked repeat visits',
  join_waitlist: 'Added them to the waitlist',
  add_to_appointment: 'Added to a visit',
  cancel: 'Cancelled a visit',
  record_answers: 'Recorded qualifying answers',
  ask_form: 'Started a form',
  answer_form: 'Saved a form answer',
  move_stage: 'Moved the lead',
  open_deal: 'Opened a lead',
  set_deal_value: 'Set what the lead is worth',
  close_deal: 'Closed the lead',
  update_customer: 'Filled in their details',
  add_note: 'Added a note',
  create_task: 'Created a task',
  send_verification_code: 'Sent a chat code',
  check_verification_code: 'Checked a chat code',
  my_bills: 'Looked up their bills',
  send_payment_link: 'Asked to send a pay link',
  propose_bill: 'Asked to send a bill',
  my_quotes: 'Looked up their quotes',
  send_quote: 'Asked to send a quote’s link',
  propose_quote: 'Asked to send a quote',
  record_quote_answer: 'Asked to record their answer',
  offer_plan: 'Asked to sign them up for a plan',
  offer_discount: 'Offered a discount',
  hand_off: 'Handed to a person',
  reply: 'Wrote the reply',
  no_reply: 'Decided not to reply',
};

export const toolName = (name: string): string =>
  (TOOL_NAMES as Readonly<Record<string, string>>)[name] ?? capital(name.replace(/_/g, ' '));

export interface KnowledgeRef {
  readonly id: string | null;
  readonly title: string;
}

/** The knowledge a run used, as stored: titles, or `{ id, title }` rows. */
export function knowledgeOf(raw: readonly unknown[]): KnowledgeRef[] {
  const out: KnowledgeRef[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ id: null, title: item.trim() });
      continue;
    }
    if (!isRecord(item)) continue;
    const title = textOf(item.title) ?? textOf(item.question) ?? textOf(item.name);
    if (title) out.push({ id: textOf(item.id) ?? textOf(item.itemId), title });
  }
  return out;
}

export type Tone = 'ok' | 'warn' | 'danger' | 'gray' | 'accent';

export function runResult(run: { status: RunStatus; outcome: RunOutcome | null }): {
  label: string;
  tone: Tone;
} {
  if (run.status === 'running') return { label: 'Working on it', tone: 'accent' };
  if (run.status === 'failed') return { label: 'Something went wrong', tone: 'danger' };
  if (run.status === 'superseded') return { label: 'Replaced by a newer reply', tone: 'gray' };
  switch (run.outcome) {
    case 'replied':
      return { label: 'Sent', tone: 'ok' };
    case 'drafted':
      return { label: 'Held as a draft', tone: 'warn' };
    case 'handed_off':
      return { label: 'Needs a person', tone: 'warn' };
    case 'no_reply':
      return { label: 'No reply needed', tone: 'gray' };
    default:
      return { label: 'Done', tone: 'gray' };
  }
}

const TRIGGERS: Readonly<Record<string, string>> = {
  'message.received': 'A message came in',
  'lead.created': 'A new lead came in',
  'conversation.handed_to_ai': 'Someone handed it the conversation',
  'ai_teammate.engaged': 'A workflow handed it the conversation',
  follow_up: 'Time to follow up',
};
export const triggerWords = (t: string): string => TRIGGERS[t] ?? capital(t.replace(/[._]/g, ' '));

// ---- Previews ----

/** The start of its first text to a customer, as the Identity module shows it. */
export function firstTextPreview(
  name: string,
  disclosure: DisclosureMode,
  business: string,
): string {
  const who =
    disclosure === 'first_message'
      ? `${name}, the AI assistant at ${business}`
      : `${name} at ${business}`;
  return `Hi Mike, this is ${who}. How can I help?`;
}

/** Examples of what the worker puts in the hand-off line's {expectation}. */
export const EXPECTATION_EXAMPLES = {
  open: 'someone will reply within 15 minutes',
  closed: 'someone will reply when we open',
} as const;

export function afterHoursWords(businessHours: TeammateCatalogs['businessHours']): string {
  return businessHours?.length
    ? `Only while you’re closed. You’re open ${formatHours(businessHours)}.`
    : 'Only while you’re closed, once your open hours are set (Settings, Workspace).';
}

// ---- Activity, and today's AI use ----

/** Tokens as a share of the daily limit: "0%", "<1%", "34%". */
export function percentOfLimit(tokens: number, limit: number): string {
  if (!tokens || !limit) return '0%';
  const p = (tokens / limit) * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** A calendar's visit lengths: "1 h 30 min", "30 min or 1 h". */
export const lengthsWords = (lengths: readonly number[]): string =>
  joinWords(lengths.map(shortDuration), 'or');

/** "10:36:05": when a tool ran. The run sheet's heading already says the hour and half of the day. */
export function clockWithSeconds(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
    .format(new Date(at))
    .replace(/\s?[AP]M$/i, '');
}

/** "Mike texted at 10:36 AM": who wrote the message that started a run, and when. */
export function wroteWords(
  name: string | null,
  channel: TeammateChannelKey | null,
  at: string,
  timeZone: string,
): string {
  const who = name ? firstName(name) : 'They';
  const verb =
    channel === 'sms'
      ? 'texted'
      : channel === 'email'
        ? 'emailed'
        : channel === 'chat'
          ? 'wrote in the chat'
          : 'wrote';
  const day = dateOf(at, timeZone);
  const when =
    day === todayIn(timeZone)
      ? fmtTime(at, timeZone)
      : `${fmtMonthDay(day)} at ${fmtTime(at, timeZone)}`;
  return `${who} ${verb} at ${when}`;
}

/** A tool call's colour in the run sheet, and a word when it didn't simply run. */
export function toolCallState(
  status: TeammateToolCall['status'],
  outcome: RunOutcome | null,
): { readonly tone: 'run' | 'held' | 'bad' | 'wait' | 'ai'; readonly word: string | null } {
  switch (status) {
    case 'done':
      return { tone: 'run', word: null };
    case 'held':
      return {
        tone: 'held',
        word:
          outcome === 'drafted'
            ? 'Held in the draft'
            : outcome === 'replied'
              ? 'Done with the reply'
              : 'Not carried out',
      };
    case 'refused':
      return { tone: 'bad', word: 'Refused' };
    case 'failed':
      return { tone: 'bad', word: 'Failed' };
    case 'simulated':
      return { tone: 'ai', word: 'Simulated' };
    case 'running':
      return { tone: 'wait', word: 'Didn’t finish' };
  }
}
