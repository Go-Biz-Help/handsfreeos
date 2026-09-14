'use client';
import {
  canMove,
  findStep,
  insertionPoints,
  type LaneRef,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';
import { CornerDownRight } from 'lucide-react';
import { useMemo } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { laneName, stepLines } from '@/lib/workflows/steps';

export interface MoveTarget extends LaneRef {
  /** The position in the target lane once the step is taken out (what `move_step` wants). */
  readonly index: number;
}

interface Destination {
  readonly key: string;
  readonly to: MoveTarget;
  readonly label: string;
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every place a step (with everything inside it) can move to, grouped by path. */
export function moveDestinations(
  def: WorkflowDefinition,
  stepId: string,
  names: WorkflowNames,
): { lane: string; options: Destination[] }[] {
  const loc = findStep(def, stepId);
  if (!loc) return [];
  const groups: { lane: string; options: Destination[] }[] = [];
  for (const p of insertionPoints(def, loc.step.type === 'goto' ? 'goto' : undefined)) {
    const same = p.parentId === loc.lane.parentId && p.branchId === loc.lane.branchId;
    if (same && (p.index === loc.index || p.index === loc.index + 1)) continue;
    const to: MoveTarget = {
      parentId: p.parentId,
      branchId: p.branchId,
      index: same && p.index > loc.index ? p.index - 1 : p.index,
    };
    if (!canMove(def, stepId, to)) continue;
    const after = p.afterStepId ? findStep(def, p.afterStepId)?.step : undefined;
    const label = after ? `After “${stepLines(after, names, def).title}”` : 'At the start';
    const lane = upperFirst(laneName(def, p));
    const group = groups.find((g) => g.lane === lane);
    const option = { key: `${p.parentId}|${p.branchId}|${p.index}`, to, label };
    if (group) group.options.push(option);
    else groups.push({ lane, options: [option] });
  }
  return groups;
}

/** "Move to…": the keyboard- and touch-friendly way to move a step. Steps move with their paths. */
export function MoveDialog({
  open,
  onOpenChange,
  def,
  stepId,
  names,
  onMove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  def: WorkflowDefinition;
  stepId: string | null;
  names: WorkflowNames;
  onMove: (stepId: string, to: MoveTarget) => void;
}) {
  const step = stepId ? findStep(def, stepId)?.step : undefined;
  const groups = useMemo(
    () => (stepId ? moveDestinations(def, stepId, names) : []),
    [def, stepId, names],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Move to…"
        description={
          step
            ? `Pick where “${stepLines(step, names, def).title}” goes. Steps move together with their paths.`
            : undefined
        }
        className="max-h-[min(640px,90vh)] overflow-y-auto"
      >
        <div className="mt-3 flex flex-col gap-3" data-testid="move-dialog">
          {groups.map((g) => (
            <section key={g.lane}>
              <h3 className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {g.lane}
              </h3>
              <div className="flex flex-col">
                {g.options.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => {
                      if (stepId) onMove(stepId, o.to);
                      onOpenChange(false);
                    }}
                    className="flex min-h-10 items-center gap-2.5 rounded-control px-2.5 text-left text-sm hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                  >
                    <CornerDownRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                    <span className="min-w-0 truncate">{o.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {!groups.length ? (
            <p className="text-[13px] text-text-2">There’s nowhere else this step can go.</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
