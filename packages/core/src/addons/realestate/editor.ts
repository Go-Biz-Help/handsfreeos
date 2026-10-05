/**
 * The duty editor (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Duties"; Chris, 2026-09-30): what a business may
 * change about a catalog row (whether it's on, when it's due, its reminders, who answers for it, its proof, how much
 * it matters), the business's own duties written with the same rules, and the list a published version keeps.
 * Owners and admins edit (`realestate.manage`); publishing makes a new version that new deals take. Browser-safe and
 * pure: the editor screen checks with the same schemas the commands do.
 */
import { z } from 'zod';
import {
  ACCOUNTABLE_ROLES,
  AUTOMATION_LEVELS,
  DEAL_EVENTS,
  DEAL_FACTS,
  DEAL_FIELDS,
  DOCUMENT_KINDS,
  MATERIALITIES,
  PERFORMERS,
  TRACKER_CODES,
  type DealFact,
  type DutyDef,
  type ResolvedDuty,
} from './catalog/types';
import { CATALOG, catalogIssues, resolveDuty } from './catalog';
import type { DueRule } from './dates/due';
import { KEY_DATE_KEYS, KEY_DATES } from './dates/key-dates';
import { BUYER_STAGES, LISTING_EXITS, LISTING_STAGES } from './states';

const keyDate = z.enum(KEY_DATE_KEYS);
const days = z.number().int().min(-365).max(365);

const LEAF_RULES = [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('ongoing') }),
  z.object({
    kind: z.literal('after_start'),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    days: days.optional(),
    businessDays: days.optional(),
  }),
  z.object({
    kind: z.literal('relative'),
    to: keyDate,
    days: days.optional(),
    businessDays: days.optional(),
    hours: z
      .number()
      .int()
      .min(-24 * 30)
      .max(24 * 30)
      .optional(),
    at: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .optional(),
  }),
  z.object({ kind: z.literal('every'), days: z.number().int().min(1).max(365) }),
] as const;

/**
 * A due rule, as the editor writes one: a single rule, or the earliest or latest of a few (one level deep, as every
 * catalog row needs).
 */
export const DueRuleSchema = z.discriminatedUnion('kind', [
  ...LEAF_RULES,
  z.object({
    kind: z.enum(['earliest', 'latest']),
    of: z
      .array(z.discriminatedUnion('kind', [...LEAF_RULES]))
      .min(2)
      .max(4),
  }),
]) as unknown as z.ZodType<DueRule>;

const DOCUMENT_KIND_KEYS = Object.keys(DOCUMENT_KINDS) as [string, ...string[]];
const DEAL_FIELD_KEYS = Object.keys(DEAL_FIELDS) as [string, ...string[]];
const DEAL_FACT_KEYS = Object.keys(DEAL_FACTS) as [DealFact, ...DealFact[]];

/** What finishes a duty. */
export const ProofRuleSchema = z
  .object({
    mode: z.enum(['all', 'any']),
    items: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('document'),
            documents: z.array(z.enum(DOCUMENT_KIND_KEYS)).min(1).max(6),
            signed: z.boolean().optional(),
          }),
          z.object({ kind: z.literal('file') }),
          z.object({ kind: z.literal('note') }),
          z.object({
            kind: z.literal('attestation'),
            words: z.string().trim().min(3).max(200),
          }),
          z.object({ kind: z.literal('appointment') }),
          z.object({ kind: z.literal('message') }),
          z.object({ kind: z.literal('dates'), keys: z.array(keyDate).min(1).max(6) }),
          z.object({ kind: z.literal('deal_field'), field: z.enum(DEAL_FIELD_KEYS) }),
        ]),
      )
      .min(1)
      .max(6),
  })
  .nullable();

const STAGES = [...new Set([...BUYER_STAGES, ...LISTING_STAGES, ...LISTING_EXITS])] as [
  string,
  ...string[],
];
const TriggerSchema = z.discriminatedUnion('on', [
  z.object({ on: z.literal('stage'), stage: z.enum(STAGES) }),
  z.object({ on: z.literal('dates'), key: keyDate }),
  z.object({ on: z.literal('event'), event: z.enum(DEAL_EVENTS) }),
]);

const reminders = z.array(z.number().int().min(1).max(30)).max(4);

/** What a business changes about a catalog row: only what differs. */
export const OverridePatchSchema = z
  .object({
    due: DueRuleSchema,
    reminders,
    accountable: z.enum(ACCOUNTABLE_ROLES),
    proof: ProofRuleSchema,
    materiality: z.enum(MATERIALITIES),
  })
  .partial();
export type OverridePatch = z.infer<typeof OverridePatchSchema>;

/** A duty of the business's own, written with the catalog's rules. */
export const CustomDutySchema = z.object({
  side: z.enum(['buyer', 'listing', 'both']),
  title: z.string().trim().min(1, 'Name the duty.').max(80, 'Keep it under 80 characters.'),
  behavior: z.string().trim().max(1000).default(''),
  tracker: z.enum(TRACKER_CODES),
  trigger: TriggerSchema,
  when: z.array(z.enum(DEAL_FACT_KEYS)).max(5).optional(),
  due: DueRuleSchema,
  proof: ProofRuleSchema,
  accountable: z.enum(ACCOUNTABLE_ROLES),
  performedBy: z.array(z.enum(PERFORMERS)).max(5).default([]),
  // Deny wins: a business can't make its own duty more automatic than "after approval".
  automation: z.enum(AUTOMATION_LEVELS).refine((a) => a !== 'A4', {
    error:
      'HandsFreeOS doesn’t do a business’s own duties on its own. Pick after approval or less.',
  }),
  materiality: z.enum(MATERIALITIES),
  reminders: reminders.default([3, 1]),
});
export type CustomDuty = z.infer<typeof CustomDutySchema>;

/** A catalog row with the business's changes. */
export function withOverride(
  def: ResolvedDuty,
  patch: OverridePatch | null | undefined,
): ResolvedDuty {
  if (!patch) return def;
  return {
    ...def,
    ...(patch.due ? { due: patch.due } : {}),
    ...(patch.reminders ? { reminders: patch.reminders } : {}),
    ...(patch.accountable ? { accountable: patch.accountable } : {}),
    ...(patch.proof !== undefined ? { proof: patch.proof as ResolvedDuty['proof'] } : {}),
    ...(patch.materiality ? { materiality: patch.materiality } : {}),
  };
}

/** A business's own duty as a list item. */
export function customDuty(key: string, c: CustomDuty): ResolvedDuty {
  return {
    id: key as ResolvedDuty['id'],
    side: c.side,
    title: c.title,
    phase: 'The business’s own',
    behavior: c.behavior ?? '',
    spec: { owner: '', mode: '', share: '' },
    tracker: c.tracker,
    trigger: c.trigger as ResolvedDuty['trigger'],
    ...(c.when?.length ? { when: c.when } : {}),
    due: c.due,
    proof: c.proof as ResolvedDuty['proof'],
    accountable: c.accountable,
    performedBy: c.performedBy ?? [],
    automation: c.automation,
    materiality: c.materiality,
    reminders: c.reminders ?? [3, 1],
  };
}

/** One item of a list, as a version keeps it. */
export interface ListItem {
  readonly key: string;
  readonly enabled: boolean;
  readonly definition: ResolvedDuty;
}

/** The whole list from the business's changes: the catalog's rows in order, then its own duties. */
export function buildList(
  overrides: ReadonlyMap<string, { readonly enabled: boolean; readonly patch: OverridePatch }>,
  customs: readonly { readonly key: string; readonly duty: CustomDuty }[],
): ListItem[] {
  return [
    ...CATALOG.filter((d) => d.perDeal !== false).map((d) => {
      const o = overrides.get(d.id);
      return {
        key: d.id,
        enabled: o?.enabled ?? true,
        definition: withOverride(resolveDuty(d), o?.patch),
      };
    }),
    ...customs.map((c) => ({ key: c.key, enabled: true, definition: customDuty(c.key, c.duty) })),
  ];
}

/** Everything wrong with a list: the catalog's own checks, run on every item. */
export function listIssues(items: readonly ListItem[]): string[] {
  const issues = catalogIssues(items.map((i) => i.definition as unknown as DutyDef));
  for (const i of items)
    for (const k of dueKeys(i.definition.due))
      if (!(k in KEY_DATES)) issues.push(`${i.key} is due from ${k}, which isn't a date`);
  return issues;
}

function dueKeys(rule: DueRule): string[] {
  if (rule.kind === 'relative') return [rule.to];
  if (rule.kind === 'earliest' || rule.kind === 'latest') return rule.of.flatMap(dueKeys);
  return [];
}

/** A value as text with its keys in order, so two copies compare the same however they were stored. */
export function stableText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableText).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableText((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** How two versions of an item differ, in words for the editor and the "apply to this deal" preview. */
export function itemChanges(before: ResolvedDuty, after: ResolvedDuty): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => stableText(a) === stableText(b);
  if (!same(before.due, after.due)) out.push('when it’s due');
  if (!same(before.reminders, after.reminders)) out.push('its reminders');
  if (before.accountable !== after.accountable) out.push('who answers for it');
  if (!same(before.proof, after.proof)) out.push('what finishes it');
  if (before.materiality !== after.materiality) out.push('how much it matters');
  if (before.title !== after.title) out.push('its name');
  if (!same(before.trigger, after.trigger) || !same(before.when, after.when))
    out.push('what brings it');
  return out;
}
