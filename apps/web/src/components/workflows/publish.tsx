'use client';
import {
  describeOps,
  diffWorkflows,
  parseDefinition,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';
import { Archive, CheckCircle2, MoreHorizontal, Pause, Play, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowDetail, WorkflowStatus, WorkflowVersion } from '@/lib/api/types';
import type { WorkflowDraft } from '@/lib/workflows/use-draft';
import { cn } from '@/lib/utils';

export type StatusChange = 'pause' | 'resume' | 'archive';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function changeCopy(change: StatusChange, name: string, activeRuns: number | undefined) {
  const going =
    activeRuns === undefined
      ? ''
      : activeRuns
        ? ` ${plural(activeRuns, 'run is', 'runs are')} going now.`
        : ' None are going now.';
  switch (change) {
    case 'pause':
      return {
        title: `Pause “${name}”?`,
        description: 'Nothing is lost while it’s paused.',
        lines: [
          'New triggers are ignored while it’s paused. They aren’t saved for later.',
          `Runs already going hold at their next step.${going}`,
          'Resume it any time, and held runs continue.',
        ],
        confirm: 'Pause workflow',
        done: `Paused “${name}”. Runs going now hold at their next step.`,
      };
    case 'resume':
      return {
        title: `Resume “${name}”?`,
        description: 'It starts runs again right away.',
        lines: [
          'New triggers start runs again.',
          'Held runs continue, 200 at a time. Waits that ran out while it was paused go right away.',
        ],
        confirm: 'Resume workflow',
        done: `Resumed “${name}”.`,
      };
    case 'archive':
      return {
        title: `Archive “${name}”?`,
        description: 'Its versions, runs and history stay.',
        lines: [
          activeRuns
            ? `The ${plural(activeRuns, 'run')} still going stop now.`
            : 'Any runs still going stop now.',
          'It leaves the list and never runs again.',
        ],
        confirm: 'Archive workflow',
        done: `Archived “${name}”.`,
      };
  }
}

/**
 * Confirms Pause, Resume or Archive, saying what happens to triggers and runs, then does it. The editor, the
 * workflow list's switches and a calendar's Automations all use it.
 */
export function StatusChangeDialog({
  change,
  onClose,
  workspaceId,
  workflow,
  onDone,
}: {
  /** What to confirm; null keeps it closed. */
  change: StatusChange | null;
  onClose: () => void;
  workspaceId: string;
  workflow: { id: string; name: string; activeRuns?: number };
  onDone?: (status: WorkflowStatus) => void;
}) {
  const [working, setWorking] = useState(false);
  const [shown, setShown] = useState<StatusChange>('pause');
  if (change && change !== shown) setShown(change);
  const copy = changeCopy(change ?? shown, workflow.name, workflow.activeRuns);

  async function confirm() {
    if (!change) return;
    setWorking(true);
    const body = { workspaceId, workflowId: workflow.id };
    try {
      const out = unwrap(
        change === 'pause'
          ? await apiBrowser().POST('/v1/commands/workflow.pause', { body })
          : change === 'resume'
            ? await apiBrowser().POST('/v1/commands/workflow.resume', { body })
            : await apiBrowser().POST('/v1/commands/workflow.archive', { body }),
      );
      toast.success(copy.done);
      onClose();
      onDone?.(out.status);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={change !== null} onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent title={copy.title} description={copy.description}>
        <ul
          className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-text-2"
          data-testid="status-change-lines"
        >
          {copy.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button
            variant={change === 'archive' ? 'danger' : 'primary'}
            loading={working}
            onClick={() => void confirm()}
            data-testid="status-change-confirm"
          >
            {copy.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The editor header's publishing controls: what still stands in the way ("Run a test first"), Pause or Resume
 * once it's published, Publish (enabled only for a tested draft with nothing red), and Archive in a menu.
 */
export function PublishControls({
  workspaceId,
  workflow,
  versions,
  def,
  names,
  draft,
  errors,
  tested,
}: {
  workspaceId: string;
  workflow: WorkflowDetail;
  versions: readonly WorkflowVersion[];
  def: WorkflowDefinition;
  names: WorkflowNames;
  draft: WorkflowDraft;
  /** Checks that block publishing. */
  errors: number;
  /** This exact draft passed a test. */
  tested: boolean;
}) {
  const router = useRouter();
  const [publishing, setPublishing] = useState(false);
  const [change, setChange] = useState<StatusChange | null>(null);
  const ready = tested && !errors;
  const gate = errors
    ? `Fix ${errors} red ${errors === 1 ? 'item' : 'items'} first`
    : !tested
      ? 'Run a test first'
      : 'Tested, ready to publish';
  const status = workflow.status;

  return (
    <>
      <span aria-hidden className="mx-1 hidden h-[22px] w-px bg-border sm:block" />
      <span
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold',
          errors ? 'text-danger-text' : ready ? 'text-success-text' : 'text-text-3',
        )}
        data-testid="publish-gate"
      >
        {ready ? <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} /> : null}
        {gate}
      </span>
      {status === 'active' ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setChange('pause')}
          data-testid="workflow-pause"
        >
          <Pause className="h-4 w-4" strokeWidth={1.75} />
          Pause
        </Button>
      ) : status === 'paused' ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setChange('resume')}
          data-testid="workflow-resume"
        >
          <Play className="h-4 w-4" strokeWidth={1.75} />
          Resume
        </Button>
      ) : null}
      <span title={ready ? undefined : gate}>
        <Button
          size="sm"
          disabled={!ready || status === 'archived'}
          onClick={() => setPublishing(true)}
          data-testid="workflow-publish"
        >
          <Upload className="h-4 w-4" strokeWidth={1.5} />
          Publish
        </Button>
      </span>
      {status !== 'archived' ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="More about this workflow"
              data-testid="workflow-more"
            >
              <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              danger
              onSelect={() => setChange('archive')}
              data-testid="workflow-archive"
            >
              <Archive className="h-4 w-4" strokeWidth={1.5} />
              Archive…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {publishing ? (
        <PublishDialog
          onClose={() => setPublishing(false)}
          workspaceId={workspaceId}
          workflow={workflow}
          versions={versions}
          def={def}
          names={names}
          draft={draft}
        />
      ) : null}
      <StatusChangeDialog
        change={change}
        onClose={() => setChange(null)}
        workspaceId={workspaceId}
        workflow={{ id: workflow.id, name: workflow.name, activeRuns: workflow.activeRuns }}
        onDone={(next) =>
          next === 'archived' ? router.push(`/app/w/${workspaceId}/workflows`) : router.refresh()
        }
      />
    </>
  );
}

/**
 * "Publish version N?": the changes since the live version in plain words (diffWorkflows then describeOps),
 * and that runs already going finish on the version they started on.
 */
function PublishDialog({
  onClose,
  workspaceId,
  workflow,
  versions,
  def,
  names,
  draft,
}: {
  onClose: () => void;
  workspaceId: string;
  workflow: WorkflowDetail;
  versions: readonly WorkflowVersion[];
  def: WorkflowDefinition;
  names: WorkflowNames;
  draft: WorkflowDraft;
}) {
  const router = useRouter();
  const next = Math.max(0, ...versions.map((v) => v.version)) + 1;
  const liveVersion = workflow.activeVersion?.version ?? null;
  const [liveDef, setLiveDef] = useState<WorkflowDefinition | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (liveVersion === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/workflow.version_get', {
            body: { workspaceId, workflowId: workflow.id, version: liveVersion },
          }),
        );
        if (!cancelled) setLiveDef(parseDefinition(out.version.definition));
      } catch (e) {
        if (!cancelled) {
          setFailed(true);
          toast.error(errorMessage(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [liveVersion, workspaceId, workflow.id]);

  const loading = liveVersion !== null && !liveDef && !failed;
  const changes = liveDef ? describeOps(diffWorkflows(liveDef, def), liveDef, names) : [];
  const same = !!liveDef && changes.length === 0;

  async function publish() {
    setWorking(true);
    try {
      if (!(await draft.flush())) {
        toast.error('Your latest changes aren’t saved yet, so nothing was published.');
        return;
      }
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow.publish', {
          body: { workspaceId, workflowId: workflow.id, baseRevision: draft.revision },
        }),
      );
      toast.success(
        out.status === 'paused'
          ? `Version ${out.version} is published. It stays paused until you resume it.`
          : `Version ${out.version} is live.`,
      );
      onClose();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      if (e instanceof ApiError && e.rule === 'revision_conflict') void draft.loadTheirs();
      if (e instanceof ApiError && e.rule === 'not_tested') router.refresh();
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent
        title={`Publish version ${next}?`}
        description={
          workflow.status === 'paused'
            ? 'It stays paused until you resume it.'
            : 'New runs start on it as soon as it’s published.'
        }
        className="max-h-[88vh] w-[min(520px,calc(100vw-32px))] overflow-y-auto"
      >
        <div className="mt-4" data-testid="publish-preview">
          {liveVersion === null ? (
            <p className="text-[13px] text-text-2">
              This is its first version. Published versions never change: each change after this is
              tested and published as a new version.
            </p>
          ) : (
            <>
              <div className="mb-1.5 text-[13px] font-medium">
                What changes from version {liveVersion}
              </div>
              {loading ? (
                <p className="text-[13px] text-text-3">Comparing with version {liveVersion}…</p>
              ) : same ? (
                <p className="text-[13px] text-text-2">
                  Nothing changed since version {liveVersion}, so there’s nothing to publish.
                </p>
              ) : (
                <ul
                  className="flex max-h-[260px] list-disc flex-col gap-1 overflow-y-auto pl-5 text-[13px] text-text-2"
                  data-testid="publish-changes"
                >
                  {changes.slice(0, 20).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                  {changes.length > 20 ? <li>and {changes.length - 20} more</li> : null}
                </ul>
              )}
              <p
                className="mt-3 rounded-menu bg-card-2 px-3 py-2 text-[13px] text-text-2"
                data-testid="publish-runs-note"
              >
                Runs already in progress finish on version {liveVersion}.
              </p>
            </>
          )}
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button
            loading={working}
            disabled={loading || same}
            onClick={() => void publish()}
            data-testid="publish-confirm"
          >
            <Upload className="h-4 w-4" strokeWidth={1.5} />
            Publish version {next}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
