/**
 * The AI's draft of a funnel as the model writes it (step 1, "Describe it"): one flat shape every provider's
 * structured output can hold, with no unions, turned into a `FunnelDraft` by `draftFromWire`, which keeps what's
 * sound and drops or mends the rest (a move to a stage it never named, a time out of range). Browser-safe, so the
 * worker's route and the tests read the same rules.
 */
import { z } from 'zod';
import { INTAKE_KINDS } from '../crm/intake-kinds';
import {
  FUNNEL_EVENT_KEYS,
  FUNNEL_LIMITS,
  FUNNEL_QUIET_MAX_MINUTES,
  FUNNEL_QUIET_MIN_MINUTES,
  type FunnelEvent,
} from './definition';
import { FunnelDraft, type FunnelDraftInput, type FunnelDraftMove } from './draft';

const nullable = <T extends z.ZodType>(t: T) => t.nullable();

export const FunnelDraftWire = z.object({
  name: z.string(),
  stages: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['open', 'won', 'lost']),
      goal: z.string(),
      knows: z.string(),
      handOff: z.boolean(),
      moves: z.array(
        z.object({
          kind: z.enum(['event', 'reply', 'quiet']),
          event: nullable(z.enum(FUNNEL_EVENT_KEYS)),
          says: nullable(z.string()),
          quietDays: nullable(z.number()),
          to: z.string(),
        }),
      ),
      messages: z.array(
        z.object({
          when: z.enum(['arrive', 'booking', 'booking_day']),
          minutes: nullable(z.number()),
          daysBefore: nullable(z.number()),
          at: nullable(z.string()),
          onlyIf: z.enum(['always', 'has', 'hasnt']),
          onlyIfEvent: nullable(z.enum(FUNNEL_EVENT_KEYS)),
          wording: z.enum(['ai', 'exact']),
          text: z.string(),
          how: z.enum(['text', 'email', 'best']),
        }),
      ),
    }),
  ),
  entry: z.object({
    newLead: z.boolean(),
    cameIn: z.array(z.enum(INTAKE_KINDS)),
    byHand: z.boolean(),
    aiSuggests: z.boolean(),
    startStage: nullable(z.string()),
  }),
});
export type FunnelDraftWire = z.infer<typeof FunnelDraftWire>;

const str = { type: 'string' } as const;
const orNull = (t: Record<string, unknown>) => ({ anyOf: [t, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The same shape as JSON Schema, for the provider's structured output. */
export const FUNNEL_DRAFT_WIRE_SCHEMA: Record<string, unknown> = object({
  name: { ...str, description: 'A short name for the funnel, like Recruiting.' },
  stages: {
    type: 'array',
    description: `3 to ${FUNNEL_LIMITS.stages} stages, in order, ending with at least one won and one lost stage.`,
    items: object({
      name: { ...str, description: 'The stage’s name, as a pipeline column: “Booked”, “Missed”.' },
      kind: { type: 'string', enum: ['open', 'won', 'lost'] },
      goal: {
        ...str,
        description: 'One line: what should happen at this stage. Empty for won or lost.',
      },
      knows: { ...str, description: 'Talking points for the teammate at this stage, or empty.' },
      handOff: {
        type: 'boolean',
        description: 'After this stage’s first messages, the team takes over.',
      },
      moves: {
        type: 'array',
        description: `What moves someone on from this stage (at most ${FUNNEL_LIMITS.moves}). None for won or lost.`,
        items: object({
          kind: {
            type: 'string',
            enum: ['event', 'reply', 'quiet'],
            description:
              'event: something HandsFreeOS sees; reply: what they write, as the teammate judges it; quiet: no word from them for a while.',
          },
          event: orNull({ type: 'string', enum: [...FUNNEL_EVENT_KEYS] }),
          says: orNull({ ...str, description: 'For reply: “they say they’re interested”.' }),
          quietDays: orNull({ type: 'number', description: 'For quiet: how many days, like 3.' }),
          to: { ...str, description: 'The name of the stage it moves them to.' },
        }),
      },
      messages: {
        type: 'array',
        description: `What the teammate sends at this stage (at most ${FUNNEL_LIMITS.messages}). None for won or lost.`,
        items: object({
          when: {
            type: 'string',
            enum: ['arrive', 'booking', 'booking_day'],
            description:
              'arrive: minutes after they reach the stage; booking: minutes from their booking’s start (negative before); booking_day: on the booking’s day (or days before) at a time.',
          },
          minutes: orNull({ type: 'number' }),
          daysBefore: orNull({ type: 'number' }),
          at: orNull({ ...str, description: 'For booking_day: a 24-hour time like 16:00.' }),
          onlyIf: { type: 'string', enum: ['always', 'has', 'hasnt'] },
          onlyIfEvent: orNull({ type: 'string', enum: [...FUNNEL_EVENT_KEYS] }),
          wording: {
            type: 'string',
            enum: ['ai', 'exact'],
            description:
              'ai: text is a brief the teammate writes from; exact: text goes as written, with {first_name}, {session_time}, {join_link} and {business} filled in.',
          },
          text: str,
          how: { type: 'string', enum: ['text', 'email', 'best'] },
        }),
      },
    }),
  },
  entry: object({
    newLead: { type: 'boolean', description: 'Any new lead in its pipeline gets in.' },
    cameIn: {
      type: 'array',
      items: { type: 'string', enum: [...INTAKE_KINDS] },
      description: 'Or only new leads that came in these ways. Empty for any.',
    },
    byHand: { type: 'boolean' },
    aiSuggests: { type: 'boolean' },
    startStage: orNull({ ...str, description: 'The stage people start at; null for the first.' }),
  }),
});

const clamp = (n: number | null, lo: number, hi: number, fallback: number) =>
  n === null || !Number.isFinite(n) ? fallback : Math.min(hi, Math.max(lo, Math.round(n)));
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MAX_OFFSET = 14 * 24 * 60;

/**
 * What the model wrote, as a draft: stage names made unique and trimmed, a won and a lost stage added when it left
 * them out, moves to stages it never named dropped, times brought into range. Null when nothing usable is left.
 */
export function draftFromWire(w: FunnelDraftWire): FunnelDraft | null {
  const seen = new Set<string>();
  const stages = w.stages
    .map((s) => ({ ...s, name: s.name.trim().slice(0, 60) }))
    .filter((s) => {
      const k = s.name.toLowerCase();
      if (!s.name || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, FUNNEL_LIMITS.stages);
  if (!stages.some((s) => s.kind === 'open')) return null;
  for (const kind of ['won', 'lost'] as const)
    if (
      !stages.some((s) => s.kind === kind) &&
      stages.length < FUNNEL_LIMITS.stages &&
      !seen.has(kind)
    )
      stages.push({
        name: kind === 'won' ? 'Won' : 'Lost',
        kind,
        goal: '',
        knows: '',
        handOff: false,
        moves: [],
        messages: [],
      });
  const names = new Set(stages.map((s) => s.name.toLowerCase()));
  const draft: FunnelDraftInput = {
    name: w.name.trim().slice(0, 80) || 'New funnel',
    stages: stages.map((s) => {
      const open = s.kind === 'open';
      return {
        name: s.name,
        kind: s.kind,
        goal: open ? s.goal.trim().slice(0, 300) : '',
        knows: open ? s.knows.trim().slice(0, 1000) : '',
        handOff: open && s.handOff,
        moves: open
          ? s.moves
              .filter(
                (m) =>
                  names.has(m.to.trim().toLowerCase()) &&
                  m.to.trim().toLowerCase() !== s.name.toLowerCase(),
              )
              .flatMap((m): z.input<typeof FunnelDraftMove>[] => {
                const to = stages.find(
                  (x) => x.name.toLowerCase() === m.to.trim().toLowerCase(),
                )!.name;
                if (m.kind === 'event')
                  return m.event ? [{ kind: 'event' as const, event: m.event, to }] : [];
                if (m.kind === 'reply') {
                  const says = (m.says ?? '').trim().slice(0, 200);
                  return says.length >= 3 ? [{ kind: 'reply' as const, says, to }] : [];
                }
                return [
                  {
                    kind: 'quiet' as const,
                    minutes: clamp(
                      (m.quietDays ?? 3) * 1440,
                      FUNNEL_QUIET_MIN_MINUTES,
                      FUNNEL_QUIET_MAX_MINUTES,
                      4320,
                    ),
                    to,
                  },
                ];
              })
              .slice(0, FUNNEL_LIMITS.moves)
          : [],
        messages: open
          ? s.messages
              .filter((m) => m.text.trim())
              .map((m) => ({
                when:
                  m.when === 'arrive'
                    ? { kind: 'arrive' as const, minutes: clamp(m.minutes, 0, MAX_OFFSET, 0) }
                    : m.when === 'booking'
                      ? {
                          kind: 'booking' as const,
                          minutes: clamp(m.minutes, -MAX_OFFSET, MAX_OFFSET, -60),
                        }
                      : {
                          kind: 'booking_day' as const,
                          daysBefore: clamp(m.daysBefore, 0, 7, 1),
                          at:
                            m.at && CLOCK.test(m.at.trim())
                              ? m.at.trim().padStart(5, '0')
                              : '16:00',
                        },
                onlyIf:
                  m.onlyIf === 'always' || !m.onlyIfEvent
                    ? null
                    : { has: m.onlyIf === 'has', event: m.onlyIfEvent as FunnelEvent },
                wording: m.wording,
                text: m.text.trim().slice(0, 1000),
                how: m.how,
              }))
              .slice(0, FUNNEL_LIMITS.messages)
          : [],
      };
    }),
    entry: {
      rules: [
        ...(w.entry.newLead && !w.entry.cameIn.length ? [{ kind: 'new_lead' as const }] : []),
        ...(w.entry.cameIn.length
          ? [{ kind: 'came_in' as const, ways: [...new Set(w.entry.cameIn)] }]
          : []),
      ],
      byHand: w.entry.byHand,
      aiSuggests: w.entry.aiSuggests,
      startStage:
        w.entry.startStage && names.has(w.entry.startStage.trim().toLowerCase())
          ? stages.find((s) => s.name.toLowerCase() === w.entry.startStage!.trim().toLowerCase())!
              .name
          : null,
    },
  };
  const parsed = FunnelDraft.safeParse(draft);
  return parsed.success ? parsed.data : null;
}
