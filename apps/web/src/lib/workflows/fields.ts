import {
  aiOutputKey,
  FIELD_CATALOG,
  fieldDef,
  OPERATORS_BY_TYPE,
  stepsBefore,
  triggerRecords,
  type FieldDef,
  type Operator,
  type RefKind,
  type WorkflowCatalogs,
  type WorkflowDefinition,
} from '@hfos/core';

/** Where a group of checks sits: the trigger's filters, or a step's (a branch path, a wait's event filter). */
export type ConditionPlace =
  { readonly kind: 'trigger' } | { readonly kind: 'step'; readonly stepId: string };

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

export const takesValue = (op: Operator): boolean => !NO_VALUE.has(op);
export const isListOp = (op: Operator): boolean => LIST_OPS.has(op);
export const isDurationOp = (op: Operator): boolean => DURATION_OPS.has(op);

/**
 * The fields a check can read here: the customer and their tags always; the lead, appointment or
 * conversation when the trigger (or an earlier step) brings one; what the trigger carries; an event wait's
 * timeout; and earlier AI results.
 */
export function fieldsFor(def: WorkflowDefinition, place: ConditionPlace): FieldDef[] {
  const records = triggerRecords(def) as Set<string>;
  const before = place.kind === 'step' ? stepsBefore(def, place.stepId) : [];
  let waitedForEvent = false;
  const aiKeys: string[] = [];
  for (const s of before) {
    if (s.type === 'action' && s.action === 'create_lead') records.add('lead');
    if (s.type === 'wait' && s.until.kind === 'event') {
      waitedForEvent = true;
      if (s.until.events.includes('message.received')) records.add('conversation');
    }
    if (s.type === 'ai') aiKeys.push(aiOutputKey(s));
  }
  const t = def.trigger;
  const event = t.kind === 'event' ? t.event : null;
  const out: FieldDef[] = [];
  for (const f of FIELD_CATALOG) {
    if (f.group === 'ai') continue;
    if (f.key === 'wait.timed_out') {
      if (waitedForEvent) out.push(f);
      continue;
    }
    if (f.key === 'trigger.channel') {
      if (event === 'message.received') out.push(f);
      continue;
    }
    if (f.key === 'trigger.from_stage_id' || f.key === 'trigger.to_stage_id') {
      if (event === 'lead.stage_changed') out.push(f);
      continue;
    }
    if (f.entity && f.entity !== 'person' && !records.has(f.entity)) continue;
    out.push(f);
  }
  for (const key of [...new Set(aiKeys)]) {
    const def2 = fieldDef(`ai.${key}`);
    if (def2) out.push(def2);
  }
  return out;
}

export const GROUP_LABELS: Readonly<Record<FieldDef['group'], string>> = {
  person: 'Customer',
  lead: 'Lead',
  appointment: 'Appointment',
  conversation: 'Conversation',
  tags: 'Tags',
  trigger: 'What started it',
  ai: 'AI results',
};

export interface RefOption {
  readonly value: string;
  readonly label: string;
}

/** The things a reference can point at here, with names ("Sales · Estimate sent" for stages). */
export function refOptions(kind: RefKind, c: WorkflowCatalogs): RefOption[] {
  switch (kind) {
    // Forms are picked from their own list in the step's settings, not from the workflow catalogs (M15).
    case 'form':
      return [];
    case 'user':
      return c.team.filter((p) => p.active).map((p) => ({ value: p.userId, label: p.name }));
    case 'stage':
      return c.pipelines
        .filter((p) => !p.archived)
        .flatMap((p) =>
          p.stages
            .filter((s) => !s.archived)
            .map((s) => ({ value: s.id, label: `${p.name} · ${s.name}` })),
        );
    case 'pipeline':
      return c.pipelines.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name }));
    case 'tag':
      return c.tags.map((t) => ({ value: t.id, label: t.name }));
    case 'calendar':
      return c.calendars.filter((x) => !x.archived).map((x) => ({ value: x.id, label: x.name }));
    case 'service':
      return (c.services ?? [])
        .filter((x) => !x.archived)
        .map((x) => ({ value: x.id, label: x.name }));
    case 'workflow':
      return (c.workflows ?? []).map((w) => ({ value: w.id, label: w.name }));
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * A value that fits a field and operator, so a new or changed check is valid straight away. Undefined when
 * nothing fits (a tag check in a business with no tags).
 */
export function defaultConditionValue(
  f: FieldDef,
  op: Operator,
  c: WorkflowCatalogs,
): unknown | undefined {
  if (NO_VALUE.has(op)) return null;
  if (DURATION_OPS.has(op)) return { amount: 1, unit: 'days' };
  if (op === 'before' || op === 'after') return todayIso();
  const one = (): unknown | undefined => {
    if (f.type === 'enum') return f.options?.[0]?.value;
    if (f.type === 'ref' || f.type === 'tags')
      return f.refKind ? refOptions(f.refKind, c)[0]?.value : undefined;
    if (f.type === 'number') return 0;
    return '';
  };
  const v = one();
  if (v === undefined) return undefined;
  return LIST_OPS.has(op) ? [v] : v;
}

/** The first operator of a field that works with what this business has. */
export function defaultOperator(f: FieldDef, c: WorkflowCatalogs): Operator | null {
  for (const op of OPERATORS_BY_TYPE[f.type])
    if (defaultConditionValue(f, op, c) !== undefined) return op;
  return null;
}

export const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
