'use client';
import { Workflow as WorkflowIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowRunSummary, WorkflowSummary } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { endReasonText, isLive, RUN_STATUS, whenText } from '@/lib/workflows/run-words';
import { cn } from '@/lib/utils';
import { RunStatusBadge } from './runs/run-status';

/** Someone was just added to a workflow here: the card looks again while the engine starts the run. */
const CHANGED = 'hfos:contact-workflows-changed';

const firstName = (full: string) => full.trim().split(/\s+/)[0] || full;

async function personRuns(workspaceId: string, personId: string) {
  return unwrap(
    await apiBrowser().POST('/v1/queries/workflow.run_list', {
      body: { workspaceId, personId, limit: 20 },
    }),
  ).items;
}

function dateText(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );
}

/** Whether a workflow can take this customer now, and a line saying why or what happens. */
function availability(
  w: WorkflowSummary,
  runs: readonly WorkflowRunSummary[],
  first: string,
  timeZone: string,
): { ok: boolean; note: string } {
  if (w.status === 'paused') return { ok: false, note: 'Paused. Resume it to add people.' };
  const theirs = runs.filter((r) => r.workflow.id === w.id);
  const live = theirs.find((r) => isLive(r.status));
  if (w.reentry === 'once' && theirs.length)
    return {
      ok: false,
      note: `${first} went through it on ${dateText(theirs[0]!.startedAt, timeZone)}. It runs once for each customer.`,
    };
  if (live && w.reentry !== 'always')
    return { ok: false, note: `Already in it. It can start again after ${first} finishes.` };
  return { ok: true, note: w.description || 'Starts at its first step right away.' };
}

/** "Add to workflow…" on a customer or lead page: workflows that start by hand, then one click to add them. */
export function AddToWorkflowButton({
  workspaceId,
  person,
  timeZone,
  canManageWorkflows,
}: {
  workspaceId: string;
  person: { id: string; fullName: string };
  timeZone: string;
  canManageWorkflows: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="add-to-workflow"
      >
        <WorkflowIcon className="h-4 w-4" strokeWidth={1.5} />
        Add to workflow…
      </Button>
      {open ? (
        <AddToWorkflowDialog
          workspaceId={workspaceId}
          person={person}
          timeZone={timeZone}
          canManageWorkflows={canManageWorkflows}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AddToWorkflowDialog({
  workspaceId,
  person,
  timeZone,
  canManageWorkflows,
  onClose,
}: {
  workspaceId: string;
  person: { id: string; fullName: string };
  timeZone: string;
  canManageWorkflows: boolean;
  onClose: () => void;
}) {
  const first = firstName(person.fullName);
  const [flows, setFlows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, theirs] = await Promise.all([
          apiBrowser().POST('/v1/queries/workflow.list', {
            body: { workspaceId, status: ['active', 'paused'] },
          }),
          personRuns(workspaceId, person.id),
        ]);
        if (cancelled) return;
        // Only what the published version starts by hand can take someone from here.
        const manual = unwrap(list).items.filter(
          (w) => w.trigger.kind === 'manual' && w.activeVersion,
        );
        setFlows(manual);
        setRuns(theirs);
        setPick(manual.find((w) => availability(w, theirs, first, timeZone).ok)?.id ?? null);
      } catch (e) {
        if (!cancelled) {
          toast.error(errorMessage(e));
          setFlows([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, person.id, first, timeZone]);

  async function add() {
    const w = flows?.find((f) => f.id === pick);
    if (!w) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/workflow.enrol', {
          body: { workspaceId, workflowId: w.id, personId: person.id },
        }),
      );
      toast.success(`Added ${first} to “${w.name}”. It starts in a moment.`);
      window.dispatchEvent(new CustomEvent(CHANGED));
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title={`Add ${first} to a workflow`}
        description="Workflows that start by hand. The run starts at the first step."
        className="max-h-[88vh] w-[min(520px,calc(100vw-32px))] overflow-y-auto"
      >
        <div
          className="mt-4 flex flex-col gap-2"
          role="radiogroup"
          aria-label="Workflow"
          data-testid="add-to-workflow-list"
        >
          {flows === null ? (
            <p className="text-[13px] text-text-3">Loading workflows…</p>
          ) : !flows.length ? (
            <div className="rounded-menu bg-card-2 px-3.5 py-3 text-[13px] text-text-2">
              No workflow starts by hand yet. A published workflow whose trigger is “Started by
              hand” shows here.
              {canManageWorkflows ? (
                <>
                  {' '}
                  <Link
                    href={`/app/w/${workspaceId}/workflows`}
                    className="font-medium text-accent-text hover:underline"
                  >
                    Open Workflows
                  </Link>
                </>
              ) : null}
            </div>
          ) : (
            flows.map((w) => {
              const a = availability(w, runs, first, timeZone);
              const on = pick === w.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!a.ok}
                  onClick={() => setPick(w.id)}
                  data-testid={`add-to-${w.id}`}
                  className={cn(
                    'flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed',
                    on
                      ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
                      : 'border-border-strong bg-card hover:bg-card-2 disabled:opacity-65 disabled:hover:bg-card',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
                      on ? 'border-accent' : 'border-border-strong',
                    )}
                  >
                    {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13.5px] font-medium">{w.name}</span>
                    <span className="text-xs text-text-2">{a.note}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!pick}
            onClick={() => void add()}
            data-testid="add-to-workflow-confirm"
          >
            Add {first}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A run's line on the card: "Waiting · started Today, 10:36 AM", "Completed Aug 30 · it finished every step". */
function runLine(r: WorkflowRunSummary, timeZone: string): string {
  const label = RUN_STATUS[r.status].label;
  if (isLive(r.status)) return `${label} · started ${whenText(r.startedAt, timeZone)}`;
  const why = endReasonText(r.endReason);
  const when = whenText(r.endedAt ?? r.startedAt, timeZone);
  return `${label} ${when}${why ? ` · ${why[0]!.toLowerCase()}${why.slice(1)}` : ''}`;
}

/**
 * The Workflows card on a customer or lead page: this customer's runs, going now and recent, each linked
 * to its run, with Remove for one still going.
 */
export function ContactWorkflowsCard({
  workspaceId,
  person,
  timeZone,
}: {
  workspaceId: string;
  person: { id: string; fullName: string };
  timeZone: string;
}) {
  const first = firstName(person.fullName);
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [removing, setRemoving] = useState<WorkflowRunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);
  const changes = useLiveVersion(['workflow_run', 'workflow']);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  const load = useCallback(async () => {
    try {
      setRuns(await personRuns(workspaceId, person.id));
    } catch {
      setRuns((had) => had ?? []);
    }
  }, [workspaceId, person.id]);

  useEffect(() => {
    void load();
  }, [load, changes, bump]);

  useEffect(() => {
    const list = timers.current;
    const onChanged = () => {
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        setBump((b) => b + 1);
        if (n >= 10) clearInterval(timer);
      }, 1000);
      list.push(timer);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.removeEventListener(CHANGED, onChanged);
      list.forEach(clearInterval);
    };
  }, []);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow.remove_contact', {
          body: { workspaceId, workflowId: removing.workflow.id, personId: person.id },
        }),
      );
      toast.success(
        out.pending
          ? `${first} will be taken out of “${removing.workflow.name}” in a moment.`
          : `Took ${first} out of “${removing.workflow.name}”.`,
      );
      setRemoving(null);
      void load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 md:p-5" data-testid="contact-workflows">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">Workflows</h3>
        {runs?.length ? (
          <span className="text-xs text-text-3">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'}
          </span>
        ) : null}
      </div>
      {runs === null ? (
        <p className="text-[13px] text-text-3">Loading…</p>
      ) : !runs.length ? (
        <p className="text-[13px] text-text-2">Not in any workflow yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {runs.slice(0, 6).map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2.5 py-2.5 first:pt-0 last:pb-0"
              data-testid={`contact-run-${r.id}`}
              data-status={r.status}
            >
              <span className="min-w-0 flex-1">
                <Link
                  href={`/app/w/${workspaceId}/workflows/runs/${r.id}`}
                  className="block truncate text-[13.5px] font-medium hover:underline"
                >
                  {r.workflow.name}
                </Link>
                <span className="block text-xs text-text-2">{runLine(r, timeZone)}</span>
              </span>
              {isLive(r.status) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoving(r)}
                  data-testid="contact-run-remove"
                >
                  Remove
                </Button>
              ) : (
                <RunStatusBadge status={r.status} />
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!removing} onOpenChange={(o) => !o && !busy && setRemoving(null)}>
        <DialogContent
          title={`Take ${first} out of “${removing?.workflow.name ?? ''}”?`}
          description="Their run stops now and takes no more steps. You can add them again later."
        >
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setRemoving(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void remove()}
              data-testid="contact-run-remove-confirm"
            >
              Take {first} out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
