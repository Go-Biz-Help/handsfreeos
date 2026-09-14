/**
 * Message templates: `{{person.first_name | default:"there"}}`, `{{appointment.starts_at | time}}`,
 * `{{links.booking}}`, `{{ai.message}}`. Variables and filters only, no logic. A variable with no value and
 * no default is reported as missing, and the engine skips the step as `missing_variable`. Browser-safe.
 */

export const TEMPLATE_FILTERS = ['default', 'time', 'date', 'first', 'upper', 'lower'] as const;
export type TemplateFilterName = (typeof TEMPLATE_FILTERS)[number];

export interface TemplateFilter {
  readonly name: string;
  readonly arg: string | null;
}

export interface TemplateVar {
  /** The text between the braces, trimmed. */
  readonly raw: string;
  readonly path: string;
  readonly filters: readonly TemplateFilter[];
  readonly hasDefault: boolean;
  /** False when the path is malformed or a filter is unknown. */
  readonly valid: boolean;
}

const TAG_RE = /\{\{([^{}]*)\}\}/g;
const PATH_RE = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const FILTER_RE = /^([a-z_]+)(?:\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'))?$/;

/** Splits on `|` outside quotes. */
function splitPipes(inner: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === '\\' && i + 1 < inner.length) {
        current += ch + inner[++i];
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '|') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

export function parseTag(inner: string): TemplateVar {
  const [path = '', ...rest] = splitPipes(inner.trim());
  let valid = PATH_RE.test(path);
  const filters: TemplateFilter[] = rest.map((part) => {
    const m = FILTER_RE.exec(part);
    if (!m || !(TEMPLATE_FILTERS as readonly string[]).includes(m[1]!)) {
      valid = false;
      return { name: m?.[1] ?? part, arg: null };
    }
    const arg = m[2] ?? m[3];
    return { name: m[1]!, arg: arg === undefined ? null : arg.replace(/\\(.)/g, '$1') };
  });
  return {
    raw: inner.trim(),
    path,
    filters,
    hasDefault: filters.some((x) => x.name === 'default'),
    valid,
  };
}

/** Every variable in a template, in order, once per distinct tag. */
export function templateVars(template: string): TemplateVar[] {
  const seen = new Set<string>();
  const out: TemplateVar[] = [];
  for (const m of template.matchAll(TAG_RE)) {
    const v = parseTag(m[1]!);
    if (seen.has(v.raw)) continue;
    seen.add(v.raw);
    out.push(v);
  }
  return out;
}

/** Removes every tag for one variable (the "Remove {{x}}" fix), tidying doubled spaces. */
export function removeTemplateVar(template: string, path: string): string {
  return template
    .replace(TAG_RE, (whole, inner: string) => (parseTag(inner).path === path ? '' : whole))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1');
}

export type TemplateValues = Readonly<Record<string, unknown>> | ((path: string) => unknown);

export interface RenderOptions {
  /** Where `time` and `date` are shown. */
  readonly timeZone?: string;
}

export interface RenderResult {
  readonly text: string;
  /** Paths with no value and no default; the text shows them as nothing. */
  readonly missing: string[];
}

function lookup(values: TemplateValues, path: string): unknown {
  if (typeof values === 'function') return values(path);
  if (Object.prototype.hasOwnProperty.call(values, path)) return values[path];
  let at: unknown = values;
  for (const key of path.split('.')) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

const blank = (v: unknown) => v === null || v === undefined || v === '';

function instant(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function applyFilter(value: unknown, filter: TemplateFilter, timeZone: string): unknown {
  switch (filter.name) {
    case 'default':
      return blank(value) ? (filter.arg ?? '') : value;
    case 'upper':
      return blank(value) ? value : String(value).toUpperCase();
    case 'lower':
      return blank(value) ? value : String(value).toLowerCase();
    case 'first':
      if (Array.isArray(value)) return value[0];
      return blank(value) ? value : (String(value).trim().split(/\s+/)[0] ?? '');
    case 'time':
    case 'date': {
      const d = instant(value);
      if (!d) return value;
      return new Intl.DateTimeFormat(
        'en-US',
        filter.name === 'time'
          ? { timeZone, hour: 'numeric', minute: '2-digit' }
          : { timeZone, weekday: 'short', month: 'short', day: 'numeric' },
      ).format(d);
    }
    default:
      return value;
  }
}

function show(value: unknown): string {
  if (blank(value)) return '';
  if (Array.isArray(value)) return value.map(show).join(', ');
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Fills a template. Filters run left to right; a default fills a blank value. */
export function render(
  template: string,
  values: TemplateValues,
  options: RenderOptions = {},
): RenderResult {
  const timeZone = options.timeZone ?? 'UTC';
  const missing: string[] = [];
  const text = template.replace(TAG_RE, (_whole, inner: string) => {
    const v = parseTag(inner);
    let value = lookup(values, v.path);
    for (const filter of v.filters) value = applyFilter(value, filter, timeZone);
    if (blank(value) && !v.hasDefault && !missing.includes(v.path)) missing.push(v.path);
    return show(value);
  });
  return { text, missing };
}

// ---- The variables a workflow can use ----

export type VariableSource =
  'person' | 'lead' | 'appointment' | 'conversation' | 'business' | 'links' | 'workflow' | 'ai';

export interface TemplateVariable {
  readonly path: string;
  readonly label: string;
  readonly source: VariableSource;
  /** Shown in the picker and used by previews when no test contact is chosen. */
  readonly example: string;
}

const v = (path: string, label: string, source: VariableSource, example: string) => ({
  path,
  label,
  source,
  example,
});

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  v('person.first_name', 'First name', 'person', 'Maria'),
  v('person.last_name', 'Last name', 'person', 'Lopez'),
  v('person.name', 'Full name', 'person', 'Maria Lopez'),
  v('person.email', 'Email', 'person', 'maria@example.com'),
  v('person.phone', 'Phone', 'person', '(214) 555-0142'),
  v('person.city', 'City', 'person', 'Dallas'),
  v('lead.title', 'Lead title', 'lead', 'AC replacement'),
  v('lead.value', 'Lead value', 'lead', '$6,500'),
  v('lead.stage', 'Lead stage', 'lead', 'Estimate sent'),
  v('lead.pipeline', 'Pipeline', 'lead', 'Sales'),
  v('lead.assignee_name', 'Lead assignee', 'lead', 'Dale'),
  v('lead.next_action', 'Next action', 'lead', 'Call back'),
  v('appointment.title', 'Appointment', 'appointment', 'AC tune-up'),
  v('appointment.starts_at', 'Appointment start', 'appointment', '2026-09-15T14:00:00Z'),
  v('appointment.ends_at', 'Appointment end', 'appointment', '2026-09-15T15:00:00Z'),
  v('appointment.calendar', 'Calendar', 'appointment', 'Service calls'),
  v('appointment.service', 'Service', 'appointment', 'AC tune-up'),
  v('appointment.location', 'Location', 'appointment', '120 Elm St'),
  v('appointment.staff_names', 'Who’s coming', 'appointment', 'Dale'),
  v('conversation.channel', 'Channel', 'conversation', 'text'),
  v('conversation.last_message', 'Their latest message', 'conversation', 'Can you come Tuesday?'),
  v('business.name', 'Business name', 'business', 'Lone Star HVAC'),
  v('business.phone', 'Business phone', 'business', '(214) 555-0100'),
  v('business.email', 'Business email', 'business', 'hello@lonestarhvac.com'),
  v('business.website', 'Website', 'business', 'lonestarhvac.com'),
  v('links.booking', 'Booking link', 'links', 'https://book.example.com/lone-star'),
  v('links.review', 'Review link', 'links', 'https://g.page/r/lone-star/review'),
  v('workflow.name', 'Workflow name', 'workflow', 'Speed to lead'),
];
