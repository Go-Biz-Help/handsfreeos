/**
 * Funnels, as AI teammate → Funnels shows them and says their changes.
 *
 * - read_funnel_get answers with the funnel whole while it fits, with its rules, messages and moves in the builder's
 *   words; a funnel too long for that comes as an outline, and `stageId` reads one stage whole, whatever the rest.
 * - Making, saving, turning on, pausing and archiving one are drawn on cards of their own, as the builder says them:
 *   the funnel by name, the stages, messages and moves that change in words and never as ids, and a caution on what
 *   reaches customers. They stay screen actions (coverage.ts), keyed by their commands' own names.
 */
import {
  FUNNEL_STATUS_WORDS,
  FunnelDefinition,
  funnelArchive,
  funnelCreate,
  funnelEntryWords,
  funnelGet,
  funnelMoveWords,
  funnelOnlyIfWords,
  funnelPause,
  funnelSave,
  funnelTurnOn,
  funnelWhenWords,
  HfosError,
  type FunnelApproval,
  type FunnelEntryRule,
  type FunnelGetOutput,
  type FunnelMessage,
  type FunnelMove,
  type FunnelNames,
  type FunnelStage,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { z } from 'zod';
import type { ToolContext } from './runtime';
import { query } from './tools-read';
import { settingsCard } from './tools-settings-calendar';
import type { ScreenActionCard } from './tools-workflow';

type Got = z.infer<typeof FunnelGetOutput>;

/** The most of a funnel, in characters of JSON, read whole: under what a screen's read holds (tools-screen-reads.ts). */
const WHOLE = 15_000;

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The pipeline's stages, and the business's forms and calendars, by name. */
function namesOf(got: Got): FunnelNames {
  return {
    stages: new Map(got.funnel.stages.map((s) => [s.id, s.name])),
    forms: new Map(got.forms.map((f) => [f.id, f.name])),
    calendars: new Map(got.calendars.map((c) => [c.id, c.name])),
  };
}

const stageNamed = (names: FunnelNames, id: string) =>
  names.stages.get(id) ?? 'a stage that’s gone';

const HOW: Readonly<Record<FunnelMessage['how'], string | null>> = {
  text: 'by text',
  email: 'by email',
  best: null,
};

/** Where a funnel stands, in a sentence: "It’s still a draft". */
const STANDS: Readonly<Record<Got['funnel']['status'], string>> = {
  draft: 'still a draft',
  on: 'on',
  paused: 'paused',
  archived: 'archived',
};

/** Before a message goes out, as the builder's Wording and approvals step says it. */
const APPROVAL_WORDS: Readonly<Record<FunnelApproval, string>> = {
  teammate: 'like the AI teammate (it waits for an OK while it’s on training wheels)',
  ask: 'always ask first, on Approvals',
  send: 'send on their own, with no OK',
};

/** "The day before, at 4:00 PM, only if they haven’t joined, by text (exact words): “See you tomorrow…”". */
export function funnelMessageWords(m: FunnelMessage, most = 160): string {
  const when = [
    funnelWhenWords(m.when),
    m.onlyIf ? funnelOnlyIfWords(m.onlyIf).replace(/^Only/, 'only') : null,
    HOW[m.how],
  ]
    .filter(Boolean)
    .join(', ');
  return `${when}${m.wording === 'exact' ? ' (exact words)' : ''}: “${clip(m.text, most)}”`;
}

const moveWords = (m: FunnelMove, names: FunnelNames) => funnelMoveWords(m, names);

/** The funnel without its steps: its name, status, pipeline, revision and who's in it. */
function summaryOf(got: Got) {
  const f = got.funnel;
  return {
    id: f.id,
    name: f.name,
    status: FUNNEL_STATUS_WORDS[f.status],
    pipeline: f.pipelineName,
    pipelineId: f.pipelineId,
    revision: f.revision,
    people: f.people,
    paused: f.paused,
    suggestions: f.suggestions,
    updatedAt: f.updatedAt,
    updatedBy: f.updatedBy,
  };
}

/** Who gets in, in the builder's words. */
function entryWords(got: Got, names: FunnelNames) {
  const e = got.funnel.definition.entry;
  return {
    rules: e.rules.map((r) => funnelEntryWords(r, got.funnel.pipelineName, names)),
    addedByHand: e.byHand,
    teammateSuggests: e.aiSuggests,
    startsAt: e.startStageId
      ? stageNamed(names, e.startStageId)
      : 'the pipeline’s first open stage',
  };
}

/** One stage of the funnel, whole, with its pipeline stage's name and its messages and moves in words. */
function stageWhole(stage: FunnelStage, got: Got, names: FunnelNames) {
  const row = got.funnel.stages.find((s) => s.id === stage.stageId);
  return {
    ...stage,
    name: row?.name ?? stageNamed(names, stage.stageId),
    kind: row?.kind ?? null,
    people: row?.people ?? 0,
    inWords: {
      messages: stage.messages.map((m) => `${m.id}: ${funnelMessageWords(m, 80)}`),
      moves: stage.moves.map((m) => `${m.id}: ${moveWords(m, names)}`),
    },
  };
}

/** What the rest of the builder shows: what stops it going on, the pickers, and the leads Turn on may take in. */
const restOf = (got: Got) => ({
  issues: got.issues,
  forms: got.forms,
  calendars: got.calendars,
  teammate: got.teammate,
  timeZone: got.timeZone,
  businessName: got.businessName,
  overlappingWorkflows: got.overlappingWorkflows,
  waiting: got.waiting,
});

/**
 * funnel.get as the model reads it: the funnel whole while it fits (its definition as do_funnel_save takes it back,
 * and the same in words); else an outline, each message cut short; or, with `stageId`, that one stage whole.
 */
export function funnelRead(raw: unknown, stageId: unknown): unknown {
  const got = raw as Got;
  const names = namesOf(got);
  const def = got.funnel.definition;
  if (typeof stageId === 'string' && stageId) {
    const stage = def.stages.find((s) => s.stageId === stageId);
    if (!stage) {
      const row = got.funnel.stages.find((s) => s.id === stageId);
      throw HfosError.notFound(
        row
          ? `${row.name} is in ${got.funnel.pipelineName} but not in ${got.funnel.name} yet. Read the funnel without a stage to see the ones it uses.`
          : `That stage isn’t in ${got.funnel.pipelineName}. Read the funnel without a stage to see its stages.`,
      );
    }
    return {
      funnel: summaryOf(got),
      stage: stageWhole(stage, got, names),
      note: `${stageNamed(names, stageId)} whole, as the builder’s Stages step shows it. do_funnel_save takes the whole definition, so keep every other stage as the funnel has it.`,
    };
  }
  const whole = {
    ...got,
    inWords: {
      entry: entryWords(got, names),
      stages: def.stages.map((s) => ({
        stageId: s.stageId,
        name: stageNamed(names, s.stageId),
        messages: s.messages.map((m) => `${m.id}: ${funnelWhenWords(m.when)}`),
        moves: s.moves.map((m) => `${m.id}: ${moveWords(m, names)}`),
      })),
      wording: def.wording === 'exact' ? 'Your exact words' : 'The AI teammate writes them',
      beforeAMessageGoesOut: APPROVAL_WORDS[def.approval],
    },
  };
  if (JSON.stringify(whole).length <= WHOLE) return whole;
  const inFunnel = new Set(def.stages.map((s) => s.stageId));
  return {
    note: 'This funnel is too long to read whole, so this is its outline: each message is cut short, and so is what the AI teammate knows at a stage. Read one stage whole with stageId. do_funnel_save takes the whole definition back, so read every stage whole before saving.',
    funnel: summaryOf(got),
    entry: { ...def.entry, inWords: entryWords(got, names) },
    wording: def.wording,
    approval: def.approval,
    description: clip(def.description, 300),
    stages: def.stages.map((s) => ({
      stageId: s.stageId,
      name: stageNamed(names, s.stageId),
      people: got.funnel.stages.find((r) => r.id === s.stageId)?.people ?? 0,
      goal: s.goal,
      knows: clip(s.knows, 160),
      handOff: s.handOff,
      messages: s.messages.map((m) => `${m.id}: ${funnelMessageWords(m, 60)}`),
      moves: s.moves.map((m) => `${m.id}: ${moveWords(m, names)}`),
    })),
    stagesNotInIt: got.funnel.stages
      .filter((s) => !inFunnel.has(s.id))
      .map((s) => ({ stageId: s.id, name: s.name, kind: s.kind })),
    ...restOf(got),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Parts kept by their ids: those added, those changed (before and after), and those taken out, in order. */
function partsDiff<T extends { id: string }>(before: readonly T[], after: readonly T[]) {
  const was = new Map(before.map((p) => [p.id, p]));
  const now = new Set(after.map((p) => p.id));
  return {
    added: after.filter((p) => !was.has(p.id)),
    changed: after.flatMap((p) => {
      const old = was.get(p.id);
      return old && !same(old, p) ? [{ before: old, after: p }] : [];
    }),
    removed: before.filter((p) => !now.has(p.id)),
  };
}

/** What a save changes in a funnel, a line each, in the builder's words: who gets in, then each stage, then wording. */
export function funnelChangeLines(
  before: FunnelDefinition,
  after: FunnelDefinition,
  names: FunnelNames,
  pipelineName: string,
): string[] {
  const lines: string[] = [];
  const rule = (r: FunnelEntryRule) => `“${funnelEntryWords(r, pipelineName, names)}”`;
  const rules = partsDiff(before.entry.rules, after.entry.rules);
  for (const r of rules.added) lines.push(`Who gets in: adds ${rule(r)}`);
  for (const r of rules.changed)
    lines.push(`Who gets in: ${rule(r.before)} becomes ${rule(r.after)}`);
  for (const r of rules.removed) lines.push(`Who gets in: takes out ${rule(r)}`);
  if (before.entry.byHand !== after.entry.byHand)
    lines.push(
      after.entry.byHand
        ? 'Who gets in: people can add someone by hand'
        : 'Who gets in: nobody adds someone by hand anymore',
    );
  if (before.entry.aiSuggests !== after.entry.aiSuggests)
    lines.push(
      after.entry.aiSuggests
        ? 'Who gets in: the AI teammate may suggest someone who fits, for a person to OK'
        : 'Who gets in: the AI teammate stops suggesting people',
    );
  if (before.entry.startStageId !== after.entry.startStageId)
    lines.push(
      `Someone a rule takes in starts at ${after.entry.startStageId ? stageNamed(names, after.entry.startStageId) : 'the pipeline’s first open stage'}`,
    );
  const was = new Map(before.stages.map((s) => [s.stageId, s]));
  for (const s of after.stages) {
    const name = stageNamed(names, s.stageId);
    const old = was.get(s.stageId);
    if (!old) {
      lines.push(
        `${name}: added to the funnel${s.messages.length ? `, with ${plural(s.messages.length, 'message')}` : ''}`,
      );
      continue;
    }
    if (old.goal !== s.goal)
      lines.push(
        s.goal
          ? `${name}: its goal becomes “${clip(s.goal, 120)}”`
          : `${name}: its goal is cleared`,
      );
    if (old.knows !== s.knows)
      lines.push(
        s.knows
          ? `${name}: what the AI teammate knows here becomes “${clip(s.knows, 120)}”`
          : `${name}: what the AI teammate knows here is cleared`,
      );
    if (old.handOff !== s.handOff)
      lines.push(
        s.handOff
          ? `${name}: hands the conversation to the team after its first messages`
          : `${name}: no longer hands the conversation to the team`,
      );
    const messages = partsDiff(old.messages, s.messages);
    for (const m of messages.added)
      lines.push(`${name}: adds a message, ${funnelMessageWords(m, 100)}`);
    for (const m of messages.changed)
      lines.push(`${name}: a message becomes ${funnelMessageWords(m.after, 100)}`);
    for (const m of messages.removed)
      lines.push(`${name}: takes out the message ${funnelMessageWords(m, 60)}`);
    const moves = partsDiff(old.moves, s.moves);
    for (const m of moves.added) lines.push(`${name}: adds the move “${moveWords(m, names)}”`);
    for (const m of moves.changed)
      lines.push(
        `${name}: the move “${moveWords(m.before, names)}” becomes “${moveWords(m.after, names)}”`,
      );
    for (const m of moves.removed)
      lines.push(`${name}: takes out the move “${moveWords(m, names)}”`);
  }
  const kept = new Set(after.stages.map((s) => s.stageId));
  for (const s of before.stages)
    if (!kept.has(s.stageId))
      lines.push(`${stageNamed(names, s.stageId)}: taken out of the funnel`);
  if (before.wording !== after.wording)
    lines.push(
      after.wording === 'exact'
        ? 'Who writes new messages: your exact words'
        : 'Who writes new messages: the AI teammate',
    );
  if (before.approval !== after.approval)
    lines.push(`Before a message goes out: ${APPROVAL_WORDS[after.approval]}`);
  if (before.description !== after.description) lines.push('Its description changes');
  return lines;
}

/** Change lines as a card's fields, eight at most. */
function changeFields(lines: readonly string[]) {
  const shown =
    lines.length > 8
      ? [...lines.slice(0, 7), `And ${plural(lines.length - 7, 'more change')}`]
      : lines;
  return shown.map((value, i) => ({ label: i === 0 ? 'Change' : 'Then', value }));
}

/** The funnel as its builder reads it, as the person. */
const funnelOf = (db: Db, ctx: ToolContext, funnelId: unknown) =>
  query<Got>(db, ctx, funnelGet.name, { funnelId });

const funnelHref = (ctx: ToolContext, funnelId: string) =>
  `/app/w/${ctx.workspaceId}/ai-team/funnels/${funnelId}`;

/** Who's in it now, as the funnel's people count says it. */
const inItWords = (n: number) => (n === 1 ? '1 person is' : `${n} people are`);

/** Save changes to <funnel>?: what changes, stage by stage; who moves from a stage taken out; who it reaches. */
const saveCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const got = await funnelOf(db, ctx, args['funnelId']);
    const names = namesOf(got);
    const f = got.funnel;
    const after = FunnelDefinition.parse(args['definition']);
    const renamed = str(args['name']);
    const lines = [
      ...(renamed && renamed !== f.name ? [`Renamed “${renamed}”`] : []),
      ...funnelChangeLines(f.definition, after, names, f.pipelineName),
    ];
    const moved = Object.entries((args['moveFrom'] ?? {}) as Record<string, string>).map(
      ([from, to]) => `The people at ${stageNamed(names, from)} move to ${stageNamed(names, to)}`,
    );
    const blocked = lines.length ? null : 'Nothing changes: these steps are what’s saved now.';
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: `Save changes to ${f.name}?`,
        fields: [
          ...changeFields(lines),
          ...moved.slice(0, 2).map((value) => ({ label: 'Moves', value })),
        ],
        confirmLabel: blocked ? '' : 'Save',
        warnings: blocked
          ? [{ kind: 'blocked', text: blocked }]
          : f.status === 'on'
            ? [
                {
                  kind: 'caution',
                  text: `It’s on: ${f.people ? `${inItWords(f.people)} in it and stay at their stage, and ` : ''}new and changed messages go to customers as they come due.`,
                },
              ]
            : [
                {
                  kind: 'note',
                  text: `It’s ${STANDS[f.status]}, so nothing goes to customers until it’s turned on.`,
                },
              ],
      }),
      result: {
        waiting: true,
        funnel: f.name,
        changes: lines,
        ...(moved.length ? { moves: moved } : {}),
        ...(blocked ? { nothingToDo: blocked } : {}),
      },
    };
  },
  async done(db, ctx, args, output) {
    const got = await funnelOf(db, ctx, args['funnelId']);
    return {
      outcome:
        got.funnel.status === 'on'
          ? `Saved ${got.funnel.name}. What changed reaches the people in it right away.`
          : `Saved ${got.funnel.name}.`,
      href: funnelHref(ctx, got.funnel.id),
      answer: { ...output, name: got.funnel.name, status: got.funnel.status },
    };
  },
};

/** Make the funnel “<name>”?: its pipeline, and the draft's stages and messages; it starts as a draft. */
const createCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const name = str(args['name']) ?? 'the funnel';
    const draft = args['draft'] as
      | {
          stages?: { name: string; goal?: string; messages?: unknown[] }[];
          entry?: { rules?: Omit<FunnelEntryRule, 'id'>[] };
        }
      | undefined;
    const np = args['newPipeline'] as { name: string; stages: { name: string }[] } | undefined;
    const pipeline = np
      ? `A new one, “${np.name}”: ${np.stages.map((s) => s.name).join(', ')}`
      : ((
          await query<{ pipelines: { id: string; name: string }[] }>(db, ctx, 'pipeline.list')
        ).pipelines.find((p) => p.id === args['pipelineId'])?.name ?? 'The pipeline picked');
    const stages = draft?.stages ?? [];
    const messages = stages.reduce((n, s) => n + (s.messages?.length ?? 0), 0);
    const rules = (draft?.entry?.rules ?? []).map((r) =>
      funnelEntryWords({ ...r, id: 'draft' } as FunnelEntryRule, np?.name ?? 'the pipeline'),
    );
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: `Make the funnel “${name}”?`,
        fields: [
          { label: 'Pipeline', value: pipeline },
          ...(stages.length
            ? [
                {
                  label: 'Steps',
                  value: `${plural(stages.length, 'stage')}, ${plural(messages, 'message')}`,
                },
                ...stages.slice(0, 5).map((s) => ({
                  label: s.name,
                  value: [
                    s.goal ? clip(s.goal, 120) : null,
                    plural(s.messages?.length ?? 0, 'message'),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                })),
              ]
            : [{ label: 'Steps', value: 'None yet: you add them in the builder' }]),
          ...(rules.length ? [{ label: 'Who gets in', value: rules.join('; ') }] : []),
        ],
        confirmLabel: 'Make it',
        warnings: [
          {
            kind: 'note',
            text: 'It starts as a draft: it takes nobody in and sends nothing until it’s turned on.',
          },
        ],
      }),
      result: { waiting: true, funnel: name, stages: stages.map((s) => s.name) },
    };
  },
  async done(db, ctx, args, output) {
    const funnelId = String(output['funnelId']);
    return {
      outcome: `Made ${str(args['name']) ?? 'the funnel'} as a draft. It takes nobody in until it’s turned on: look it over under AI teammate → Funnels, then turn it on.`,
      href: funnelHref(ctx, funnelId),
    };
  },
};

/** Turn on <funnel>?: who gets in, the leads already there it takes in, and that its messages reach customers. */
const turnOnCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const got = await funnelOf(db, ctx, args['funnelId']);
    const f = got.funnel;
    const names = namesOf(got);
    const adding = args['addExisting'] === true ? got.waiting : 0;
    const already = f.status === 'on' && !adding;
    const entry = entryWords(got, names);
    const yellow = got.issues.find((i) => i.level === 'yellow');
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: `Turn on ${f.name}?`,
        fields: [
          { label: 'Pipeline', value: f.pipelineName },
          {
            label: 'Who gets in',
            value: [
              ...entry.rules,
              ...(entry.addedByHand ? ['People added by hand'] : []),
              ...(entry.teammateSuggests ? ['Those the AI teammate suggests, once OK’d'] : []),
            ].join('; '),
          },
          ...(adding
            ? [
                {
                  label: 'Also takes in',
                  value: `The ${plural(adding, 'open lead')} already in ${f.pipelineName}, each at the stage they’re in now`,
                },
              ]
            : []),
          {
            label: 'Before a message goes out',
            value: APPROVAL_WORDS[f.definition.approval],
          },
        ],
        confirmLabel: already ? '' : 'Turn on',
        warnings: already
          ? [{ kind: 'blocked', text: 'It’s already on, so there’s nothing to turn on.' }]
          : [
              {
                kind: 'caution',
                text: 'Once it’s on, its rules take people in and its messages go to customers as they come due.',
              },
              ...(yellow ? [{ kind: 'note', text: yellow.words }] : []),
            ],
      }),
      result: {
        waiting: true,
        funnel: f.name,
        ...(adding ? { alsoTakesIn: adding } : {}),
        ...(already ? { nothingToDo: 'It’s already on.' } : {}),
      },
    };
  },
  async done(db, ctx, args, output) {
    const got = await funnelOf(db, ctx, args['funnelId']);
    const adding = Number(output['adding'] ?? 0);
    return {
      outcome: `${got.funnel.name} is on.${adding ? ` It’s taking in ${plural(adding, 'lead')} already in ${got.funnel.pipelineName}.` : ''}`,
      href: funnelHref(ctx, got.funnel.id),
    };
  },
};

/** Pause <funnel>?: it takes nobody in and sends nothing; the people in it stay where they are. */
const pauseCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const { funnel: f } = await funnelOf(db, ctx, args['funnelId']);
    const blocked =
      f.status === 'on'
        ? null
        : `It isn’t on (it’s ${STANDS[f.status]}), so there’s nothing to pause.`;
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: `Pause ${f.name}?`,
        fields: [
          { label: 'Pipeline', value: f.pipelineName },
          { label: 'In it now', value: f.people ? plural(f.people, 'person', 'people') : 'Nobody' },
        ],
        confirmLabel: blocked ? '' : 'Pause',
        warnings: [
          blocked
            ? { kind: 'blocked', text: blocked }
            : {
                kind: 'note',
                text: 'It takes nobody in and sends nothing until it’s turned back on. The people in it stay where they are.',
              },
        ],
      }),
      result: { waiting: true, funnel: f.name, ...(blocked ? { nothingToDo: blocked } : {}) },
    };
  },
  async done(db, ctx, args) {
    const { funnel: f } = await funnelOf(db, ctx, args['funnelId']);
    return {
      outcome: `${f.name} is paused. Turn it back on under AI teammate → Funnels when you’re ready.`,
      href: funnelHref(ctx, f.id),
    };
  },
};

/** Archive <funnel>?: everyone in it leaves and nothing more is sent; its pipeline is free for another. */
const archiveCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const { funnel: f } = await funnelOf(db, ctx, args['funnelId']);
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: `Archive ${f.name}?`,
        fields: [
          { label: 'Pipeline', value: f.pipelineName },
          { label: 'In it now', value: f.people ? plural(f.people, 'person', 'people') : 'Nobody' },
          ...(f.suggestions
            ? [
                {
                  label: 'Suggestions',
                  value: `${plural(f.suggestions, 'suggestion')} waiting for an OK are turned down`,
                },
              ]
            : []),
        ],
        confirmLabel: 'Archive',
        warnings: [
          {
            kind: 'caution',
            text: `${f.people ? `The ${plural(f.people, 'person', 'people')} in it leave it, and nothing` : 'Nothing'} more is sent from it. Archiving it can’t be undone.`,
          },
          {
            kind: 'note',
            text: `${f.pipelineName} and the name ${f.name} are free for another funnel.`,
          },
        ],
      }),
      result: { waiting: true, funnel: f.name, peopleWhoLeave: f.people },
    };
  },
  // An archived funnel can't be read again, so this says what the command's answer does.
  async done(_db, ctx, _args, output) {
    const left = Number(output['left'] ?? 0);
    return {
      outcome: `The funnel is archived.${left ? ` ${plural(left, 'person', 'people')} left it.` : ''}`,
      href: `/app/w/${ctx.workspaceId}/ai-team/funnels`,
    };
  },
};

/** By the commands' own names: they stay screen actions (coverage.ts), drawn here as the builder says them. */
export const funnelScreenCards: Readonly<Record<string, ScreenActionCard>> = {
  [funnelCreate.name]: createCard,
  [funnelSave.name]: saveCard,
  [funnelTurnOn.name]: turnOnCard,
  [funnelPause.name]: pauseCard,
  [funnelArchive.name]: archiveCard,
};
