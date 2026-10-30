/**
 * Conditions: `{field, op, value}` checks in `all` / `any` groups, at most 3 deep, over a typed field
 * catalog. The engine evaluates them by re-reading records (event payloads are too thin), through a lazy
 * facts lookup so only the fields a group needs are read. Browser-safe.
 */
import { z } from 'zod';
import { isLocalDate, startOfLocalDay } from '../calendar/engine/zoned';
import { isPlaceholder, Ref, type RefKind } from './ids';

// ---- Durations (shared with waits, date triggers and the settings) ----

export const DURATION_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
const UNIT_MINUTES: Readonly<Record<DurationUnit, number>> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
};

export const Duration = z.object({
  amount: z.int().min(1).max(1000),
  unit: z.enum(DURATION_UNITS),
});
export type Duration = z.infer<typeof Duration>;

export function durationMinutes(d: Duration): number {
  return d.amount * UNIT_MINUTES[d.unit];
}

/** `{amount: 1, unit: 'days'}` → "1 day". */
export function durationText(d: Duration): string {
  const one = d.unit.slice(0, -1);
  return `${d.amount} ${d.amount === 1 ? one : d.unit}`;
}

// ---- The field catalog ----

export const FIELD_TYPES = ['text', 'number', 'boolean', 'enum', 'ref', 'tags', 'date'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_GROUPS = [
  'person',
  'lead',
  'appointment',
  'conversation',
  'tags',
  'trigger',
  'ai',
] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

/** The record a field is read from; null when it comes with the trigger or the run itself. */
export type FieldEntity = 'person' | 'lead' | 'appointment' | 'conversation' | null;

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly group: FieldGroup;
  readonly type: FieldType;
  readonly entity: FieldEntity;
  /** Choices for enum fields. */
  readonly options?: readonly FieldOption[];
  /** What ref and tags fields point at. */
  readonly refKind?: RefKind;
}

const opts = (...pairs: [string, string][]): FieldOption[] =>
  pairs.map(([value, label]) => ({ value, label }));

const f = (
  key: string,
  label: string,
  group: FieldGroup,
  type: FieldType,
  entity: FieldEntity,
  extra: Partial<Pick<FieldDef, 'options' | 'refKind'>> = {},
): FieldDef => ({ key, label, group, type, entity, ...extra });

export const FIELD_CATALOG: readonly FieldDef[] = [
  f('person.first_name', 'First name', 'person', 'text', 'person'),
  f('person.last_name', 'Last name', 'person', 'text', 'person'),
  f('person.email', 'Email', 'person', 'text', 'person'),
  f('person.phone', 'Phone', 'person', 'text', 'person'),
  f('person.city', 'City', 'person', 'text', 'person'),
  f('person.source', 'Source', 'person', 'text', 'person'),
  f('person.owner_user_id', 'Owner', 'person', 'ref', 'person', { refKind: 'user' }),
  f('person.sms_consent', 'Text consent', 'person', 'enum', 'person', {
    options: opts(['unknown', 'Not asked'], ['opted_in', 'Opted in'], ['opted_out', 'Opted out']),
  }),
  f('person.created_at', 'Added', 'person', 'date', 'person'),

  f('lead.title', 'Lead title', 'lead', 'text', 'lead'),
  f('lead.value', 'Lead value ($)', 'lead', 'number', 'lead'),
  f('lead.status', 'Lead status', 'lead', 'enum', 'lead', {
    options: opts(['open', 'Open'], ['won', 'Won'], ['lost', 'Lost']),
  }),
  f('lead.pipeline_id', 'Pipeline', 'lead', 'ref', 'lead', { refKind: 'pipeline' }),
  f('lead.stage_id', 'Stage', 'lead', 'ref', 'lead', { refKind: 'stage' }),
  f('lead.assignee_user_id', 'Lead assignee', 'lead', 'ref', 'lead', { refKind: 'user' }),
  f('lead.source', 'Lead source', 'lead', 'text', 'lead'),
  f('lead.next_action', 'Next action', 'lead', 'text', 'lead'),
  f('lead.created_at', 'Lead created', 'lead', 'date', 'lead'),
  f('lead.stage_entered_at', 'In this stage since', 'lead', 'date', 'lead'),

  f('appointment.status', 'Appointment status', 'appointment', 'enum', 'appointment', {
    options: opts(
      ['scheduled', 'Scheduled'],
      ['completed', 'Completed'],
      ['cancelled', 'Cancelled'],
      ['no_show', 'No-show'],
    ),
  }),
  f('appointment.calendar_id', 'Calendar', 'appointment', 'ref', 'appointment', {
    refKind: 'calendar',
  }),
  f('appointment.service_id', 'Service', 'appointment', 'ref', 'appointment', {
    refKind: 'service',
  }),
  f('appointment.source', 'Booked by', 'appointment', 'enum', 'appointment', {
    options: opts(
      ['staff', 'Staff'],
      ['assistant', 'Assistant'],
      ['booking_page', 'Booking page'],
      ['series', 'Repeat series'],
      ['ai_teammate', 'AI teammate'],
    ),
  }),
  f('appointment.starts_at', 'Appointment start', 'appointment', 'date', 'appointment'),
  f('appointment.ends_at', 'Appointment end', 'appointment', 'date', 'appointment'),

  f('conversation.channel', 'Channel', 'conversation', 'enum', 'conversation', {
    options: opts(
      ['sms', 'Text'],
      ['email', 'Email'],
      ['chat', 'Website chat'],
      ['portal', 'Client portal'],
    ),
  }),
  f('conversation.status', 'Conversation status', 'conversation', 'enum', 'conversation', {
    options: opts(['open', 'Open'], ['snoozed', 'Snoozed'], ['closed', 'Closed']),
  }),
  f(
    'conversation.assignee_user_id',
    'Conversation assignee',
    'conversation',
    'ref',
    'conversation',
    {
      refKind: 'user',
    },
  ),
  f(
    'conversation.awaiting_reply',
    'Waiting on our reply',
    'conversation',
    'boolean',
    'conversation',
  ),

  f('person.tags', 'Customer tags', 'tags', 'tags', 'person', { refKind: 'tag' }),
  f('lead.tags', 'Lead tags', 'tags', 'tags', 'lead', { refKind: 'tag' }),

  f('trigger.channel', 'Came in by', 'trigger', 'enum', null, {
    options: opts(
      ['sms', 'Text'],
      ['email', 'Email'],
      ['chat', 'Website chat'],
      ['portal', 'Client portal'],
    ),
  }),
  // RCS (0103): the button a customer's message came from — tapped, or texted back by number — by its words.
  f('trigger.button', 'Button they chose', 'trigger', 'text', null),
  f('trigger.from_stage_id', 'Moved from stage', 'trigger', 'ref', null, { refKind: 'stage' }),
  f('trigger.to_stage_id', 'Moved to stage', 'trigger', 'ref', null, { refKind: 'stage' }),
  // A form's events (funnels): which form, and the page somebody stopped on.
  f('trigger.form_id', 'Which form', 'trigger', 'ref', null, { refKind: 'form' }),
  f('trigger.page_title', 'Page they stopped on', 'trigger', 'text', null),
  // A webinar's rating (part 5): Hot, Warm or Cold, and the points it came from.
  f('trigger.label', 'Rated', 'trigger', 'enum', null, {
    options: opts(['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold']),
  }),
  f('trigger.points', 'Webinar points', 'trigger', 'number', null),
  f('wait.timed_out', 'The last wait for an event timed out', 'trigger', 'boolean', null),
  f('wait.button', 'Button they chose in their reply', 'trigger', 'text', null),

  f('ai.category', 'AI category', 'ai', 'text', null),
  f('ai.message', 'AI message', 'ai', 'text', null),
  f('ai.summary', 'AI summary', 'ai', 'text', null),
];

const FIELD_BY_KEY = new Map(FIELD_CATALOG.map((d) => [d.key, d]));
const AI_KEY_RE = /^ai\.[a-z][a-z0-9_]{0,39}$/;

/** A field's definition; any `ai.<outputKey>` is a text field written by an AI step. */
export function fieldDef(key: string): FieldDef | undefined {
  const known = FIELD_BY_KEY.get(key);
  if (known) return known;
  if (AI_KEY_RE.test(key)) return f(key, `AI: ${key.slice(3)}`, 'ai', 'text', null);
  return undefined;
}

// ---- Operators ----

export const OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'includes',
  'excludes',
  'is_true',
  'is_false',
  'before',
  'after',
  'within_last',
  'within_next',
  'more_than_ago',
  'is_empty',
  'is_not_empty',
] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPERATORS_BY_TYPE: Readonly<Record<FieldType, readonly Operator[]>> = {
  text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  ref: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  tags: ['includes', 'excludes', 'is_empty', 'is_not_empty'],
  date: [
    'before',
    'after',
    'within_last',
    'within_next',
    'more_than_ago',
    'is_empty',
    'is_not_empty',
  ],
};

export const OPERATOR_LABELS: Readonly<Record<Operator, string>> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'doesn’t contain',
  starts_with: 'starts with',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  not_in: 'is none of',
  includes: 'has',
  excludes: 'doesn’t have',
  is_true: 'is yes',
  is_false: 'is no',
  before: 'is before',
  after: 'is after',
  within_last: 'is within the last',
  within_next: 'is within the next',
  more_than_ago: 'is more than … ago',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

const NO_VALUE: ReadonlySet<Operator> = new Set([
  'is_true',
  'is_false',
  'is_empty',
  'is_not_empty',
]);
const LIST_OPS: ReadonlySet<Operator> = new Set(['in', 'not_in']);
const DURATION_OPS: ReadonlySet<Operator> = new Set([
  'within_last',
  'within_next',
  'more_than_ago',
]);

/** Why a value doesn't fit a field and operator, or null when it does. */
export function conditionValueProblem(def: FieldDef, op: Operator, value: unknown): string | null {
  if (!OPERATORS_BY_TYPE[def.type].includes(op))
    return `“${OPERATOR_LABELS[op]}” doesn’t work with ${def.label}.`;
  if (NO_VALUE.has(op))
    return value === null || value === undefined ? null : 'This check takes no value.';
  const one = (v: unknown): string | null => {
    if (def.type === 'enum')
      return typeof v === 'string' && (def.options ?? []).some((o) => o.value === v)
        ? null
        : 'Pick one of the choices.';
    if (def.type === 'ref' || def.type === 'tags')
      return Ref.safeParse(v).success ? null : 'Pick one from the list.';
    if (def.type === 'number')
      return typeof v === 'number' && Number.isFinite(v) ? null : 'Enter a number.';
    return typeof v === 'string' && v.length <= 500 ? null : 'Enter some text.';
  };
  if (LIST_OPS.has(op)) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50)
      return 'Pick at least one.';
    return value.map(one).find((p) => p !== null) ?? null;
  }
  if (DURATION_OPS.has(op))
    return Duration.safeParse(value).success ? null : 'Enter a length of time.';
  if (op === 'before' || op === 'after')
    return typeof value === 'string' && (isLocalDate(value) || !Number.isNaN(Date.parse(value)))
      ? null
      : 'Enter a date.';
  return one(value);
}

export const Condition = z
  .object({
    field: z.string().min(1).max(80),
    op: z.enum(OPERATORS),
    value: z.unknown().default(null),
  })
  .superRefine((c, ctx) => {
    const def = fieldDef(c.field);
    if (!def) {
      ctx.addIssue({ code: 'custom', message: 'Unknown field.', path: ['field'] });
      return;
    }
    const problem = conditionValueProblem(def, c.op, c.value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['value'] });
  });
export type Condition = z.infer<typeof Condition>;

const Match = z.enum(['all', 'any']);
const LIMIT = 20;
const Group3 = z.object({ match: Match.default('all'), conditions: z.array(Condition).max(LIMIT) });
const Group2 = z.object({
  match: Match.default('all'),
  conditions: z.array(z.union([Condition, Group3])).max(LIMIT),
});

/** A group of checks: all of them, or any one. Groups nest at most 3 deep (enforced by the shape). */
export const ConditionGroup = z.object({
  match: Match.default('all'),
  conditions: z
    .array(z.union([Condition, Group2]))
    .max(LIMIT)
    .default(() => []),
});
export type ConditionGroup = z.infer<typeof ConditionGroup>;

/** Any group at any depth, for code that walks them. */
export interface AnyConditionGroup {
  readonly match: 'all' | 'any';
  readonly conditions: readonly (Condition | AnyConditionGroup)[];
}

export function emptyGroup(): ConditionGroup {
  return { match: 'all', conditions: [] };
}

export function isConditionGroup(x: Condition | AnyConditionGroup): x is AnyConditionGroup {
  return 'conditions' in x;
}

/** Every condition in a group, depth first. */
export function allConditions(group: AnyConditionGroup): Condition[] {
  return group.conditions.flatMap((c) => (isConditionGroup(c) ? allConditions(c) : [c]));
}

/** The fields a group reads, so the engine loads only the records it needs. */
export function conditionFields(group: AnyConditionGroup): string[] {
  return [...new Set(allConditions(group).map((c) => c.field))];
}

/** A copy with each condition replaced (null removes it); nested groups left empty are dropped. */
export function mapConditions<G extends AnyConditionGroup>(
  group: G,
  fn: (c: Condition) => Condition | null,
): G {
  const walk = (g: AnyConditionGroup, top: boolean): AnyConditionGroup | null => {
    const conditions: (Condition | AnyConditionGroup)[] = [];
    for (const c of g.conditions) {
      const next = isConditionGroup(c) ? walk(c, false) : fn(c);
      if (next) conditions.push(next);
    }
    return conditions.length || top ? { match: g.match, conditions } : null;
  };
  return walk(group, true) as G;
}

// ---- Evaluation ----

/** Field values: a record, or a function the engine answers lazily (called once per field at most). */
export type Facts = Readonly<Record<string, unknown>> | ((field: string) => unknown);

export interface EvaluateOptions {
  /** For relative dates ("within the last 2 days"). */
  readonly now?: number;
  /** For local dates in before/after checks. */
  readonly timeZone?: string;
}

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim().toLowerCase();
const same = (a: unknown, b: unknown) => !isPlaceholder(b) && !isEmpty(a) && text(a) === text(b);

function epoch(v: unknown, timeZone: string): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v) return null;
  if (isLocalDate(v)) return startOfLocalDay(v, timeZone);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function check(c: Condition, raw: unknown, o: Required<EvaluateOptions>): boolean {
  const value = c.value;
  switch (c.op) {
    case 'is_empty':
      return isEmpty(raw);
    case 'is_not_empty':
      return !isEmpty(raw);
    case 'is_true':
      return raw === true;
    case 'is_false':
      return raw !== true;
    case 'eq':
      return typeof value === 'number' ? Number(raw) === value && !isEmpty(raw) : same(raw, value);
    case 'neq':
      return !(typeof value === 'number'
        ? Number(raw) === value && !isEmpty(raw)
        : same(raw, value));
    case 'contains':
      return !isEmpty(raw) && text(raw).includes(text(value));
    case 'not_contains':
      return !(!isEmpty(raw) && text(raw).includes(text(value)));
    case 'starts_with':
      return !isEmpty(raw) && text(raw).startsWith(text(value));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (isEmpty(raw)) return false;
      const n = Number(raw);
      const v = Number(value);
      if (!Number.isFinite(n)) return false;
      return c.op === 'gt' ? n > v : c.op === 'gte' ? n >= v : c.op === 'lt' ? n < v : n <= v;
    }
    case 'in':
      return Array.isArray(value) && value.some((v) => same(raw, v));
    case 'not_in':
      return !(Array.isArray(value) && value.some((v) => same(raw, v)));
    case 'includes':
      return Array.isArray(raw) && raw.some((r) => same(r, value));
    case 'excludes':
      return !(Array.isArray(raw) && raw.some((r) => same(r, value)));
    case 'before':
    case 'after': {
      const t = epoch(raw, o.timeZone);
      const bound = epoch(value, o.timeZone);
      if (t === null || bound === null) return false;
      return c.op === 'before' ? t < bound : t > bound;
    }
    case 'within_last':
    case 'within_next':
    case 'more_than_ago': {
      const t = epoch(raw, o.timeZone);
      const parsed = Duration.safeParse(value);
      if (t === null || !parsed.success) return false;
      const span = durationMinutes(parsed.data) * 60_000;
      if (c.op === 'within_last') return t <= o.now && t >= o.now - span;
      if (c.op === 'within_next') return t >= o.now && t <= o.now + span;
      return t < o.now - span;
    }
  }
}

/** Whether the facts pass the group. An empty group passes. Lookups short-circuit and are cached. */
export function evaluate(
  group: AnyConditionGroup,
  facts: Facts,
  options: EvaluateOptions = {},
): boolean {
  const o: Required<EvaluateOptions> = {
    now: options.now ?? Date.now(),
    timeZone: options.timeZone ?? 'UTC',
  };
  const cache = new Map<string, unknown>();
  const read = (field: string): unknown => {
    if (!cache.has(field))
      cache.set(field, typeof facts === 'function' ? facts(field) : facts[field]);
    return cache.get(field);
  };
  const run = (g: AnyConditionGroup): boolean => {
    if (!g.conditions.length) return true;
    const test = (c: Condition | AnyConditionGroup) =>
      isConditionGroup(c) ? run(c) : check(c, read(c.field), o);
    return g.match === 'all' ? g.conditions.every(test) : g.conditions.some(test);
  };
  return run(group);
}
