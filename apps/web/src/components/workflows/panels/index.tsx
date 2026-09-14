'use client';
import { findStep, newBranchId, newStepId, type Step, type StepInput } from '@hfos/core';
import {
  Copy,
  CornerDownRight,
  MoreHorizontal,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { stepLines, stepPlace, stepTone, stepTypeName, type StepTone } from '@/lib/workflows/steps';
import { KindTile, stepIcon, triggerIconOf } from '../chips';
import { SETTINGS_ID, TRIGGER_ID, useEditor } from '../editor-context';
import { ActionPanel } from './actions';
import { AiPanel } from './ai';
import { ApprovalPanel, BranchPanel, EndPanel, GotoPanel, WaitPanel } from './flow';
import { SettingsPanel } from './settings';
import { TriggerPanel } from './trigger';

/** A copy of a step (and everything inside it) with new ids, for Duplicate. */
function withNewIds(step: Step): StepInput {
  const copy = structuredClone(step) as Step & Record<string, unknown>;
  copy.id = newStepId();
  if (copy.type === 'branch')
    copy.branches = copy.branches.map((b) => ({
      ...b,
      id: newBranchId(),
      steps: b.steps.map((s) => withNewIds(s) as Step),
    }));
  if (copy.type === 'approval')
    copy.rejected = { steps: copy.rejected.steps.map((s) => withNewIds(s) as Step) };
  return copy as StepInput;
}

/** The panel's header: the step's tile, its name and where it sits, and Move, Duplicate, Delete. */
export function PanelHeader({
  tone,
  icon,
  title,
  subtitle,
  menu,
}: {
  tone: StepTone;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  menu?: ReactNode;
}) {
  return (
    <div className="mb-3.5 flex items-start gap-2.5">
      <KindTile tone={tone} icon={icon} />
      <span className="flex min-w-0 flex-1 flex-col">
        <h3 className="text-[15px] font-semibold leading-tight" data-testid="panel-title">
          {title}
        </h3>
        <span className="text-xs text-text-3">{subtitle}</span>
      </span>
      {menu}
    </div>
  );
}

function StepMenu({ step }: { step: Step }) {
  const { def, names, apply, select, openMove } = useEditor();
  const loc = findStep(def, step.id);
  const { title } = stepLines(step, names, def);
  const canCopy = step.type !== 'goto' && step.type !== 'end';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Duplicate, move or delete"
          title="Duplicate, move or delete"
          data-testid="step-menu"
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => openMove(step.id)} data-testid="step-move">
          <CornerDownRight className="h-4 w-4" strokeWidth={1.5} />
          Move to…
        </DropdownMenuItem>
        {canCopy && loc ? (
          <DropdownMenuItem
            onSelect={() => {
              const copy = withNewIds(step);
              const out = apply(
                [
                  {
                    op: 'add_step',
                    parentId: loc.lane.parentId,
                    branchId: loc.lane.branchId,
                    index: loc.index + 1,
                    step: copy,
                  },
                ],
                `Duplicate “${title}”`,
              );
              if (out.ok) select(copy.id);
            }}
          >
            <Copy className="h-4 w-4" strokeWidth={1.5} />
            Duplicate
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          danger
          data-testid="step-delete"
          onSelect={() => {
            const out = apply([{ op: 'delete_step', stepId: step.id }], `Remove “${title}”`);
            if (!out.ok || !loc) return;
            const lane = loc.lane.parentId ? findStep(def, loc.lane.parentId)?.step : undefined;
            const siblings = loc.lane.parentId === null ? def.steps : undefined;
            const before = siblings?.[loc.index - 1]?.id ?? lane?.id ?? TRIGGER_ID;
            select(before);
          }}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.5} />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Body({ step }: { step: Step }) {
  switch (step.type) {
    case 'action':
      return <ActionPanel step={step} />;
    case 'wait':
      return <WaitPanel step={step} />;
    case 'branch':
      return <BranchPanel step={step} />;
    case 'ai':
      return <AiPanel step={step} />;
    case 'approval':
      return <ApprovalPanel step={step} />;
    case 'goto':
      return <GotoPanel step={step} />;
    case 'end':
      return <EndPanel step={step} />;
  }
}

/** The rail's (or the phone sheet's) settings for what's selected: a step, the trigger or the settings. */
export function StepPanel({ selection }: { selection: string | null }) {
  const { def, readOnly, workflowName } = useEditor();
  if (selection === SETTINGS_ID)
    return (
      <div data-testid="step-panel">
        <PanelHeader
          tone="wait"
          icon={SlidersHorizontal}
          title="Workflow settings"
          subtitle={workflowName}
        />
        <SettingsPanel />
      </div>
    );
  if (selection === TRIGGER_ID)
    return (
      <div data-testid="step-panel">
        <PanelHeader
          tone="trig"
          icon={triggerIconOf(def.trigger)}
          title="Trigger"
          subtitle="What starts this workflow"
        />
        <TriggerPanel />
      </div>
    );
  const loc = selection ? findStep(def, selection) : null;
  if (!loc)
    return (
      <div className="px-2 py-10 text-center text-[13px] text-text-2" data-testid="step-panel">
        Pick a step to see its settings.
      </div>
    );
  const step = loc.step;
  return (
    <div data-testid="step-panel" data-step-id={step.id}>
      <PanelHeader
        tone={stepTone(step)}
        icon={stepIcon(step)}
        title={stepTypeName(step)}
        subtitle={stepPlace(def, step.id)}
        menu={readOnly ? null : <StepMenu step={step} />}
      />
      <Body key={step.id} step={step} />
    </div>
  );
}
