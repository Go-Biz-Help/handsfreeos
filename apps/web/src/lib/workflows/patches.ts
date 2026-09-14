import type { WorkflowOp } from '@hfos/core';

/**
 * Small helpers for the workflow draft: comparing definitions, and folding consecutive edits of the same step
 * into one op so typing in a field doesn't send (or undo) one op per key press. A folded op always leaves
 * the draft exactly as the separate ops would.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with object keys sorted, so equal values built in any order compare equal. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    isObject(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export const sameJson = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/**
 * One merge patch that does what applying `a` and then `b` does (core merges objects key by key and lets
 * arrays and null replace). Null when they can't be folded: `b` merges an object into a key `a` replaced
 * with something else, which would merge into the step's value instead.
 */
function foldPatch(a: unknown, b: unknown): { value: unknown } | null {
  if (!isObject(b)) return { value: b };
  if (!isObject(a)) return null;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (a[k] === undefined) {
      out[k] = v;
      continue;
    }
    const folded = foldPatch(a[k], v);
    if (!folded) return null;
    out[k] = folded.value;
  }
  return { value: out };
}

/** Keys core treats specially in update_step (a new action resets the config; paths merge by id). */
const SPECIAL_KEYS = ['action', 'branches', 'id', 'type', 'rejected'];

/** `next` folded into `prev` when both change the same thing; null when they must stay two ops. */
export function foldOps(prev: WorkflowOp, next: WorkflowOp): WorkflowOp | null {
  if (prev.op === 'update_step' && next.op === 'update_step' && prev.stepId === next.stepId) {
    if (SPECIAL_KEYS.some((k) => k in prev.patch || k in next.patch)) return null;
    const folded = foldPatch(prev.patch, next.patch);
    return folded
      ? { op: 'update_step', stepId: prev.stepId, patch: folded.value as Record<string, unknown> }
      : null;
  }
  if (prev.op === 'set_trigger' && next.op === 'set_trigger') return next;
  if (prev.op === 'set_settings' && next.op === 'set_settings') {
    const folded = foldPatch(prev.patch, next.patch);
    return folded ? { op: 'set_settings', patch: folded.value as Record<string, unknown> } : null;
  }
  if (prev.op === 'set_goto' && next.op === 'set_goto' && prev.stepId === next.stepId)
    return { ...next, maxVisits: next.maxVisits ?? prev.maxVisits };
  return null;
}

/** `ops` added to a queue, each folded into the one before it when it can be. */
export function appendOps(queue: readonly WorkflowOp[], ops: readonly WorkflowOp[]): WorkflowOp[] {
  const out = [...queue];
  for (const op of ops) {
    const last = out.at(-1);
    const folded = last ? foldOps(last, op) : null;
    if (folded) out[out.length - 1] = folded;
    else out.push(op);
  }
  return out;
}
