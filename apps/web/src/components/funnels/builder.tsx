'use client';
/**
 * Making and changing a funnel (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "Making one"): the eight steps on
 * the left, the step itself in the middle, and the live map beside it. Clicking a box on the map opens its stage, a
 * message its messages. The funnel is edited here and saved whole; a funnel that's on keeps running, and what's
 * saved reaches the people in it right away.
 */
import {
  FUNNEL_LIMITS,
  FUNNEL_STATUS_WORDS,
  funnelBlocker,
  funnelIssues,
  type FunnelDefinition,
  type FunnelNames,
  type FunnelStage,
} from '@hfos/core';
import { Check, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, errorMessage } from '@/lib/api/client';
import { funnelActions, type FunnelGetOut } from '@/lib/funnels/actions';
import { FUNNEL_STEPS, type FunnelStepKey } from '@/lib/funnels/steps';
import { cn } from '@/lib/utils';
import { EntryEditor, MessageEditor, MovesEditor, newMessage, type StageOption } from './editors';
import { FunnelMap } from './funnel-map';
import { IssueList } from './issues';
import { TryIt } from './try-it';

const STATUS_BADGE: Readonly<Record<FunnelGetOut['funnel']['status'], BadgeVariant>> = {
  on: 'ok',
  paused: 'pending',
  draft: 'gray',
  archived: 'gray',
};

export function FunnelBuilder({
  workspaceId,
  initial,
  initialStep,
  teammateName,
  canManage,
}: {
  workspaceId: string;
  initial: FunnelGetOut;
  initialStep: FunnelStepKey;
  teammateName: string;
  canManage: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const actions = useMemo(() => funnelActions(workspaceId), [workspaceId]);
  const [got, setGot] = useState(initial);
  const [name, setName] = useState(initial.funnel.name);
  const [def, setDef] = useState<FunnelDefinition>(initial.funnel.definition as FunnelDefinition);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'on' | 'pause' | 'archive' | null>(null);
  const [step, setStepState] = useState<FunnelStepKey>(initialStep);
  const [moveFrom, setMoveFrom] = useState<Record<string, string>>({});
  const [addExisting, setAddExisting] = useState(false);
  const back = `/app/w/${workspaceId}/ai-team/funnels`;

  const pipelineStages = got.funnel.stages;
  const inFunnel = useMemo(() => new Set(def.stages.map((s) => s.stageId)), [def.stages]);
  const funnelStages: StageOption[] = pipelineStages.filter((s) => inFunnel.has(s.id));
  const openStages = funnelStages.filter((s) => s.kind === 'open');
  const [stageId, setStageId] = useState<string>(openStages[0]?.id ?? funnelStages[0]?.id ?? '');
  const names: FunnelNames = useMemo(
    () => ({
      stages: new Map(pipelineStages.map((s) => [s.id, s.name])),
      forms: new Map(got.forms.map((f) => [f.id, f.name])),
      calendars: new Map(got.calendars.map((c) => [c.id, c.name])),
    }),
    [pipelineStages, got.forms, got.calendars],
  );
  const issues = useMemo(
    () =>
      funnelIssues(def, {
        pipelineName: got.funnel.pipelineName,
        stages: pipelineStages,
        teammate: got.teammate,
        overlappingWorkflows: got.overlappingWorkflows,
      }),
    [def, got, pipelineStages],
  );
  const blocker = funnelBlocker(issues);
  const status = got.funnel.status;

  const setStep = useCallback((next: FunnelStepKey) => {
    setStepState(next);
    window.history.replaceState(null, '', `?step=${next}`);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (fn: (d: FunnelDefinition) => FunnelDefinition) => {
    setDef((d) => fn(d));
    setDirty(true);
  };
  const updateStage = (sid: string, fn: (s: FunnelStage) => FunnelStage) =>
    update((d) => ({ ...d, stages: d.stages.map((s) => (s.stageId === sid ? fn(s) : s)) }));

  async function save(): Promise<boolean> {
    setBusy('save');
    try {
      await actions.save({
        funnelId: got.funnel.id,
        revision: got.funnel.revision,
        name: name.trim(),
        definition: def,
        moveFrom,
      });
      const fresh = await actions.get(got.funnel.id);
      setGot(fresh);
      setDef(fresh.funnel.definition as FunnelDefinition);
      setName(fresh.funnel.name);
      setMoveFrom({});
      setDirty(false);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'funnel_stage_has_people') setStep('pipeline');
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function turnOn() {
    if (dirty && !(await save())) return;
    setBusy('on');
    try {
      const out = await actions.turnOn(got.funnel.id, addExisting);
      toast.success(
        out.adding
          ? `${name} is on. ${out.adding === 1 ? 'The lead already there joins' : `The ${out.adding} leads already there join`} in a moment.`
          : `${name} is on. ${teammateName} follows it from now.`,
      );
      setGot(await actions.get(got.funnel.id));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function pause() {
    setBusy('pause');
    try {
      await actions.pause(got.funnel.id);
      toast.success(`${name} is paused. Nothing goes out until it’s back on.`);
      setGot(await actions.get(got.funnel.id));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    if (!window.confirm(`Archive ${name}? Everyone in it leaves, and nothing more is sent.`))
      return;
    setBusy('archive');
    try {
      await actions.archive(got.funnel.id);
      toast.success(`${name} is archived.`);
      router.push(back);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  const stepIndex = FUNNEL_STEPS.findIndex((s) => s.key === step);
  const done = (key: FunnelStepKey): boolean => {
    switch (key) {
      case 'describe':
        return !!def.description.trim();
      case 'pipeline':
        return def.stages.length > 0;
      case 'who':
        return def.entry.rules.length > 0 || def.entry.byHand || def.entry.aiSuggests;
      case 'stages':
        return (
          openStages.length > 0 &&
          openStages.every((s) => def.stages.find((x) => x.stageId === s.id)?.goal.trim())
        );
      case 'messages':
        return def.stages.some((s) => s.messages.length > 0);
      case 'wording':
        return true;
      case 'try':
        return false;
      case 'on':
        return status === 'on';
    }
  };

  const onMapSelect = useCallback(
    (sid: string, part: 'stage' | 'messages') => {
      setStageId(sid);
      setStep(part === 'messages' ? 'messages' : 'stages');
    },
    [setStep],
  );

  const stage = def.stages.find((s) => s.stageId === stageId) ?? def.stages[0] ?? null;
  const stageRow = pipelineStages.find((s) => s.id === stage?.stageId);
  const picks = { forms: got.forms, calendars: got.calendars };

  return (
    <div className="flex min-h-[calc(100vh-120px)] flex-col pb-10" data-testid="funnel-builder">
      <header className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <ButtonLink href={back} size="sm" variant="ghost">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Funnels
        </ButtonLink>
        <Input
          aria-label="Funnel name"
          value={name}
          maxLength={80}
          disabled={!canManage}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          inputSize="sm"
          className="w-[240px] font-semibold"
        />
        <Badge variant={STATUS_BADGE[status]}>{FUNNEL_STATUS_WORDS[status]}</Badge>
        <span className="text-[12.5px] text-text-3">
          {dirty
            ? 'Changes not saved yet'
            : `Saved${got.funnel.updatedBy ? ` by ${got.funnel.updatedBy}` : ''}`}
        </span>
        <span className="flex-1" />
        {canManage ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!dirty || (await save())) router.push(back);
              }}
              disabled={busy !== null}
            >
              Save and close
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              loading={busy === 'save'}
              disabled={!dirty}
              data-testid="funnel-save"
            >
              Save
            </Button>
          </>
        ) : null}
      </header>

      <div className="flex flex-wrap items-start gap-6">
        <nav aria-label="Steps" className="w-full flex-none lg:w-[200px]">
          <ol className="flex gap-0.5 overflow-x-auto lg:flex-col">
            {FUNNEL_STEPS.map((s, i) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => setStep(s.key)}
                  aria-current={s.key === step ? 'step' : undefined}
                  className={cn(
                    'flex h-10 w-full items-center gap-2.5 whitespace-nowrap rounded-control px-2.5 text-left text-[13.5px] hover:bg-card-2',
                    s.key === step && 'bg-card-2 font-semibold',
                  )}
                  data-testid={`funnel-step-${s.key}`}
                >
                  <span
                    className={cn(
                      'inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full text-[11.5px] font-semibold',
                      done(s.key)
                        ? 'bg-success-soft text-success-text'
                        : s.key === step
                          ? 'bg-accent text-white'
                          : 'bg-card-2 text-text-2',
                    )}
                  >
                    {done(s.key) ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                  </span>
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section
          className="min-w-0 flex-1 basis-[420px]"
          aria-label={FUNNEL_STEPS[stepIndex]!.label}
        >
          <Card className="flex flex-col gap-4 p-5">
            {step === 'describe' ? (
              <Panel
                title="Describe your funnel"
                lead="Say how people should go from first hearing about you to where you want them. It’s kept with the funnel, for you and for the AI."
              >
                <Field label="How it should go" htmlFor={`${id}-how`}>
                  <Textarea
                    id={`${id}-how`}
                    value={def.description}
                    maxLength={4000}
                    disabled={!canManage}
                    onChange={(e) => update((d) => ({ ...d, description: e.target.value }))}
                    className="min-h-[180px]"
                  />
                </Field>
              </Panel>
            ) : step === 'pipeline' ? (
              <Panel
                title="Its pipeline"
                lead={`${name}’s stages are the ${got.funnel.pipelineName} pipeline’s, so the board always shows where everyone is. Tick the ones the funnel uses.`}
              >
                <ul className="flex flex-col gap-1.5">
                  {pipelineStages.map((s) => {
                    const on = inFunnel.has(s.id);
                    const people = s.people;
                    const wasIn = (initial.funnel.definition as FunnelDefinition).stages.some(
                      (x) => x.stageId === s.id,
                    );
                    const leaving = wasIn && !on && people > 0;
                    return (
                      <li key={s.id} className="rounded-menu border border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            label={s.name}
                            checked={on}
                            disabled={!canManage || (on && def.stages.length <= 1)}
                            onChange={(e) =>
                              update((d) =>
                                e.target.checked
                                  ? {
                                      ...d,
                                      stages: pipelineStages
                                        .filter(
                                          (p) =>
                                            p.id === s.id ||
                                            d.stages.some((x) => x.stageId === p.id),
                                        )
                                        .map(
                                          (p) =>
                                            d.stages.find((x) => x.stageId === p.id) ?? {
                                              stageId: p.id,
                                              goal: '',
                                              knows: '',
                                              moves: [],
                                              messages: [],
                                              handOff: false,
                                            },
                                        ),
                                    }
                                  : {
                                      ...d,
                                      stages: d.stages
                                        .filter((x) => x.stageId !== s.id)
                                        .map((x) => ({
                                          ...x,
                                          moves: x.moves.filter((m) => m.to !== s.id),
                                        })),
                                      entry:
                                        d.entry.startStageId === s.id
                                          ? { ...d.entry, startStageId: null }
                                          : d.entry,
                                    },
                              )
                            }
                          />
                          <span className="text-[12px] text-text-3">
                            {s.kind === 'open' ? '' : s.kind}
                          </span>
                          <span className="flex-1" />
                          {people ? (
                            <span className="text-[12px] text-text-2">{people} here now</span>
                          ) : null}
                        </div>
                        {leaving ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
                            <span className="text-text-2">
                              Their {people === 1 ? 'person goes' : `${people} people go`} to
                            </span>
                            <Select
                              selectSize="sm"
                              value={moveFrom[s.id] ?? ''}
                              aria-label={`Where the people at ${s.name} go`}
                              onChange={(e) =>
                                setMoveFrom((m) => ({ ...m, [s.id]: e.target.value }))
                              }
                              className="w-[200px]"
                            >
                              <option value="">Pick a stage</option>
                              {openStages.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                </option>
                              ))}
                            </Select>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <Hint>
                  To add, rename or reorder stages, change the pipeline in Settings → Pipelines. A
                  funnel holds up to {FUNNEL_LIMITS.stages} stages.
                </Hint>
              </Panel>
            ) : step === 'who' ? (
              <Panel
                title="Who gets in"
                lead="The rules that bring people in, and the two other ways in. Someone in another funnel leaves it first: a person is in one funnel at a time."
              >
                <EntryEditor
                  entry={def.entry}
                  onChange={(entry) => update((d) => ({ ...d, entry }))}
                  stages={funnelStages}
                  picks={picks}
                  pipelineName={got.funnel.pipelineName}
                  teammateName={teammateName}
                />
              </Panel>
            ) : step === 'stages' && stage ? (
              <Panel
                title="The stages"
                lead="What each stage is for, what the teammate should know there, and what moves someone on."
              >
                <StagePicker stages={funnelStages} current={stage.stageId} onPick={setStageId} />
                {stageRow?.kind !== 'open' ? (
                  <p className="text-[13px] text-text-2">
                    People leave the funnel when they reach {stageRow?.name}: it’s a{' '}
                    {stageRow?.kind} stage.
                  </p>
                ) : (
                  <>
                    <Field
                      label="Its goal"
                      htmlFor={`${id}-goal`}
                      hint="One line: what should happen at this stage."
                    >
                      <Input
                        id={`${id}-goal`}
                        value={stage.goal}
                        maxLength={300}
                        onChange={(e) =>
                          updateStage(stage.stageId, (s) => ({ ...s, goal: e.target.value }))
                        }
                        placeholder="Get them to the presentation, on time and able to hear it."
                      />
                    </Field>
                    <Field
                      label={`What ${teammateName} should know here`}
                      htmlFor={`${id}-knows`}
                      hint="Talking points it reads only while someone is at this stage."
                    >
                      <Textarea
                        id={`${id}-knows`}
                        value={stage.knows}
                        maxLength={1000}
                        onChange={(e) =>
                          updateStage(stage.stageId, (s) => ({ ...s, knows: e.target.value }))
                        }
                        className="min-h-[72px]"
                      />
                    </Field>
                    <div>
                      <Label>Moves on when</Label>
                      <MovesEditor
                        stageId={stage.stageId}
                        moves={stage.moves}
                        onChange={(moves) => updateStage(stage.stageId, (s) => ({ ...s, moves }))}
                        stages={funnelStages}
                        picks={picks}
                      />
                    </div>
                    <div className="flex items-start gap-3">
                      <Switch
                        checked={stage.handOff}
                        onChange={(handOff) =>
                          updateStage(stage.stageId, (s) => ({ ...s, handOff }))
                        }
                        label="Hand off to the team"
                      />
                      <div>
                        <div className="text-[13.5px] font-medium">Then hand them to the team</div>
                        <Hint>
                          After this stage’s first messages, your team takes the conversation. The
                          funnel waits until it’s handed back.
                        </Hint>
                      </div>
                    </div>
                  </>
                )}
              </Panel>
            ) : step === 'messages' && stage ? (
              <Panel
                title="The messages"
                lead="Each one goes out when its time comes, if they’re still at this stage. Times around a booking follow it, so a new night moves them."
              >
                <StagePicker stages={funnelStages} current={stage.stageId} onPick={setStageId} />
                {stageRow?.kind !== 'open' ? (
                  <p className="text-[13px] text-text-2">
                    People leave the funnel at {stageRow?.name}, so it sends nothing.
                  </p>
                ) : (
                  <>
                    {stage.goal ? (
                      <p className="text-[13px] text-text-2">Goal: {stage.goal}</p>
                    ) : null}
                    {stage.messages.length === 0 ? (
                      <p className="text-[13px] text-text-2">No messages at this stage yet.</p>
                    ) : null}
                    {stage.messages.map((m) => (
                      <MessageEditor
                        key={m.id}
                        message={m}
                        teammateName={teammateName}
                        onChange={(next) =>
                          updateStage(stage.stageId, (s) => ({
                            ...s,
                            messages: s.messages.map((x) => (x.id === m.id ? next : x)),
                          }))
                        }
                        onRemove={() =>
                          updateStage(stage.stageId, (s) => ({
                            ...s,
                            messages: s.messages.filter((x) => x.id !== m.id),
                          }))
                        }
                      />
                    ))}
                    <div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={stage.messages.length >= FUNNEL_LIMITS.messages}
                        onClick={() =>
                          updateStage(stage.stageId, (s) => ({
                            ...s,
                            messages: [...s.messages, newMessage(def.wording)],
                          }))
                        }
                        data-testid="funnel-message-add"
                      >
                        <Plus className="h-4 w-4" aria-hidden />
                        Add a message
                      </Button>
                    </div>
                  </>
                )}
              </Panel>
            ) : step === 'wording' ? (
              <Panel
                title="Wording and approvals"
                lead="Who writes the messages by default, and whether they wait for an OK."
              >
                <div>
                  <Label>Who writes the messages</Label>
                  <div
                    role="radiogroup"
                    aria-label="Who writes the messages"
                    className="flex flex-wrap gap-2"
                  >
                    <RadioCard
                      selected={def.wording === 'ai'}
                      onSelect={() => update((d) => ({ ...d, wording: 'ai' }))}
                      title={`${teammateName} writes them`}
                      description={`From what you say each message should do, in ${teammateName}’s voice.`}
                    />
                    <RadioCard
                      selected={def.wording === 'exact'}
                      onSelect={() => update((d) => ({ ...d, wording: 'exact' }))}
                      title="Your exact words"
                      description="Sent as you wrote them, with the name, time and Join link filled in."
                    />
                  </div>
                  <Hint>
                    The default for new messages. Any message can still be set the other way.
                  </Hint>
                </div>
                <div>
                  <Label>Before a message goes out</Label>
                  <div
                    role="radiogroup"
                    aria-label="Before a message goes out"
                    className="flex flex-col gap-2"
                  >
                    <RadioCard
                      selected={def.approval === 'teammate'}
                      onSelect={() => update((d) => ({ ...d, approval: 'teammate' }))}
                      title="Like the teammate"
                      description={`Waits for an OK while ${teammateName} is in training wheels, then goes on its own.`}
                    />
                    <RadioCard
                      selected={def.approval === 'ask'}
                      onSelect={() => update((d) => ({ ...d, approval: 'ask' }))}
                      title="Always ask first"
                      description={`Every message waits on Approvals, even once ${teammateName} is automatic.`}
                    />
                    <RadioCard
                      selected={def.approval === 'send'}
                      onSelect={() => update((d) => ({ ...d, approval: 'send' }))}
                      title="Send on their own"
                      description="No OK needed, even in training wheels."
                    />
                  </div>
                </div>
              </Panel>
            ) : step === 'try' ? (
              <Panel
                title="Try it as a lead"
                lead="Play a pretend lead through the funnel. At each fork, pick what they do, and see each message and when it would go. Nothing is sent."
              >
                <TryIt
                  definition={def}
                  stages={pipelineStages}
                  names={names}
                  timeZone={got.timeZone}
                  businessName={got.businessName}
                  teammateName={teammateName}
                />
              </Panel>
            ) : step === 'on' ? (
              <Panel
                title="Turn it on"
                lead="Red items stop it from turning on. Yellow ones only warn."
              >
                <IssueList issues={issues} />
                {status !== 'on' && got.waiting > 0 ? (
                  <Checkbox
                    label={`Also add the ${got.waiting === 1 ? 'lead' : `${got.waiting} leads`} already in ${got.funnel.pipelineName}`}
                    checked={addExisting}
                    onChange={(e) => setAddExisting(e.target.checked)}
                  />
                ) : null}
                {status !== 'on' && got.waiting > 0 ? (
                  <Hint>
                    Each starts at the stage they’re in now, with that stage’s messages from now on.
                  </Hint>
                ) : null}
                {canManage ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {status === 'on' ? (
                      <Button
                        variant="secondary"
                        onClick={() => void pause()}
                        loading={busy === 'pause'}
                        data-testid="funnel-pause"
                      >
                        Pause {name}
                      </Button>
                    ) : (
                      <Button
                        onClick={() => void turnOn()}
                        loading={busy === 'on'}
                        disabled={!!blocker}
                        data-testid="funnel-turn-on"
                      >
                        Turn on {name}
                      </Button>
                    )}
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      onClick={() => void archive()}
                      loading={busy === 'archive'}
                    >
                      Archive it
                    </Button>
                  </div>
                ) : null}
                <Hint>You can pause it any time, for everyone or for one person.</Hint>
              </Panel>
            ) : null}
            <div className="flex items-center gap-2 border-t border-border pt-4">
              {stepIndex > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep(FUNNEL_STEPS[stepIndex - 1]!.key)}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                  Back
                </Button>
              ) : null}
              <span className="flex-1" />
              {stepIndex < FUNNEL_STEPS.length - 1 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setStep(FUNNEL_STEPS[stepIndex + 1]!.key)}
                >
                  Next: {FUNNEL_STEPS[stepIndex + 1]!.label}
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          </Card>
        </section>

        <aside className="w-full flex-none xl:sticky xl:top-4 xl:w-[440px]" aria-label="Map">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[13.5px] font-semibold">Map</h2>
            <span className="text-[12px] text-text-3">Click any box to change it</span>
          </div>
          <FunnelMap
            definition={def}
            stages={pipelineStages}
            names={names}
            counts={status !== 'draft'}
            selectedStageId={
              step === 'stages' || step === 'messages' ? (stage?.stageId ?? null) : null
            }
            onSelect={onMapSelect}
            className="h-[640px]"
          />
        </aside>
      </div>
    </div>
  );
}

function Panel({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <>
      <div>
        <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-[13px] text-text-2">{lead}</p>
      </div>
      {children}
    </>
  );
}

function StagePicker({
  stages,
  current,
  onPick,
}: {
  stages: readonly StageOption[];
  current: string;
  onPick: (id: string) => void;
}) {
  const i = stages.findIndex((s) => s.id === current);
  const prev = stages[i - 1];
  const next = stages[i + 1];
  return (
    <div className="flex items-center gap-2 rounded-menu bg-card-2 p-1.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={!prev}
        onClick={() => prev && onPick(prev.id)}
        aria-label="Previous stage"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {prev?.name ?? ''}
      </Button>
      <span className="flex-1 text-center text-[13.5px] font-semibold">
        {stages[i]?.name}
        <span className="ml-2 text-[12px] font-normal text-text-3">
          Stage {i + 1} of {stages.length}
        </span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={!next}
        onClick={() => next && onPick(next.id)}
        aria-label="Next stage"
      >
        {next?.name ?? ''}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
