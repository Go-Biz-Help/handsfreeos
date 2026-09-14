'use client';
import {
  describeOps,
  diffWorkflows,
  parseDefinition,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';
import { Eye, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowVersion } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { StepList } from './step-list';

function when(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
  if (day === today) return `Today, ${time}`;
  return `${new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(d)}, ${time}`;
}

interface Loaded {
  readonly version: WorkflowVersion;
  readonly definition: WorkflowDefinition;
}

/**
 * Published versions never change. View shows one as a read-only step list; Restore previews what it
 * changes in the draft, then copies it in as a new revision that needs a new test.
 */
export function HistorySheet({
  open,
  onOpenChange,
  workspaceId,
  workflowId,
  workflowName,
  versions,
  liveVersionId,
  draftRevision,
  draft,
  names,
  timeZone,
  canRestore,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  versions: readonly WorkflowVersion[];
  liveVersionId: string | null;
  draftRevision: number;
  draft: WorkflowDefinition;
  names: WorkflowNames;
  timeZone: string;
  canRestore: boolean;
  /** Saves the draft, restores, and loads the result; resolves false when it didn't happen. */
  onRestore: (version: number) => Promise<boolean>;
}) {
  const [viewing, setViewing] = useState<Loaded | null>(null);
  const [restoring, setRestoring] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [working, setWorking] = useState(false);

  async function load(v: WorkflowVersion): Promise<Loaded | null> {
    setBusy(v.version);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/workflow.version_get', {
          body: { workspaceId, workflowId, version: v.version },
        }),
      );
      return { version: v, definition: parseDefinition(out.version.definition) };
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const changes = restoring
    ? describeOps(diffWorkflows(draft, restoring.definition), draft, names)
    : [];

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          title="History"
          description="Published versions never change. Restore copies an old version into the draft, and you test and publish it like any change."
        >
          <div className="mb-1 text-xs text-text-3">{workflowName}</div>
          <ol data-testid="workflow-history">
            <li className="flex items-start gap-3 border-t border-border py-3">
              <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-card-2 text-xs font-semibold text-text-2">
                D
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  Draft · revision {draftRevision}
                  <Badge variant="gray">Draft</Badge>
                </span>
                <span className="text-xs text-text-3">
                  What you’re editing now. It saves as you go.
                </span>
              </span>
            </li>
            {versions.map((v) => {
              const live = v.id === liveVersionId;
              return (
                <li
                  key={v.id}
                  className="flex items-start gap-3 border-t border-border py-3"
                  data-testid={`version-${v.version}`}
                >
                  <span
                    className={cn(
                      'inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-xs font-semibold',
                      live ? 'bg-accent text-white' : 'bg-card-2 text-text-2',
                    )}
                  >
                    {v.version}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      Version {v.version}
                      {live ? <Badge variant="ok">Live</Badge> : null}
                    </span>
                    {v.diff.length ? (
                      <span className="text-xs text-text-2">
                        {v.diff.slice(0, 2).join(' · ')}
                        {v.diff.length > 2 ? ` · and ${v.diff.length - 2} more` : ''}
                      </span>
                    ) : null}
                    <span className="text-xs text-text-3">
                      {when(v.createdAt, timeZone)} · {v.publishedBy?.fullName ?? 'HandsFreeOS'}
                    </span>
                    <span className="mt-1.5 flex flex-wrap gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy === v.version && !restoring}
                        onClick={async () => setViewing(await load(v))}
                        data-testid={`view-${v.version}`}
                      >
                        <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                        View
                      </Button>
                      {canRestore ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={async () => setRestoring(await load(v))}
                          data-testid={`restore-${v.version}`}
                        >
                          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Restore
                        </Button>
                      ) : null}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
          {!versions.length ? (
            <p
              className="border-t border-border pt-3 text-[13px] text-text-2"
              data-testid="history-empty"
            >
              Nothing is published yet. Each version you publish is kept here, and you can restore
              any of them.
            </p>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent
          title={viewing ? `Version ${viewing.version.version}` : 'Version'}
          description="As it was published. Published versions never change."
          className="max-h-[88vh] w-[min(720px,calc(100vw-32px))] overflow-y-auto"
        >
          {viewing ? (
            <div className="mt-4 rounded-card border border-border bg-card-2 p-3">
              <StepList definition={viewing.definition} names={names} testId="version-steps" />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!restoring} onOpenChange={(o) => !o && !working && setRestoring(null)}>
        <DialogContent
          title={restoring ? `Restore version ${restoring.version.version}?` : 'Restore'}
          description="It copies that version into the draft. Test it again before you publish."
        >
          <div className="mt-3" data-testid="restore-preview">
            {changes.length ? (
              <>
                <div className="mb-1.5 text-[13px] font-medium">What changes in the draft</div>
                <ul className="flex max-h-[260px] list-disc flex-col gap-1 overflow-y-auto pl-5 text-[13px] text-text-2">
                  {changes.slice(0, 20).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                  {changes.length > 20 ? <li>and {changes.length - 20} more</li> : null}
                </ul>
              </>
            ) : (
              <p className="text-[13px] text-text-2">The draft already matches this version.</p>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRestoring(null)} disabled={working}>
              Cancel
            </Button>
            <Button
              loading={working}
              disabled={!changes.length}
              data-testid="restore-confirm"
              onClick={async () => {
                if (!restoring) return;
                setWorking(true);
                const ok = await onRestore(restoring.version.version);
                setWorking(false);
                if (ok) {
                  setRestoring(null);
                  onOpenChange(false);
                }
              }}
            >
              Restore version {restoring?.version.version}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
