/**
 * Agency templates, browser-safe. A template names nothing in any one business (its stages, tags, calendars
 * and people are `{"$ph": "key"}` placeholders), so it is checked for its own structure only. Each business
 * ends up with a mapping: what the agency stored when it pushed, then a suggestion by name for any key it
 * never mapped (an explicit null stays unmapped, for the business to pick). An update to a newer version is
 * merged with the business's own changes: the new version, with every change the business made to its copy
 * since it installed put back on top, so its changes win where both changed the same thing. A change that no
 * longer fits (a step the template removed) is dropped, and both lists are shown before anything is applied.
 */
import type { WorkflowDefinition } from './definition';
import { describeOps, diffWorkflows, type WorkflowNames } from './describe';
import { isPlainObject, jsonEqual } from './json';
import { applyWorkflowOps, WorkflowOpError, type WorkflowOp } from './ops';
import { suggestMapping, type WorkflowPlaceholder } from './recipes';
import {
  emptyWorkflowCatalogs,
  validateWorkflow,
  type WorkflowCatalogs,
  type WorkflowIssue,
} from './rules';
import { findStep } from './walk';

/** What a template is checked against: nothing to name (placeholders stand in), texting assumed ready. */
export function templateCatalogs(timeZone = 'America/Chicago'): WorkflowCatalogs {
  return { ...emptyWorkflowCatalogs(timeZone), services: [], workflows: [], textingReady: true };
}

/**
 * A template's checks: structure, variables, limits. Placeholders are what a template is made of, so they
 * aren't problems here; each business maps them when it gets its copy.
 */
export function templateIssues(
  def: WorkflowDefinition,
  now: Date | number = Date.now(),
): WorkflowIssue[] {
  return validateWorkflow(def, templateCatalogs(), now).filter(
    (i) => i.code !== 'placeholder_unmapped',
  );
}

/** Placeholder key → the id it stands for in one business; null is left for the business to pick. */
export type PlaceholderIds = Record<string, string | null>;

/**
 * The mapping a business ends up with for these placeholders: the stored one, then `suggestMapping` for any
 * key it never had. A stored null stays null: someone chose to leave it for the business.
 */
export function effectiveMapping(
  placeholders: readonly WorkflowPlaceholder[],
  stored: Readonly<Record<string, unknown>>,
  catalogs: WorkflowCatalogs,
): PlaceholderIds {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(stored, key);
  const suggested = suggestMapping(
    placeholders.filter((p) => !has(p.key)),
    catalogs,
  );
  const out: PlaceholderIds = {};
  for (const p of placeholders) {
    const value = stored[p.key];
    out[p.key] = has(p.key)
      ? typeof value === 'string'
        ? value
        : null
      : (suggested[p.key] ?? null);
  }
  return out;
}

/** The keys a mapping leaves for the business to pick. */
export const unmappedKeys = (mapping: Readonly<PlaceholderIds>): string[] =>
  Object.entries(mapping)
    .filter(([, id]) => id === null)
    .map(([key]) => key);

/**
 * A business's change to a step, narrowed to the parts it changed: a new text body in an action's config
 * becomes `{config: {body}}`, so a template change to the same step's subject still comes through. Objects
 * that lost keys keep the whole object (a merge patch can't remove a key).
 */
function narrowed(op: WorkflowOp, base: WorkflowDefinition): WorkflowOp {
  if (op.op !== 'update_step' || 'action' in op.patch) return op;
  const before = findStep(base, op.stepId)?.step as unknown as Record<string, unknown> | undefined;
  if (!before) return op;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(op.patch)) {
    const was = before[key];
    if (
      key !== 'branches' &&
      isPlainObject(value) &&
      isPlainObject(was) &&
      Object.keys(was).every((k) => k in value)
    )
      patch[key] = Object.fromEntries(
        Object.entries(value).filter(([k, v]) => !jsonEqual(was[k], v)),
      );
    else patch[key] = value;
  }
  return { ...op, patch };
}

export interface TemplateMerge {
  /** The new version with the business's changes on top. */
  readonly definition: WorkflowDefinition;
  /** What the template changed between the installed version and the new one. */
  readonly templateOps: readonly WorkflowOp[];
  /** What the business changed in its copy since it installed. */
  readonly yourOps: readonly WorkflowOp[];
  /** The business's changes that were put back on top of the new version, and those that no longer fit. */
  readonly kept: readonly WorkflowOp[];
  readonly dropped: readonly WorkflowOp[];
}

/**
 * Merges a template update into a business's copy. `base` is the installed version and `theirs` the new
 * one, both resolved with the business's mapping; `mine` is the copy as it is now. Steps match by their
 * stable ids, so a reworded text or a changed wait lines up with the same step in the new version.
 */
export function mergeTemplateUpdate(
  base: WorkflowDefinition,
  theirs: WorkflowDefinition,
  mine: WorkflowDefinition,
): TemplateMerge {
  const templateOps = diffWorkflows(base, theirs);
  const yourOps = diffWorkflows(base, mine).map((op) => narrowed(op, base));
  let definition = theirs;
  const kept: WorkflowOp[] = [];
  const dropped: WorkflowOp[] = [];
  for (const op of yourOps) {
    try {
      definition = applyWorkflowOps(definition, [op]).definition;
      kept.push(op);
    } catch (e) {
      if (!(e instanceof WorkflowOpError)) throw e;
      dropped.push(op);
    }
  }
  return { definition, templateOps, yourOps, kept, dropped };
}

/** The lists a business reads before applying: the template's changes, its own kept and dropped ones. */
export function describeTemplateMerge(
  merge: TemplateMerge,
  base: WorkflowDefinition,
  names: WorkflowNames = {},
): { templateChanges: string[]; kept: string[]; dropped: string[] } {
  return {
    templateChanges: describeOps(merge.templateOps, base, names),
    kept: describeOps(merge.kept, base, names),
    dropped: describeOps(merge.dropped, base, names),
  };
}
