/**
 * Every place a workflow names a workspace id (a stage, tag, calendar, person, workflow…) or a placeholder
 * for one: step configs, approvers, and ref-typed conditions in filters, audiences, branches and waits.
 * One walker serves the validator (ids that are gone), placeholders (extract and resolve) and their fixes.
 */
import { fieldDef, mapConditions, type AnyConditionGroup } from './conditions';
import type { Step, WorkflowDefinition } from './definition';
import type { Ref, RefKind } from './ids';
import { cloneJson } from './json';

export interface RefSite {
  readonly kind: RefKind;
  readonly value: Ref;
  /** null for the trigger. */
  readonly stepId: string | null;
  /** Which field: 'config.stageId', 'approvers', 'trigger.filters', 'branch:b_x', 'until.filter'… */
  readonly where: string;
}

/**
 * Returned by a mapper to drop a reference: a list entry goes, a condition goes, an optional id becomes
 * null, an assignment goes to nobody, an empty notify or approver list goes to owners and admins, and a
 * step that can't work without the id is deleted.
 */
export const REMOVE_REF = Symbol('remove_ref');
export type RefMapper = (site: RefSite) => Ref | typeof REMOVE_REF | undefined;

type Mutable = Record<string, unknown>;

function mapGroup(
  group: AnyConditionGroup,
  stepId: string | null,
  where: string,
  fn: RefMapper,
): AnyConditionGroup {
  return mapConditions(group, (c) => {
    const kind = fieldDef(c.field)?.refKind;
    if (!kind || c.value === null || c.value === undefined) return c;
    const one = (value: unknown) => fn({ kind, value: value as Ref, stepId, where });
    if (Array.isArray(c.value)) {
      const values: unknown[] = [];
      for (const v of c.value) {
        const next = one(v);
        if (next !== REMOVE_REF) values.push(next ?? v);
      }
      return values.length ? { ...c, value: values } : null;
    }
    const next = one(c.value);
    if (next === REMOVE_REF) return null;
    return next === undefined ? c : { ...c, value: next };
  });
}

/** Maps one step; null means the step can't stay. */
function mapStep(step: Step, fn: RefMapper): Step | null {
  const s = cloneJson(step);
  const at = (kind: RefKind, value: unknown, where: string) =>
    fn({ kind, value: value as Ref, stepId: step.id, where });
  /** A required id: replaced, or the step goes. */
  const required = (obj: Mutable, key: string, kind: RefKind): boolean => {
    const next = at(kind, obj[key], `config.${key}`);
    if (next === REMOVE_REF) return false;
    if (next !== undefined) obj[key] = next;
    return true;
  };
  const assign = (obj: Mutable, key = 'assignTo') => {
    const a = obj[key] as Mutable;
    if (a.kind !== 'user') return;
    const next = at('user', a.userId, `config.${key}`);
    if (next === REMOVE_REF) obj[key] = { kind: 'nobody' };
    else if (next !== undefined) a.userId = next;
  };
  const people = (list: unknown[], where: string): unknown[] => {
    const out: unknown[] = [];
    for (const u of list) {
      const next = at('user', u, where);
      if (next !== REMOVE_REF) out.push(next ?? u);
    }
    return out;
  };

  switch (s.type) {
    case 'action': {
      const c = s.config as unknown as Mutable;
      switch (s.action) {
        case 'create_lead':
          assign(c);
          return required(c, 'pipelineId', 'pipeline') && required(c, 'stageId', 'stage')
            ? s
            : null;
        case 'move_lead_stage':
          return required(c, 'pipelineId', 'pipeline') && required(c, 'stageId', 'stage')
            ? s
            : null;
        case 'add_tag':
        case 'remove_tag':
          return required(c, 'tagId', 'tag') ? s : null;
        case 'enrol_workflow':
        case 'remove_from_workflow':
          return required(c, 'workflowId', 'workflow') ? s : null;
        case 'assign_lead':
        case 'assign_conversation':
        case 'create_task':
          assign(c);
          return s;
        case 'notify_team': {
          const who = c.who as Mutable;
          if (who.kind === 'users') {
            const kept = people(who.userIds as unknown[], 'config.who');
            c.who = kept.length ? { kind: 'users', userIds: kept } : { kind: 'admins' };
          }
          return s;
        }
        case 'send_text':
        case 'send_email': {
          if (c.bookingCalendarId === null) return s;
          const next = at('calendar', c.bookingCalendarId, 'config.bookingCalendarId');
          if (next === REMOVE_REF) c.bookingCalendarId = null;
          else if (next !== undefined) c.bookingCalendarId = next;
          return s;
        }
        default:
          return s;
      }
    }
    case 'approval': {
      if (s.approvers.kind === 'users') {
        const before = s.approvers.userIds.length;
        const kept = people(s.approvers.userIds, 'approvers') as Ref[];
        s.approvers =
          kept.length || !before ? { kind: 'users', userIds: kept } : { kind: 'admins' };
      }
      s.rejected = { steps: mapLane(s.rejected.steps, fn) };
      return s;
    }
    case 'branch':
      s.branches = s.branches.map((b) => ({
        ...b,
        condition: b.condition
          ? (mapGroup(b.condition, step.id, `branch:${b.id}`, fn) as typeof b.condition)
          : null,
        steps: mapLane(b.steps, fn),
      }));
      return s;
    case 'wait':
      if (s.until.kind === 'event')
        s.until = {
          ...s.until,
          filter: mapGroup(s.until.filter, step.id, 'until.filter', fn) as typeof s.until.filter,
        };
      return s;
    default:
      return s;
  }
}

function mapLane(steps: readonly Step[], fn: RefMapper): Step[] {
  return steps.flatMap((step) => {
    const next = mapStep(step, fn);
    return next ? [next] : [];
  });
}

/** A copy with every reference passed through `fn` (undefined keeps it). */
export function mapRefs(def: WorkflowDefinition, fn: RefMapper): WorkflowDefinition {
  const out = cloneJson(def);
  const t = out.trigger;
  if (t.kind === 'event' || t.kind === 'date')
    t.filters = mapGroup(t.filters, null, 'trigger.filters', fn) as typeof t.filters;
  if (t.kind === 'schedule')
    t.audience = mapGroup(t.audience, null, 'trigger.audience', fn) as typeof t.audience;
  out.steps = mapLane(out.steps, fn);
  return out;
}

/** Every reference, in document order. */
export function listRefs(def: WorkflowDefinition): RefSite[] {
  const out: RefSite[] = [];
  mapRefs(def, (site) => {
    out.push(site);
    return undefined;
  });
  return out;
}

export const sameSite = (a: RefSite, b: RefSite): boolean =>
  a.stepId === b.stepId &&
  a.where === b.where &&
  a.kind === b.kind &&
  JSON.stringify(a.value) === JSON.stringify(b.value);
