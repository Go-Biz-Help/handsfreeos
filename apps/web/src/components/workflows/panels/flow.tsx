'use client';
import {
  allSteps,
  countSteps,
  DATE_ANCHORS,
  emptyGroup,
  MAX_BRANCHES,
  newBranchId,
  stepsBefore,
  type ApprovalStep,
  type BranchStep,
  type ConditionGroup,
  type DateAnchorKey,
  type EndStep,
  type GotoStep,
  type TriggerEventKey,
  type WaitStep,
  type WaitUntil,
} from '@hfos/core';
import { Minus, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { stepLines, stepPlace } from '@/lib/workflows/steps';
import type { ApplyOutcome } from '@/lib/workflows/use-draft';
import { laneColor } from '../chips';
import { useEditor } from '../editor-context';
import { ConditionsEditor } from './conditions';
import {
  DayPicker,
  DurationInput,
  Note,
  PanelField,
  PeoplePicker,
  RadioRow,
  useDraftText,
  useStepUpdate,
} from './fields';

const WAIT_EVENTS: readonly { key: TriggerEventKey; label: string }[] = [
  { key: 'message.received', label: 'They reply' },
  { key: 'appointment.booked', label: 'They book an appointment' },
  { key: 'appointment.cancelled', label: 'They cancel' },
  { key: 'appointment.completed', label: 'An appointment is completed' },
  { key: 'call.missed', label: 'They call and it’s missed' },
  { key: 'call.completed', label: 'A call with them ends' },
  { key: 'lead.stage_changed', label: 'Their lead moves stage' },
  { key: 'task.completed', label: 'A task is done' },
];

const DEFAULT_UNTIL: Record<WaitUntil['kind'], WaitUntil> = {
  duration: { kind: 'duration', duration: { amount: 1, unit: 'days' } },
  time_of_day: { kind: 'time_of_day', at: '09:00', days: [1, 2, 3, 4, 5] },
  date_field: {
    kind: 'date_field',
    anchor: 'appointment.starts_at',
    offset: { amount: 1, unit: 'days', direction: 'before' },
    at: null,
  },
  event: {
    kind: 'event',
    events: ['message.received'],
    filter: emptyGroup(),
    timeout: { amount: 1, unit: 'days' },
  },
};

export function WaitPanel({ step }: { step: WaitStep }) {
  const update = useStepUpdate(step.id);
  const { readOnly, timeZone } = useEditor();
  const u = step.until;
  const set = (until: WaitUntil, label = 'Change the wait'): ApplyOutcome =>
    update({ until }, label, { group: 'until', quiet: true });
  const pick = (kind: WaitUntil['kind']) => {
    if (kind !== u.kind) set(DEFAULT_UNTIL[kind]);
  };
  return (
    <div data-testid="panel-wait">
      <PanelField label="Wait">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Wait">
          <RadioRow
            on={u.kind === 'duration'}
            onSelect={() => pick('duration')}
            title="For a set time"
            testId="wait-duration"
          >
            {u.kind === 'duration' ? (
              <DurationInput
                label="Wait"
                value={u.duration}
                onChange={(duration) => set({ ...u, duration })}
                testId="wait-amount"
              />
            ) : null}
          </RadioRow>
          <RadioRow
            on={u.kind === 'time_of_day'}
            onSelect={() => pick('time_of_day')}
            title="Until a time or weekday"
          >
            {u.kind === 'time_of_day' ? (
              <span className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-xs text-text-3">
                  at
                  <Input
                    type="time"
                    inputSize="sm"
                    aria-label="Time"
                    className="h-8 w-[120px]"
                    value={u.at}
                    readOnly={readOnly}
                    onChange={(e) => e.target.value && set({ ...u, at: e.target.value })}
                  />
                </span>
                <DayPicker
                  label="On"
                  days={u.days}
                  onChange={(days) => {
                    if (days.length) set({ ...u, days });
                  }}
                />
              </span>
            ) : null}
          </RadioRow>
          <RadioRow
            on={u.kind === 'date_field'}
            onSelect={() => pick('date_field')}
            title="Until a date"
            detail="Counted from a date on the lead or appointment."
          >
            {u.kind === 'date_field' ? (
              <span className="flex flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <DurationInput
                    label="How long"
                    min={0}
                    value={{ amount: u.offset.amount, unit: u.offset.unit }}
                    onChange={(d) =>
                      set({
                        ...u,
                        offset: { ...u.offset, ...d },
                        at: d.unit === 'days' || d.unit === 'weeks' ? u.at : null,
                      })
                    }
                  />
                  <Select
                    selectSize="sm"
                    aria-label="Before or after"
                    className="h-8 w-auto"
                    value={u.offset.direction}
                    disabled={readOnly}
                    onChange={(e) =>
                      set({
                        ...u,
                        offset: { ...u.offset, direction: e.target.value as 'before' | 'after' },
                      })
                    }
                  >
                    <option value="before">before</option>
                    <option value="after">after</option>
                  </Select>
                </span>
                <Select
                  selectSize="sm"
                  aria-label="Date"
                  value={u.anchor}
                  disabled={readOnly}
                  onChange={(e) => set({ ...u, anchor: e.target.value as DateAnchorKey })}
                >
                  {(Object.keys(DATE_ANCHORS) as DateAnchorKey[]).map((k) => (
                    <option key={k} value={k}>
                      {DATE_ANCHORS[k].label}
                    </option>
                  ))}
                </Select>
              </span>
            ) : null}
          </RadioRow>
          <RadioRow
            on={u.kind === 'event'}
            onSelect={() => pick('event')}
            title="Until something happens"
            detail="Like a reply or a booking, or until the time runs out."
            testId="wait-event"
          >
            {u.kind === 'event' ? (
              <span className="flex w-full flex-col gap-1.5">
                {WAIT_EVENTS.map((ev) => (
                  <Checkbox
                    key={ev.key}
                    label={ev.label}
                    checked={u.events.includes(ev.key)}
                    disabled={readOnly || (u.events.length === 1 && u.events.includes(ev.key))}
                    onChange={(e) =>
                      set({
                        ...u,
                        events: e.target.checked
                          ? [...u.events, ev.key].slice(0, 5)
                          : u.events.filter((x) => x !== ev.key),
                      })
                    }
                  />
                ))}
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-text-3">
                  Give up after
                  <DurationInput
                    label="Give up after"
                    value={u.timeout}
                    onChange={(timeout) => set({ ...u, timeout })}
                  />
                </span>
              </span>
            ) : null}
          </RadioRow>
        </div>
      </PanelField>
      {u.kind === 'event' ? (
        <>
          <ConditionsEditor
            label="Only count it when"
            group={u.filter}
            onChange={(filter) => set({ ...u, filter }, 'Change what the wait counts')}
            place={{ kind: 'step', stepId: step.id }}
            emptyNote="Any of the events above counts."
          />
          <Note className="mb-3.5">
            When the time runs out the run carries on. To do something else, add an If / else on
            “The last wait for an event timed out”.
          </Note>
        </>
      ) : null}
      <p className="text-[12.5px] text-text-3">
        Waits count in {timeZone.replace(/_/g, ' ')}. A text after a wait still keeps to quiet
        hours.
      </p>
    </div>
  );
}

function PathName({ step, branchId, name }: { step: BranchStep; branchId: string; name: string }) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  const text = useDraftText(name, (next) =>
    update({ branches: [{ id: branchId, name: next }] }, 'Rename a path', {
      group: `name-${branchId}`,
      quiet: true,
    }),
  );
  return (
    <>
      <Input
        inputSize="sm"
        aria-label="Path name"
        className="h-8"
        value={text.value}
        invalid={!!text.error}
        readOnly={readOnly}
        maxLength={60}
        onChange={(e) => text.change(e.target.value)}
      />
      {text.error ? <p className="mt-1 text-[12.5px] text-danger-text">{text.error}</p> : null}
    </>
  );
}

function PathDescription({
  step,
  branchId,
  value,
}: {
  step: BranchStep;
  branchId: string;
  value: string;
}) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  const text = useDraftText(value, (next) =>
    update({ branches: [{ id: branchId, description: next }] }, 'Change how the AI picks a path', {
      group: `desc-${branchId}`,
      quiet: true,
    }),
  );
  return (
    <>
      <Textarea
        aria-label="When the AI picks this path"
        className="min-h-[60px] text-[13.5px]"
        value={text.value}
        invalid={!!text.error}
        readOnly={readOnly}
        maxLength={300}
        onChange={(e) => text.change(e.target.value)}
      />
      {text.error ? <p className="mt-1 text-[12.5px] text-danger-text">{text.error}</p> : null}
    </>
  );
}

export function BranchPanel({ step }: { step: BranchStep }) {
  const { apply, readOnly } = useEditor();
  const update = useStepUpdate(step.id);
  const setCondition = (branchId: string, condition: ConditionGroup) =>
    update({ branches: [{ id: branchId, condition }] }, 'Change a path’s rules', {
      group: `cond-${branchId}`,
      quiet: true,
    });
  const removePath = (branchId: string, name: string, steps: number) => {
    if (
      steps &&
      !confirm(`Remove the path “${name}” and its ${steps} ${steps === 1 ? 'step' : 'steps'}?`)
    )
      return;
    apply([{ op: 'delete_branch', stepId: step.id, branchId }], `Remove the path “${name}”`);
  };
  const addPath = () => {
    const n = step.branches.length + 1;
    if (step.mode === 'ai')
      apply(
        [
          {
            op: 'add_branch',
            stepId: step.id,
            index: null,
            branch: {
              id: newBranchId(),
              name: `Path ${n}`,
              description: 'Describe when the AI picks this path',
              steps: [],
            },
          },
        ],
        'Add a path',
      );
    else
      apply(
        [
          {
            op: 'add_branch',
            stepId: step.id,
            index: step.branches.length - 1,
            branch: {
              id: newBranchId(),
              name: `Path ${n - 1}`,
              condition: {
                match: 'all',
                conditions: [{ field: 'person.email', op: 'is_not_empty', value: null }],
              },
              steps: [],
            },
          },
        ],
        'Add a path',
      );
  };
  const canRemove = step.mode !== 'if_else' && step.branches.length > 2;
  return (
    <div data-testid="panel-branch">
      {step.mode === 'if_else' ? (
        <>
          <ConditionsEditor
            label={`Take the “${step.branches[0]!.name}” path when`}
            group={step.branches[0]!.condition ?? emptyGroup()}
            onChange={(g) => setCondition(step.branches[0]!.id, g)}
            place={{ kind: 'step', stepId: step.id }}
            emptyNote="Always, so the other path never runs. Add a rule."
            hint="Checked when the step runs, up to 3 groups deep."
          />
        </>
      ) : null}
      <PanelField label="Paths">
        <div className="flex flex-col gap-2">
          {step.branches.map((b, i) => {
            const otherwise = b.condition === null && step.mode !== 'ai';
            const n = countSteps(b.steps);
            return (
              <div
                key={b.id}
                className="rounded-[8px] border border-border bg-card p-2"
                data-testid={`path-panel-${b.id}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-[9px] w-[9px] flex-none rounded-full"
                    style={{ background: laneColor(i, otherwise) }}
                  />
                  <div className="min-w-0 flex-1">
                    <PathName step={step} branchId={b.id} name={b.name} />
                  </div>
                  <span className="whitespace-nowrap text-xs text-text-3">
                    {n} {n === 1 ? 'step' : 'steps'}
                  </span>
                  {canRemove && !readOnly ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-[26px] w-[26px]"
                      aria-label={`Remove the path ${b.name}`}
                      onClick={() => removePath(b.id, b.name, n)}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </Button>
                  ) : null}
                </div>
                {step.mode === 'ai' ? (
                  <div className="mt-1.5">
                    <PathDescription step={step} branchId={b.id} value={b.description ?? ''} />
                  </div>
                ) : step.mode === 'multi' && !otherwise ? (
                  <div className="mt-2">
                    <ConditionsEditor
                      group={b.condition ?? emptyGroup()}
                      onChange={(g) => setCondition(b.id, g)}
                      place={{ kind: 'step', stepId: step.id }}
                      emptyNote="Always."
                    />
                  </div>
                ) : otherwise ? (
                  <p className="mt-1 text-xs text-text-3">When nothing above matches.</p>
                ) : null}
              </div>
            );
          })}
          {step.mode !== 'if_else' && step.branches.length < MAX_BRANCHES && !readOnly ? (
            <Button variant="ghost" size="sm" className="h-7 self-start px-1.5" onClick={addPath}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              Add a path
            </Button>
          ) : null}
        </div>
      </PanelField>
      {step.mode === 'ai' ? (
        <Note>
          The AI reads their latest message and picks one of these paths. If it isn’t sure, it takes
          the last one.
        </Note>
      ) : (
        <Note>
          Paths are checked top to bottom; the run takes the first one that matches, then carries on
          after the paths.
        </Note>
      )}
    </div>
  );
}

const ordinal = (n: number) =>
  n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;

export function GotoPanel({ step }: { step: GotoStep }) {
  const { def, names, apply, readOnly } = useEditor();
  const targets = allSteps(def).filter(
    (l) => l.step.id !== step.id && l.step.type !== 'goto' && l.step.type !== 'end',
  );
  const setGoto = (target: string, maxVisits: number | null, label: string) =>
    apply([{ op: 'set_goto', stepId: step.id, target, maxVisits }], label);
  return (
    <div data-testid="panel-goto">
      <PanelField label="Go back to" htmlFor={`goto-${step.id}`}>
        <Select
          id={`goto-${step.id}`}
          selectSize="sm"
          value={targets.some((t) => t.step.id === step.target) ? step.target : ''}
          disabled={readOnly}
          onChange={(e) => setGoto(e.target.value, null, 'Change where it goes back to')}
        >
          {!targets.some((t) => t.step.id === step.target) ? (
            <option value="" disabled>
              Pick a step
            </option>
          ) : null}
          {targets.map((t) => (
            <option key={t.step.id} value={t.step.id}>
              {stepLines(t.step, names, def).title} · {stepPlace(def, t.step.id).toLowerCase()}
            </option>
          ))}
        </Select>
      </PanelField>
      <PanelField
        label="At most"
        hint={`After the ${ordinal(step.maxVisits)} time, the run moves on to the steps after the paths.`}
      >
        <span className="inline-flex items-center gap-2 text-[13px]">
          <span className="inline-flex h-8 items-center rounded-control border border-border-strong">
            <button
              type="button"
              aria-label="Fewer times"
              disabled={readOnly || step.maxVisits <= 1}
              onClick={() => setGoto(step.target, step.maxVisits - 1, 'Change how many times')}
              className="flex h-full w-[30px] items-center justify-center text-text-2 hover:bg-card-2 disabled:opacity-40"
            >
              <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <span className="w-7 text-center tabular-nums" data-testid="goto-visits">
              {step.maxVisits}
            </span>
            <button
              type="button"
              aria-label="More times"
              disabled={readOnly || step.maxVisits >= 10}
              onClick={() => setGoto(step.target, step.maxVisits + 1, 'Change how many times')}
              className="flex h-full w-[30px] items-center justify-center text-text-2 hover:bg-card-2 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </span>
          times per run
        </span>
      </PanelField>
      <Note>A go-to can only be the last step of a path.</Note>
    </div>
  );
}

export function EndPanel({ step }: { step: EndStep }) {
  void step;
  return (
    <Note>
      The run finishes here. Runs also end when they reply or book, if the workflow’s settings say
      so.
    </Note>
  );
}

export function ApprovalPanel({ step }: { step: ApprovalStep }) {
  const update = useStepUpdate(step.id);
  const { def, names, readOnly } = useEditor();
  const message = useDraftText(step.message, (next) =>
    update({ message: next }, 'Edit the note to approvers', { group: 'message', quiet: true }),
  );
  const writers = stepsBefore(def, step.id).filter((s) => s.type === 'ai' && s.task === 'write');
  const a = step.approvers;
  return (
    <div data-testid="panel-approval">
      <PanelField
        label="Who can approve"
        hint="They’re asked on the Approvals page, on Home, by email and in the Assistant."
      >
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Who can approve">
          <RadioRow
            on={a.kind === 'admins'}
            onSelect={() => update({ approvers: { kind: 'admins' } }, 'Change who approves')}
            title="Owners and admins"
          />
          <RadioRow
            on={a.kind === 'users'}
            onSelect={() => {
              if (a.kind !== 'users')
                update({ approvers: { kind: 'users', userIds: [] } }, 'Change who approves');
            }}
            title="Named people"
          >
            {a.kind === 'users' ? (
              <PeoplePicker
                label="Approvers"
                userIds={a.userIds}
                onChange={(ids) =>
                  update({ approvers: { kind: 'users', userIds: ids } }, 'Change who approves')
                }
              />
            ) : null}
          </RadioRow>
        </div>
      </PanelField>
      <PanelField label="What to tell them" htmlFor={`appr-msg-${step.id}`} error={message.error}>
        <Textarea
          id={`appr-msg-${step.id}`}
          className="min-h-[64px] text-[14px]"
          value={message.value}
          readOnly={readOnly}
          maxLength={500}
          placeholder="Check this reply before it goes to the customer."
          onChange={(e) => message.change(e.target.value)}
        />
      </PanelField>
      <PanelField
        label="What they see"
        htmlFor={`appr-prev-${step.id}`}
        hint={writers.length ? 'They can edit the AI’s text before approving.' : undefined}
      >
        <Select
          id={`appr-prev-${step.id}`}
          selectSize="sm"
          value={step.previewStepId ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            update({ previewStepId: e.target.value || null }, 'Change what approvers see')
          }
        >
          <option value="">Just the note above</option>
          {writers.map((s) => (
            <option key={s.id} value={s.id}>
              The text from “{stepLines(s, names, def).title}”
            </option>
          ))}
        </Select>
      </PanelField>
      <PanelField label="If nobody answers in">
        <DurationInput
          label="If nobody answers in"
          value={step.expiresAfter}
          onChange={(expiresAfter) => update({ expiresAfter }, 'Change when it expires')}
        />
      </PanelField>
      <PanelField label="Then" htmlFor={`appr-exp-${step.id}`}>
        <Select
          id={`appr-exp-${step.id}`}
          selectSize="sm"
          value={step.onExpire}
          disabled={readOnly}
          onChange={(e) =>
            update({ onExpire: e.target.value }, 'Change what happens when it expires')
          }
        >
          <option value="reject">Treat it as rejected</option>
          <option value="approve">Approve it and carry on</option>
          <option value="end">End the run</option>
        </Select>
      </PanelField>
      <Note icon={ShieldCheck}>
        If they reject it, the steps under “If it’s rejected” run ({countSteps(step.rejected.steps)}{' '}
        now), then the run ends.
      </Note>
    </div>
  );
}
