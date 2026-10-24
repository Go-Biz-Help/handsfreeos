'use client';
/**
 * New funnel (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, steps 1 and 2): what to call it, how it should go,
 * and its pipeline: one the business has (that runs no funnel yet), or a new one made from the stages typed here.
 * The funnel starts as a draft with a stage for each of the pipeline's, and the steps open on who gets in.
 */
import { ArrowDown, ArrowUp, ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/client';
import { funnelActions, type PipelineOut } from '@/lib/funnels/actions';

type Kind = 'open' | 'won' | 'lost';
interface StageDraft {
  readonly key: string;
  readonly name: string;
  readonly kind: Kind;
}

const KIND_WORDS: Readonly<Record<Kind, string>> = { open: 'Open', won: 'Won', lost: 'Lost' };

let keySeq = 0;
const stageDraft = (name: string, kind: Kind): StageDraft => ({ key: `s${keySeq++}`, name, kind });
const STARTER: readonly StageDraft[] = [
  stageDraft('New lead', 'open'),
  stageDraft('Talking', 'open'),
  stageDraft('Booked', 'open'),
  stageDraft('Won', 'won'),
  stageDraft('Lost', 'lost'),
];

export function NewFunnel({
  workspaceId,
  pipelines,
  takenPipelineIds,
}: {
  workspaceId: string;
  pipelines: readonly PipelineOut[];
  /** Pipelines that already run a funnel: a pipeline runs one. */
  takenPipelineIds: readonly string[];
}) {
  const id = useId();
  const router = useRouter();
  const actions = useMemo(() => funnelActions(workspaceId), [workspaceId]);
  const free = pipelines.filter((p) => !p.archivedAt && !takenPipelineIds.includes(p.id));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [which, setWhich] = useState<'have' | 'new'>(free.length ? 'have' : 'new');
  const [pipelineId, setPipelineId] = useState(free[0]?.id ?? '');
  const [stages, setStages] = useState<readonly StageDraft[]>(STARTER);
  const [busy, setBusy] = useState(false);
  const back = `/app/w/${workspaceId}/ai-team/funnels`;

  const kinds = new Set(stages.map((s) => s.kind));
  const stagesOk =
    stages.length >= 3 &&
    stages.length <= 12 &&
    kinds.has('open') &&
    kinds.has('won') &&
    kinds.has('lost') &&
    stages.every((s) => s.name.trim()) &&
    new Set(stages.map((s) => s.name.trim().toLowerCase())).size === stages.length;
  const ready = name.trim() && (which === 'have' ? !!pipelineId : stagesOk);

  async function create() {
    setBusy(true);
    try {
      const made = await actions.create({
        name: name.trim(),
        description: description.trim() || undefined,
        ...(which === 'have'
          ? { pipelineId }
          : {
              newPipeline: {
                name: name.trim(),
                stages: stages.map((s) => ({ name: s.name.trim(), kind: s.kind })),
              },
            }),
      });
      router.push(`${back}/${made.funnelId}?step=who`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  const move = (i: number, by: -1 | 1) =>
    setStages((now) => {
      const next = [...now];
      const [s] = next.splice(i, 1);
      next.splice(i + by, 0, s!);
      return next;
    });

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-3 pb-10" data-testid="funnel-new-page">
      <div className="flex items-center gap-2">
        <ButtonLink href={back} size="sm" variant="ghost">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Funnels
        </ButtonLink>
        <h1 className="text-[18px] font-semibold tracking-tight">New funnel</h1>
      </div>
      <Card className="flex flex-col gap-4 p-5">
        <Field label="What to call it" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            placeholder="Like “Recruiting” or “Estimate follow-up”"
            onChange={(e) => setName(e.target.value)}
            data-testid="funnel-new-name"
          />
        </Field>
        <Field
          label="How it should go"
          htmlFor={`${id}-how`}
          hint="Say how people should go from first hearing about you to where you want them. You set up each part in the next steps."
        >
          <Textarea
            id={`${id}-how`}
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-[96px]"
            placeholder="New leads get a text with a link to start. Qualified people book a presentation. We remind them before, check they could log on, then ask if they’re in."
          />
        </Field>
      </Card>
      <Card className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="text-[15px] font-semibold">Its pipeline</h2>
          <p className="mt-1 text-[13px] text-text-2">
            A funnel’s stages are a pipeline’s stages, so the board always shows where everyone is.
            A pipeline runs one funnel.
          </p>
        </div>
        <div role="radiogroup" aria-label="Its pipeline" className="flex flex-wrap gap-2">
          <RadioCard
            selected={which === 'have'}
            onSelect={() => setWhich('have')}
            title="Use one I have"
            description={
              free.length
                ? 'Its stages become the funnel’s.'
                : 'Every pipeline runs a funnel already.'
            }
          />
          <RadioCard
            selected={which === 'new'}
            onSelect={() => setWhich('new')}
            title="Make a new pipeline"
            description="From the stages you type below."
            testId="funnel-new-pipeline"
          />
        </div>
        {which === 'have' ? (
          free.length ? (
            <Field label="Pipeline" htmlFor={`${id}-pipe`}>
              <Select
                id={`${id}-pipe`}
                value={pipelineId}
                onChange={(e) => setPipelineId(e.target.value)}
              >
                {free.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.stages.length} stages
                  </option>
                ))}
              </Select>
            </Field>
          ) : null
        ) : (
          <div>
            <Label>Its stages, in order</Label>
            <ol className="flex flex-col gap-1.5">
              {stages.map((s, i) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className="w-5 text-right text-[12px] tabular-nums text-text-3">
                    {i + 1}
                  </span>
                  <Input
                    value={s.name}
                    maxLength={60}
                    aria-label={`Stage ${i + 1}`}
                    onChange={(e) =>
                      setStages((now) =>
                        now.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    className="flex-1"
                  />
                  <Select
                    value={s.kind}
                    aria-label={`What stage ${i + 1} is`}
                    onChange={(e) =>
                      setStages((now) =>
                        now.map((x) =>
                          x.key === s.key ? { ...x, kind: e.target.value as Kind } : x,
                        ),
                      )
                    }
                    className="w-[110px]"
                  >
                    {(['open', 'won', 'lost'] as const).map((k) => (
                      <option key={k} value={k}>
                        {KIND_WORDS[k]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={i === stages.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${s.name || 'this stage'}`}
                    disabled={stages.length <= 3}
                    onClick={() => setStages((now) => now.filter((x) => x.key !== s.key))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ol>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={stages.length >= 12}
                onClick={() =>
                  setStages((now) => {
                    const at = now.findIndex((s) => s.kind !== 'open');
                    const next = [...now];
                    next.splice(at < 0 ? now.length : at, 0, stageDraft('', 'open'));
                    return next;
                  })
                }
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add a stage
              </Button>
              <span className="text-[12px] text-text-3">
                {stagesOk
                  ? `${stages.length} of 12`
                  : 'Each stage needs its own name, and the pipeline needs an open, a won and a lost stage.'}
              </span>
            </div>
          </div>
        )}
      </Card>
      <div className="flex justify-end gap-2">
        <ButtonLink href={back} variant="ghost">
          Cancel
        </ButtonLink>
        <Button
          onClick={() => void create()}
          loading={busy}
          disabled={!ready}
          data-testid="funnel-new-create"
        >
          Next: who gets in
        </Button>
      </div>
    </div>
  );
}
