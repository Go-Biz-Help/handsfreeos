'use client';
/**
 * New funnel (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, steps 1 and 2): how it should go, what to call it,
 * and its pipeline: one the business has (that runs no funnel yet), or a new one made from the stages typed here.
 * "Describe it, AI drafts" comes first: the teammate drafts the stages, the moves and the messages from the words,
 * shown on the map before anything is kept. "Set it up myself" starts it empty instead, with a stage for each of the
 * pipeline's. Either way it starts as a draft, and the steps open on who gets in.
 */
import {
  definitionFromDraft,
  draftOnStages,
  funnelEntryWords,
  matchDraftStages,
  type FunnelDraft,
} from '@hfos/core';
import { ArrowDown, ArrowUp, ChevronLeft, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/client';
import { funnelActions, type PipelineOut } from '@/lib/funnels/actions';
import { FunnelMap, type MapStage } from './funnel-map';

type Kind = 'open' | 'won' | 'lost';
interface StageDraft {
  /** Shaped as an id, so the draft's map can draw a new pipeline's stages before they exist. */
  readonly key: string;
  readonly name: string;
  readonly kind: Kind;
  /** The draft stage it came from, so a rename keeps its moves and messages. */
  readonly from: string | null;
}

const KIND_WORDS: Readonly<Record<Kind, string>> = { open: 'Open', won: 'Won', lost: 'Lost' };
/** What the worker takes: shorter and the model has too little to go on. */
const DESCRIBE_MIN = 20;

let keySeq = 0;
const stageDraft = (name: string, kind: Kind, from: string | null = null): StageDraft => ({
  key: `00000000-0000-4000-8000-${String(++keySeq).padStart(12, '0')}`,
  name,
  kind,
  from,
});
const STARTER: readonly StageDraft[] = [
  stageDraft('New lead', 'open'),
  stageDraft('Talking', 'open'),
  stageDraft('Booked', 'open'),
  stageDraft('Won', 'won'),
  stageDraft('Lost', 'lost'),
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function NewFunnel({
  workspaceId,
  teammateName,
  pipelines,
  takenPipelineIds,
}: {
  workspaceId: string;
  /** Who drafts it: the teammate's name. */
  teammateName: string;
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
  const [draft, setDraft] = useState<FunnelDraft | null>(null);
  /** What the draft was made from, so a changed description says to draft it again. */
  const [draftedFrom, setDraftedFrom] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'empty' | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const back = `/app/w/${workspaceId}/ai-team/funnels`;
  const pipeline = free.find((p) => p.id === pipelineId) ?? null;

  const kinds = new Set(stages.map((s) => s.kind));
  const stagesOk =
    stages.length >= 3 &&
    stages.length <= 12 &&
    kinds.has('open') &&
    kinds.has('won') &&
    kinds.has('lost') &&
    stages.every((s) => s.name.trim()) &&
    new Set(stages.map((s) => s.name.trim().toLowerCase())).size === stages.length;
  const pipelineOk = which === 'have' ? !!pipeline : stagesOk;
  const canDraft = description.trim().length >= DESCRIBE_MIN && (which === 'new' || !!pipeline);

  /** The draft on the stages it will have: the pipeline's, or the ones typed here since it came. */
  const shaped = useMemo(() => {
    if (!draft) return null;
    if (which === 'new') {
      if (!stagesOk) return null;
      const d = draftOnStages(
        draft,
        stages.map((s) => ({ from: s.from, name: s.name, kind: s.kind })),
      );
      const on: MapStage[] = stages.map((s) => ({ id: s.key, name: s.name.trim(), kind: s.kind }));
      return { draft: d, stages: on, definition: definitionFromDraft(d, matchDraftStages(d, on)) };
    }
    if (!pipeline) return null;
    const on: MapStage[] = pipeline.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
    return {
      draft,
      stages: on,
      definition: definitionFromDraft(draft, matchDraftStages(draft, pipeline.stages)),
    };
  }, [draft, which, stages, stagesOk, pipeline]);
  const names = useMemo(
    () => ({ stages: new Map((shaped?.stages ?? []).map((s) => [s.id, s.name])) }),
    [shaped],
  );

  async function makeDraft() {
    setDrafting(true);
    try {
      const said = description.trim();
      const { draft: d } = await actions.draft(
        said,
        which === 'have' ? (pipeline?.id ?? undefined) : undefined,
      );
      setDraft(d);
      setDraftedFrom(said);
      if (!name.trim()) setName(d.name);
      // A new pipeline takes the draft's stages; the person can still rename, reorder or add to them.
      if (which === 'new') setStages(d.stages.map((s) => stageDraft(s.name, s.kind, s.name)));
      setTimeout(() => preview.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDrafting(false);
    }
  }

  async function create(useDraft: boolean) {
    const funnelName = name.trim() || (useDraft && draft ? draft.name : '');
    if (!funnelName) return;
    setBusy(useDraft ? 'draft' : 'empty');
    try {
      const made = await actions.create({
        name: funnelName,
        description: description.trim() || undefined,
        ...(useDraft && shaped ? { draft: shaped.draft } : {}),
        ...(which === 'have'
          ? { pipelineId }
          : {
              newPipeline: {
                name: funnelName,
                stages: stages.map((s) => ({ name: s.name.trim(), kind: s.kind })),
              },
            }),
      });
      router.push(`${back}/${made.funnelId}?step=who`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  /** A draft made on one pipeline doesn't fit another: picking again drops it. */
  function pick(next: { which?: 'have' | 'new'; pipelineId?: string }) {
    if (next.which) setWhich(next.which);
    if (next.pipelineId !== undefined) setPipelineId(next.pipelineId);
    setDraft(null);
  }

  const move = (i: number, by: -1 | 1) =>
    setStages((now) => {
      const next = [...now];
      const [s] = next.splice(i, 1);
      next.splice(i + by, 0, s!);
      return next;
    });

  const messages = shaped?.definition.stages.reduce((n, s) => n + s.messages.length, 0) ?? 0;
  const moves = shaped?.definition.stages.reduce((n, s) => n + s.moves.length, 0) ?? 0;
  const inFunnel = shaped?.definition.stages.length ?? 0;
  const stale = !!draft && description.trim() !== draftedFrom;

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-3 pb-10" data-testid="funnel-new-page">
      <div className="flex items-center gap-2">
        <ButtonLink href={back} size="sm" variant="ghost">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Funnels
        </ButtonLink>
        <h1 className="text-[18px] font-semibold tracking-tight">New funnel</h1>
      </div>
      <Card className="flex flex-col gap-4 p-5">
        <Field
          label="How it should go"
          htmlFor={`${id}-how`}
          hint={`Say it the way you’d tell someone new on the team: how people should go from first hearing about you to where you want them, and what to send them on the way. ${teammateName} drafts the stages, the messages and when they go. You check every part before anything goes out.`}
        >
          <Textarea
            id={`${id}-how`}
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-[120px]"
            placeholder="New leads get a text with a link to start. Qualified people book a presentation. We remind them the day before and an hour before, check they could log on, then ask if they’re in."
            data-testid="funnel-new-description"
          />
        </Field>
        <Field label="What to call it" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            placeholder={draft ? draft.name : 'Like “Recruiting” or “Estimate follow-up”'}
            onChange={(e) => setName(e.target.value)}
            data-testid="funnel-new-name"
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
            onSelect={() => pick({ which: 'have' })}
            title="Use one I have"
            description={
              free.length
                ? 'Its stages become the funnel’s.'
                : 'Every pipeline runs a funnel already.'
            }
          />
          <RadioCard
            selected={which === 'new'}
            onSelect={() => pick({ which: 'new' })}
            title="Make a new pipeline"
            description={
              draft ? 'From the draft’s stages, as you leave them below.' : 'From the stages below.'
            }
            testId="funnel-new-pipeline"
          />
        </div>
        {which === 'have' ? (
          free.length ? (
            <Field label="Pipeline" htmlFor={`${id}-pipe`}>
              <Select
                id={`${id}-pipe`}
                value={pipelineId}
                onChange={(e) => pick({ pipelineId: e.target.value })}
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
      {draft ? (
        <div ref={preview} className="scroll-mt-4">
          <Card className="flex flex-col gap-3 p-5" data-testid="funnel-new-draft">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">{teammateName}’s draft</h2>
                <p className="mt-1 text-[13px] text-text-2">
                  {shaped
                    ? `${count(inFunnel, 'stage', 'stages')} · ${count(messages, 'message', 'messages')} · ${count(moves, 'move', 'moves')}. Nothing is kept until you use it, and nothing goes out until you turn it on. You can change every part in the steps.`
                    : 'Fix the stages above to see the draft on them.'}
                </p>
                {stale ? (
                  <p className="mt-1 text-[12.5px] text-warning-text">
                    You changed how it should go since. Draft it again to use the new words.
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void makeDraft()}
                loading={drafting}
                disabled={!canDraft || !!busy}
              >
                Draft it again
              </Button>
            </div>
            {shaped ? (
              <>
                <FunnelMap
                  definition={shaped.definition}
                  stages={shaped.stages}
                  names={names}
                  className="h-[480px]"
                />
                <div className="text-[13px]">
                  <span className="font-medium">Who gets in: </span>
                  <span className="text-text-2">
                    {[
                      ...shaped.definition.entry.rules.map((r) =>
                        funnelEntryWords(
                          r,
                          which === 'have' ? (pipeline?.name ?? '') : name.trim() || draft.name,
                        ),
                      ),
                      ...(shaped.definition.entry.byHand ? ['anyone your team adds'] : []),
                      ...(shaped.definition.entry.aiSuggests
                        ? [`people ${teammateName} suggests, once someone says yes`]
                        : []),
                    ].join(', ') || 'Nobody yet. You pick who in the next step.'}
                  </span>
                </div>
              </>
            ) : null}
          </Card>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ButtonLink href={back} variant="ghost">
          Cancel
        </ButtonLink>
        <Button
          variant="secondary"
          onClick={() => void create(false)}
          loading={busy === 'empty'}
          disabled={!name.trim() || !pipelineOk || !!busy || drafting}
          data-testid="funnel-new-create"
        >
          Set it up myself
        </Button>
        {draft && shaped ? (
          <Button
            onClick={() => void create(true)}
            loading={busy === 'draft'}
            disabled={!pipelineOk || !!busy || drafting}
            data-testid="funnel-new-use-draft"
          >
            Use this draft
          </Button>
        ) : (
          <Button
            onClick={() => void makeDraft()}
            loading={drafting}
            disabled={!canDraft || !!busy}
            data-testid="funnel-new-draft-it"
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            {drafting ? `${teammateName} is drafting it…` : `Draft it with ${teammateName}`}
          </Button>
        )}
      </div>
      {!draft && !canDraft && description.trim().length > 0 ? (
        <p className="text-right text-[12px] text-text-3">
          Say a little more about how it should go, and {teammateName} can draft it.
        </p>
      ) : null}
    </div>
  );
}
