'use client';
import { ArrowDown, ArrowUp, Archive, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { StageBadge } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { Pipeline, Stage } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';

const KIND_LABEL = { open: 'Open', won: 'Won', lost: 'Lost' } as const;

/** Owners and admins rename pipelines, add and reorder stages, change a stage's kind and delete stages. */
export function PipelinesEditor({
  workspaceId,
  pipelines,
}: {
  workspaceId: string;
  pipelines: Pipeline[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [newPipeline, setNewPipeline] = useState(false);
  const [stageDialog, setStageDialog] = useState<{ pipeline: Pipeline; stage?: Stage } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<{ pipeline: Pipeline; stage: Stage } | null>(null);
  useLiveRefresh(['pipeline', 'pipeline_stage']);

  async function call(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const api = () => apiBrowser();

  function reorder(p: Pipeline, index: number, dir: -1 | 1) {
    const ids = p.stages.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    void call(`reorder-${p.id}`, async () =>
      unwrap(
        await api().POST('/v1/commands/stage.reorder', {
          body: { workspaceId, pipelineId: p.id, stageIds: ids },
        }),
      ),
    );
  }
  async function rename(p: Pipeline) {
    const name = prompt('Pipeline name', p.name)?.trim();
    if (!name || name === p.name) return;
    await call(
      `rename-${p.id}`,
      async () =>
        unwrap(
          await api().POST('/v1/commands/pipeline.update', {
            body: { workspaceId, pipelineId: p.id, name },
          }),
        ),
      'Pipeline renamed.',
    );
  }
  async function archive(p: Pipeline) {
    if (
      !confirm(
        `Archive the ${p.name} pipeline? It disappears from the board; its won and lost leads keep their history.`,
      )
    )
      return;
    await call(
      `archive-${p.id}`,
      async () =>
        unwrap(
          await api().POST('/v1/commands/pipeline.archive', {
            body: { workspaceId, pipelineId: p.id },
          }),
        ),
      'Pipeline archived.',
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="pipelines-editor">
      {pipelines.map((p) => (
        <Card key={p.id} className="overflow-hidden" data-testid={`pipeline-${p.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 md:px-6">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[15px] font-semibold">{p.name}</h2>
              {p.isDefault ? <Badge variant="accent">Default</Badge> : null}
              <span className="text-xs text-text-3">
                {p.stages.reduce((a, s) => a + s.leadCount, 0)} leads
              </span>
            </div>
            <div className="flex gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void rename(p)}
                loading={busy === `rename-${p.id}`}
              >
                <Pencil className="h-4 w-4" strokeWidth={1.5} />
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStageDialog({ pipeline: p })}
                data-testid={`stage-add-${p.id}`}
              >
                <Plus className="h-4 w-4" strokeWidth={1.5} />
                Add stage
              </Button>
              {pipelines.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger-text"
                  onClick={() => void archive(p)}
                  loading={busy === `archive-${p.id}`}
                >
                  <Archive className="h-4 w-4" strokeWidth={1.5} />
                  Archive
                </Button>
              ) : null}
            </div>
          </div>
          <ol className="mt-3 divide-y divide-border border-t border-border">
            {p.stages.map((s, i) => (
              <li
                key={s.id}
                className="flex items-center gap-3 px-5 py-2.5 md:px-6"
                data-testid={`stage-row-${s.id}`}
              >
                <span className="flex flex-col">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={i === 0 || !!busy}
                    onClick={() => reorder(p, i, -1)}
                    className="rounded p-0.5 text-text-3 hover:text-text disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={i === p.stages.length - 1 || !!busy}
                    onClick={() => reorder(p, i, 1)}
                    className="rounded p-0.5 text-text-3 hover:text-text disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </span>
                <span className="w-6 text-center text-xs text-text-3">{i + 1}</span>
                <span className="min-w-0 flex-1 font-medium">{s.name}</span>
                <StageBadge name={KIND_LABEL[s.kind]} kind={s.kind} />
                <span className="w-16 text-right text-xs text-text-3">
                  {s.leadCount} lead{s.leadCount === 1 ? '' : 's'}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${s.name}`}
                  onClick={() => setStageDialog({ pipeline: p, stage: s })}
                >
                  <Pencil className="h-4 w-4" strokeWidth={1.5} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => setDeleting({ pipeline: p, stage: s })}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              </li>
            ))}
          </ol>
        </Card>
      ))}
      <div>
        <Button variant="secondary" onClick={() => setNewPipeline(true)} data-testid="pipeline-new">
          <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
          New pipeline
        </Button>
      </div>

      <NewPipelineDialog
        workspaceId={workspaceId}
        open={newPipeline}
        onOpenChange={setNewPipeline}
      />
      {stageDialog ? (
        <StageDialog
          workspaceId={workspaceId}
          pipeline={stageDialog.pipeline}
          stage={stageDialog.stage}
          onClose={() => setStageDialog(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteStageDialog
          workspaceId={workspaceId}
          pipeline={deleting.pipeline}
          stage={deleting.stage}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function NewPipelineDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/pipeline.create', {
          body: { workspaceId, name: name.trim() },
        }),
      );
      toast.success(`${name.trim()} created with the default stages.`);
      setName('');
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New pipeline"
        description="Starts with New, Contacted, Estimate sent, Won and Lost. Rename or rearrange the stages afterwards."
      >
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
          <Field label="Name" htmlFor="pl-name">
            <Input
              id="pl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Maintenance plans"
              autoFocus
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="pipeline-create">
              Create pipeline
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StageDialog({
  workspaceId,
  pipeline,
  stage,
  onClose,
}: {
  workspaceId: string;
  pipeline: Pipeline;
  stage?: Stage;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(stage?.name ?? '');
  const [kind, setKind] = useState<Stage['kind']>(stage?.kind ?? 'open');
  const [after, setAfter] = useState<string>(
    pipeline.stages.filter((s) => s.kind === 'open').at(-1)?.id ?? '',
  );
  const [busy, setBusy] = useState(false);
  const locked = !!stage && stage.leadCount > 0;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (stage) {
        unwrap(
          await apiBrowser().POST('/v1/commands/stage.update', {
            body: {
              workspaceId,
              stageId: stage.id,
              name: name.trim(),
              ...(kind !== stage.kind ? { kind } : {}),
            },
          }),
        );
        toast.success('Stage saved.');
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/stage.create', {
            body: {
              workspaceId,
              pipelineId: pipeline.id,
              name: name.trim(),
              kind,
              afterStageId: after || null,
            },
          }),
        );
        toast.success(`${name.trim()} added.`);
      }
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={stage ? `Edit ${stage.name}` : `Add a stage to ${pipeline.name}`}>
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-4"
          noValidate
          data-testid="stage-form"
        >
          <Field label="Name" htmlFor="st-name">
            <Input id="st-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field
            label="Kind"
            htmlFor="st-kind"
            hint={
              locked
                ? 'A stage with leads keeps its kind. Move the leads out first.'
                : 'Won and lost stages close a lead; open stages keep it moving.'
            }
          >
            <Select
              id="st-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as Stage['kind'])}
              disabled={locked}
            >
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </Select>
          </Field>
          {stage ? null : (
            <Field label="Place after" htmlFor="st-after">
              <Select id="st-after" value={after} onChange={(e) => setAfter(e.target.value)}>
                <option value="">At the start</option>
                {pipeline.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="stage-save">
              {stage ? 'Save stage' : 'Add stage'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteStageDialog({
  workspaceId,
  pipeline,
  stage,
  onClose,
}: {
  workspaceId: string;
  pipeline: Pipeline;
  stage: Stage;
  onClose: () => void;
}) {
  const router = useRouter();
  const targets = pipeline.stages.filter((s) => s.id !== stage.id && s.kind === stage.kind);
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  async function confirmDelete() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/stage.delete', {
          body: {
            workspaceId,
            stageId: stage.id,
            moveLeadsToStageId: stage.leadCount > 0 ? target : null,
          },
        }),
      );
      toast.success(`${stage.name} deleted.`);
      onClose();
      router.refresh();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.rule === 'last_stage_of_kind' || err.rule === 'stage_has_leads')
      )
        setBlocked(err.message);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Delete ${stage.name}?`}
        description={
          stage.leadCount > 0
            ? `${stage.leadCount} lead${stage.leadCount === 1 ? '' : 's'} sit in this stage. Pick another ${KIND_LABEL[stage.kind].toLowerCase()} stage for them.`
            : 'Every pipeline keeps at least one open, one won and one lost stage.'
        }
      >
        {stage.leadCount > 0 ? (
          <Field label="Move the leads to" htmlFor="del-target" className="mt-4">
            <Select id="del-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {blocked ? <p className="mt-3 text-[13px] text-danger-text">{blocked}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={stage.leadCount > 0 && !target}
            onClick={confirmDelete}
            data-testid="stage-delete-confirm"
          >
            Delete stage
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
