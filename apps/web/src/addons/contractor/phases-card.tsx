'use client';
/**
 * A job's phases (docs/contractor.md, "Phases"): each with its status, % done and dates, in order. Adding the first
 * one makes a service call a project (the owner's decision 2), and the job's % done is the average of its phases'.
 * Only a phase's start and finish go on the job's timeline.
 */
import { PHASE_STATUSES, type PhaseStatus } from '@hfos/core/addons/contractor/progress';
import { CONTRACTOR_WORDS, PHASE_STATUS_WORDS } from '@hfos/core/addons/contractor/words';
import { formatDateOnly } from '@hfos/core';
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { DueLine } from './bits';
import { ConfirmDialog, PhaseDialog } from './job-dialogs';
import type { JobDetail, JobPhase } from './types';
import { useAct } from './use-act';

const P = CONTRACTOR_WORDS.job.phases;

export function PhasesCard({
  workspaceId,
  job,
  today,
  closed,
}: {
  workspaceId: string;
  job: JobDetail;
  today: string;
  /** Done or cancelled: shown, not changed. */
  closed: boolean;
}) {
  const { busy, act } = useAct();
  const [editing, setEditing] = useState<JobPhase | null>(null);
  const [removing, setRemoving] = useState<JobPhase | null>(null);
  const [name, setName] = useState('');
  const phases = job.phaseList;
  const move = (i: number, by: -1 | 1) => {
    const ids = phases.map((p) => p.id);
    const [one] = ids.splice(i, 1);
    ids.splice(i + by, 0, one!);
    void act(`move:${one}`, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.phase.reorder', {
          body: { workspaceId, jobId: job.id, phaseIds: ids },
        }),
      ),
    );
  };
  const update = (phase: JobPhase, change: { status?: PhaseStatus; percentDone?: number }) =>
    void act(`phase:${phase.id}`, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.phase.update', {
          body: { workspaceId, phaseId: phase.id, ...change },
        }),
      ),
    );
  return (
    <Card className="p-0" data-testid="job-phases">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">{P.title}</h2>
        {phases.length ? (
          <span className="text-[12.5px] text-text-3">
            {phases.filter((p) => p.status === 'done').length} of {phases.length} done
          </span>
        ) : null}
      </div>
      {phases.length === 0 ? (
        <div className="px-5 py-5">
          <p className="text-[13.5px] text-text-2">{P.none}</p>
          {!closed ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              loading={busy === 'make'}
              onClick={() =>
                void act(
                  'make',
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/contractor.job.make_project', {
                        body: { workspaceId, jobId: job.id },
                      }),
                    ),
                  P.madeProject,
                )
              }
              data-testid="job-make-project"
            >
              {P.makeProject}
            </Button>
          ) : null}
        </div>
      ) : (
        <ol>
          {phases.map((p, i) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
              data-testid={`phase-${p.name}`}
            >
              {!closed ? (
                <div className="flex flex-none flex-col">
                  <button
                    type="button"
                    className="rounded p-0.5 text-text-3 hover:bg-card-2 hover:text-text disabled:opacity-30"
                    aria-label={`${P.moveUp}: ${p.name}`}
                    disabled={i === 0 || busy !== null}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 text-text-3 hover:bg-card-2 hover:text-text disabled:opacity-30"
                    aria-label={`${P.moveDown}: ${p.name}`}
                    disabled={i === phases.length - 1 || busy !== null}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
              <div className="min-w-[160px] flex-1">
                <div className="text-[14px] font-medium">
                  <span className="mr-1.5 tabular-nums text-text-3">{i + 1}.</span>
                  {p.name}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-text-3">
                  {p.startsOn ? <span>Starts {formatDateOnly(p.startsOn)}</span> : null}
                  <DueLine
                    dueOn={p.dueOn}
                    daysLate={p.daysLate}
                    today={today}
                    finished={p.status === 'done'}
                  />
                  {p.status === 'done' && p.doneAt ? (
                    <span>Done {formatDateOnly(p.doneAt.slice(0, 10))}</span>
                  ) : null}
                </div>
              </div>
              <Select
                selectSize="sm"
                className="w-[128px]"
                aria-label={`Status of ${p.name}`}
                value={p.status}
                disabled={closed || busy === `phase:${p.id}`}
                onChange={(e) => update(p, { status: e.target.value as PhaseStatus })}
                data-testid="phase-status"
              >
                {PHASE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PHASE_STATUS_WORDS[s]}
                  </option>
                ))}
              </Select>
              <PercentInput
                key={`${p.id}:${p.percentDone}`}
                value={p.percentDone}
                label={`% done of ${p.name}`}
                disabled={closed || busy === `phase:${p.id}`}
                onSave={(n) => update(p, { percentDone: n })}
              />
              {!closed ? (
                <div className="flex flex-none gap-1">
                  <button
                    type="button"
                    className="rounded p-1.5 text-text-3 hover:bg-card-2 hover:text-text"
                    aria-label={`${CONTRACTOR_WORDS.job.edit} ${p.name}`}
                    onClick={() => setEditing(p)}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-1.5 text-text-3 hover:bg-danger-soft hover:text-danger-text"
                    aria-label={`${P.remove} ${p.name}`}
                    onClick={() => setRemoving(p)}
                    data-testid="phase-remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {!closed ? (
        <form
          className="flex gap-2 border-t border-border px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            void act(
              'add',
              async () => {
                unwrap(
                  await apiBrowser().POST('/v1/commands/contractor.phase.add', {
                    body: { workspaceId, jobId: job.id, name: n },
                  }),
                );
                setName('');
              },
              phases.length ? 'Phase added.' : 'It’s a project now.',
            );
          }}
        >
          <Input
            value={name}
            inputSize="sm"
            maxLength={80}
            placeholder={P.addPlaceholder}
            aria-label={P.add}
            onChange={(e) => setName(e.target.value)}
            data-testid="phase-add-name"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={busy === 'add'}
            disabled={!name.trim()}
            data-testid="phase-add"
          >
            {P.add}
          </Button>
        </form>
      ) : null}
      <PhaseDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        workspaceId={workspaceId}
        phase={editing}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `${P.remove} “${removing.name}”?` : P.remove}
        description={removing ? P.removeAsk(removing.name) : ''}
        submit={P.remove}
        done={removing ? P.removed(removing.name) : ''}
        run={async () =>
          removing &&
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.phase.remove', {
              body: { workspaceId, phaseId: removing.id },
            }),
          )
        }
      />
    </Card>
  );
}

/** A % done box that saves when it's left or Enter is pressed, and only when it changed. */
export function PercentInput({
  value,
  label,
  disabled,
  onSave,
}: {
  value: number;
  label: string;
  disabled?: boolean;
  onSave: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const save = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n) || text.trim() === '') return setText(String(value));
    const clamped = Math.max(0, Math.min(100, n));
    setText(String(clamped));
    if (clamped !== value) onSave(clamped);
  };
  return (
    <div className="relative w-[76px] flex-none">
      <Input
        inputSize="sm"
        inputMode="numeric"
        aria-label={label}
        value={text}
        disabled={disabled}
        className="pr-6 text-right tabular-nums"
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
        data-testid="percent-input"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-text-3">
        %
      </span>
    </div>
  );
}
