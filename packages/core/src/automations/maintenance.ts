/**
 * "Maintenance due": the text a customer gets when their recurring service comes round again, and how often
 * that is. Browser-safe, so Settings shows the same preview and verdict the worker sends with.
 *
 * How often, the most particular first: the customer's own schedule (every N months, or never), then the
 * maintenance plan they're on when it covers the service, then the service's own "repeats every". None of
 * them: no reminder.
 *
 * The wording may fill in {firstName}, {businessName}, {service} and {link}, and a plan member's {plan}. It must
 * have {link}: the whole point is that they can book in one tap.
 */
import { plainSmsText } from '../ai-team/guardrails';

export const MAINTENANCE_PLACEHOLDERS = [
  'firstName',
  'businessName',
  'service',
  'link',
  'plan',
] as const;
export type MaintenancePlaceholder = (typeof MAINTENANCE_PLACEHOLDERS)[number];

/** Straight apostrophes: a curly one sends a text in the slower encoding. */
export const DEFAULT_MAINTENANCE_TEMPLATE =
  "Hi {firstName}, it's {businessName}. Your {service} is due soon. Book a time that suits you here: {link}";
export const DEFAULT_MAINTENANCE_PLAN_TEMPLATE =
  "Hi {firstName}, it's {businessName}. Your {service} is due soon, and it's included in your {plan}. Book a time here: {link}";

const TOKEN_RE = /\{\{[^{}]*\}\}|\{[^{}]*\}/g;

/** What's wrong with the wording, in plain words, or null. `plan` allows {plan}. */
export function maintenanceTemplateProblem(
  template: string,
  opts: { readonly plan: boolean },
): string | null {
  const allowed = MAINTENANCE_PLACEHOLDERS.filter((p) => opts.plan || p !== 'plan');
  for (const m of template.matchAll(TOKEN_RE)) {
    const name = m[0].replace(/[{}]/g, '').trim();
    if (m[0].startsWith('{{') || !(allowed as readonly string[]).includes(name))
      return `${m[0]} can't be filled in. Use ${allowed.map((p) => `{${p}}`).join(', ')}.`;
  }
  if (!/\{\s*link\s*\}/.test(template)) return 'Put {link} where the booking link goes.';
  return null;
}

export interface MaintenanceValues {
  readonly firstName: string | null;
  readonly businessName: string;
  readonly service: string;
  readonly link: string;
  readonly plan?: string | null;
}

/** Fills the wording: a blank first name reads "there", a blank plan "your plan". */
export function renderMaintenance(template: string, v: MaintenanceValues): string {
  const text = template.replace(TOKEN_RE, (whole) => {
    const name = whole.slice(1, -1).trim();
    if (whole.startsWith('{{')) return whole;
    switch (name) {
      case 'firstName':
        return v.firstName?.trim() || 'there';
      case 'businessName':
        return v.businessName;
      case 'service':
        return v.service;
      case 'link':
        return v.link;
      case 'plan':
        return v.plan?.trim() || 'plan';
      default:
        return whole;
    }
  });
  return plainSmsText(text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .trim();
}

/** Where a customer's schedule for a service comes from. */
export type MaintenanceSource = 'customer' | 'plan' | 'service';

export interface MaintenanceSchedule {
  /** Every this many months, or null: they aren't reminded. */
  readonly everyMonths: number | null;
  readonly source: MaintenanceSource | null;
}

/**
 * How often one customer is due for one service. A customer's own schedule wins, even "never"; then a plan
 * covering the service; then the service's own.
 */
export function maintenanceScheduleOf(o: {
  /** undefined: no schedule of their own; null: never remind them. */
  readonly customer?: number | null;
  readonly plan?: number | null;
  readonly service?: number | null;
}): MaintenanceSchedule {
  if (o.customer !== undefined) return { everyMonths: o.customer, source: 'customer' };
  if (o.plan) return { everyMonths: o.plan, source: 'plan' };
  if (o.service) return { everyMonths: o.service, source: 'service' };
  return { everyMonths: null, source: null };
}

/** "every 6 months", "every year", "every 18 months". */
export function everyMonthsWords(n: number): string {
  if (n === 1) return 'every month';
  if (n === 12) return 'every year';
  if (n % 12 === 0) return `every ${n / 12} years`;
  return `every ${n} months`;
}

/** The day a visit on `lastOn` (YYYY-MM-DD) is due again, `months` later; the 31st lands on the month's last day. */
export function maintenanceDueOn(lastOn: string, months: number): string {
  const [y, m, d] = lastOn.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
