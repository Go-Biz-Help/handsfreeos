'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Pipeline } from '@/lib/api/types';
import { parseMoney } from '@/lib/format';

/** Creates a lead for a person or company. It starts in the first open stage unless another is picked. */
export function LeadDialog({
  workspaceId,
  open,
  onOpenChange,
  pipelines,
  members,
  myUserId,
  record,
  defaultPipelineId,
  defaultStageId,
  onCreated,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelines: Pipeline[];
  members: { id: string; fullName: string }[];
  myUserId: string;
  record: { personId?: string | null; companyId?: string | null; name: string };
  defaultPipelineId?: string;
  defaultStageId?: string;
  onCreated?: (leadId: string) => void;
}) {
  const router = useRouter();
  const active = pipelines.filter((p) => !p.archivedAt);
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [pipelineId, setPipelineId] = useState(defaultPipelineId ?? active[0]?.id ?? '');
  const [stageId, setStageId] = useState(defaultStageId ?? '');
  const [assignee, setAssignee] = useState(myUserId);
  const [closeOn, setCloseOn] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [nextAt, setNextAt] = useState('');
  const [source, setSource] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pipeline = active.find((p) => p.id === pipelineId) ?? active[0];
  const openStages = pipeline?.stages.filter((s) => s.kind === 'open') ?? [];

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setValue('');
    setPipelineId(defaultPipelineId ?? active[0]?.id ?? '');
    setStageId(defaultStageId ?? '');
    setAssignee(myUserId);
    setCloseOn('');
    setNextAction('');
    setNextAt('');
    setSource('');
    setErrors({});
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(value);
    if (!title.trim()) return setErrors({ title: 'Give the lead a title.' });
    if (cents === null) return setErrors({ valueCents: 'Enter an amount in dollars.' });
    setBusy(true);
    setErrors({});
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/lead.create', {
          body: {
            workspaceId,
            title: title.trim(),
            personId: record.personId ?? null,
            companyId: record.companyId ?? null,
            pipelineId: pipeline?.id,
            stageId: stageId || undefined,
            valueCents: cents,
            assigneeUserId: assignee || null,
            expectedCloseOn: closeOn || null,
            nextAction: nextAction.trim() || null,
            nextActionAt: nextAt ? new Date(nextAt).toISOString() : null,
            source: source.trim() || null,
          },
        }),
      );
      toast.success(`Lead created in ${pipeline?.name ?? 'the pipeline'}.`);
      onOpenChange(false);
      onCreated?.(out.leadId);
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New lead"
        description={`For ${record.name}. A lead without a next action is flagged on the pipeline.`}
        className="w-[min(560px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-y-auto"
      >
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-3.5"
          noValidate
          data-testid="lead-form"
        >
          <Field label="Title" htmlFor="l-title" error={errors.title}>
            <Input
              id="l-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Roof replacement"
              autoFocus
              invalid={!!errors.title}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Value" htmlFor="l-value" error={errors.valueCents}>
              <Input
                id="l-value"
                inputMode="decimal"
                placeholder="$12,500"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                invalid={!!errors.valueCents}
              />
            </Field>
            <Field label="Assigned to" htmlFor="l-assignee">
              <Select
                id="l-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === myUserId ? `${m.fullName} (you)` : m.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Pipeline" htmlFor="l-pipeline">
              <Select
                id="l-pipeline"
                value={pipeline?.id ?? ''}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setStageId('');
                }}
              >
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Stage" htmlFor="l-stage">
              <Select id="l-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                {openStages.map((s, i) => (
                  <option key={s.id} value={i === 0 ? '' : s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
            <Field
              label="Next action"
              htmlFor="l-next"
              hint="Optional, but the card shows a warning until there is one."
            >
              <Input
                id="l-next"
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                placeholder="Send the estimate"
              />
            </Field>
            <Field label="When" htmlFor="l-next-at">
              <Input
                id="l-next-at"
                type="datetime-local"
                value={nextAt}
                onChange={(e) => setNextAt(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Expected close" htmlFor="l-close">
              <Input
                id="l-close"
                type="date"
                value={closeOn}
                onChange={(e) => setCloseOn(e.target.value)}
              />
            </Field>
            <Field label="Source" htmlFor="l-source">
              <Input
                id="l-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Referral, website, yard sign…"
              />
            </Field>
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="lead-save">
              Create lead
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
