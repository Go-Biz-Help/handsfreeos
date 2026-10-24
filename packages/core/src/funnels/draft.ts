/**
 * A funnel as the AI drafts it from a description (step 1): the same parts as `FunnelDefinition`, with stages named
 * rather than pointing at a pipeline's. Step 2 picks the pipeline (a new one from these stages, or one the business
 * has, matched stage by stage), and `definitionFromDraft` turns the names into that pipeline's stages. Browser-safe.
 */
import { z } from 'zod';
import { INTAKE_KINDS } from '../crm/intake-kinds';
import {
  FUNNEL_EVENT_KEYS,
  FUNNEL_HOW,
  FUNNEL_LIMITS,
  FUNNEL_QUIET_MAX_MINUTES,
  FUNNEL_QUIET_MIN_MINUTES,
  FUNNEL_WORDING,
  FunnelDefinition,
  FunnelOnlyIf,
  FunnelWhen,
  newFunnelPartId,
  type FunnelDefinitionInput,
} from './definition';

const stageName = z.string().trim().min(1).max(60);

/** The ways in a draft can say: the business's forms and calendars are picked in step 3. */
const FunnelDraftRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new_lead') }),
  z.object({
    kind: z.literal('came_in'),
    ways: z.array(z.enum(INTAKE_KINDS)).min(1).max(INTAKE_KINDS.length),
  }),
]);

export const FunnelDraftMove = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.enum(FUNNEL_EVENT_KEYS), to: stageName }),
  z.object({ kind: z.literal('reply'), says: z.string().trim().min(3).max(200), to: stageName }),
  z.object({
    kind: z.literal('quiet'),
    minutes: z.number().int().min(FUNNEL_QUIET_MIN_MINUTES).max(FUNNEL_QUIET_MAX_MINUTES),
    to: stageName,
  }),
]);

export const FunnelDraftMessage = z.object({
  when: FunnelWhen,
  onlyIf: FunnelOnlyIf.nullable().default(null),
  wording: z.enum(FUNNEL_WORDING).default('ai'),
  text: z.string().trim().min(1).max(1000),
  how: z.enum(FUNNEL_HOW).default('best'),
});

export const FunnelDraftStage = z.object({
  name: stageName,
  kind: z.enum(['open', 'won', 'lost']).default('open'),
  goal: z.string().trim().max(300).default(''),
  knows: z.string().trim().max(1000).default(''),
  moves: z.array(FunnelDraftMove).max(FUNNEL_LIMITS.moves).default([]),
  messages: z.array(FunnelDraftMessage).max(FUNNEL_LIMITS.messages).default([]),
  handOff: z.boolean().default(false),
});

export const FunnelDraft = z.object({
  name: z.string().trim().min(1).max(80),
  stages: z.array(FunnelDraftStage).min(3).max(FUNNEL_LIMITS.stages),
  /** How people get in. The rules' ids are made when it becomes a funnel. */
  entry: z
    .object({
      rules: z.array(FunnelDraftRule).max(FUNNEL_LIMITS.entryRules).default([]),
      byHand: z.boolean().default(true),
      aiSuggests: z.boolean().default(false),
      startStage: stageName.nullable().default(null),
    })
    .prefault({}),
});
export type FunnelDraft = z.infer<typeof FunnelDraft>;
export type FunnelDraftInput = z.input<typeof FunnelDraft>;

const key = (name: string) => name.trim().toLowerCase();

/**
 * The draft as a funnel on a pipeline whose stages are `stageIds` (draft stage name → pipeline stage id). Draft
 * stages with no match are left out, and so are moves to them. Fresh ids for every move, message and rule.
 */
export function definitionFromDraft(
  draft: FunnelDraft,
  stageIds: ReadonlyMap<string, string>,
  description = '',
): FunnelDefinition {
  const idOf = (name: string) => stageIds.get(key(name)) ?? stageIds.get(name) ?? null;
  const input: FunnelDefinitionInput = {
    description: description.slice(0, 4000),
    entry: {
      rules: draft.entry.rules.map((r) => ({ ...r, id: newFunnelPartId('r') })),
      byHand: draft.entry.byHand,
      aiSuggests: draft.entry.aiSuggests,
      startStageId: draft.entry.startStage ? idOf(draft.entry.startStage) : null,
    },
    stages: draft.stages.flatMap((s) => {
      const stageId = idOf(s.name);
      if (!stageId) return [];
      return [
        {
          stageId,
          goal: s.goal,
          knows: s.knows,
          handOff: s.handOff,
          moves: s.moves.flatMap((m) => {
            const to = idOf(m.to);
            if (!to || to === stageId) return [];
            return [{ ...m, id: newFunnelPartId('v'), to }];
          }),
          messages: s.messages.map((m) => ({ ...m, id: newFunnelPartId('m') })),
        },
      ];
    }),
  };
  return FunnelDefinition.parse(input);
}

/** Draft stage names matched to a pipeline's stages by name, for step 2's "use one you have". */
export function matchDraftStages(
  draft: FunnelDraft,
  stages: readonly { readonly id: string; readonly name: string }[],
): Map<string, string> {
  const byName = new Map(stages.map((s) => [key(s.name), s.id]));
  const out = new Map<string, string>();
  for (const s of draft.stages) {
    const id = byName.get(key(s.name));
    if (id) out.set(key(s.name), id);
  }
  return out;
}
