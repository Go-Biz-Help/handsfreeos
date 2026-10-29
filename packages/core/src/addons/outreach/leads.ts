/**
 * A lead in the pipeline for whoever wants a demo (docs/outreach.md decision 105, the owner's pick 2a): once someone
 * the person reached wants a demo or has answered the playbook's questions, they go in Contacts and a lead goes in the
 * main pipeline's first stage, marked with the network and the group they came from, assigned to whoever reached them.
 * A profile opens one lead, once; a customer's open lead is used rather than a second.
 *
 * What counts (`./ops/leads.ts` `wantsTheOffer`), as Today's Pitch does: the AI's read of their chat says they're
 * ready for the offer (it reads the playbook's questions to have answered), they said yes to the step before the link,
 * the person marked them ready, or a demo was booked. Browser-safe.
 */
import { z } from 'zod';
import { stepStages, type RoleOverride, type RoleStage } from '../../automations/pipeline-roles';
import { PLATFORMS, type Platform } from './networks';

/** The most a lead's source keeps (core's `source`). */
export const LEAD_SOURCE_MOST = 80;

/** Where a lead came from, as its source says: "Facebook · Round Rock Contractors", or the network alone. */
export function leadSourceOf(platform: Platform, groupName: string | null): string {
  const network = PLATFORMS[platform];
  const group = groupName?.replace(/\s+/g, ' ').trim();
  if (!group) return network;
  const whole = `${network} · ${group}`;
  return whole.length <= LEAD_SOURCE_MOST
    ? whole
    : `${whole.slice(0, LEAD_SOURCE_MOST - 1).trimEnd()}…`;
}

/** A lead's title: "Dana Reyes (Facebook)". */
export const leadTitleOf = (name: string, platform: Platform): string =>
  `${name.replace(/\s+/g, ' ').trim()} (${PLATFORMS[platform]})`.slice(0, 160);

export const LeadOpenInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  /** Whoever reached them: the lead's owner, and whose chat, answer, mark or demo it was. */
  userId: z.uuid(),
});
export type LeadOpenInput = z.input<typeof LeadOpenInput>;

/** Why no lead went in, when none did. */
export const LEAD_SKIPS = ['gone', 'had_one', 'not_open', 'not_yet', 'no_pipeline'] as const;
export type LeadSkip = (typeof LEAD_SKIPS)[number];

export const LeadOpenOutput = z.object({
  /** The lead they're in now: the one it opened, or their open lead it found. */
  leadId: z.uuid().nullable(),
  opened: z.boolean(),
  skipped: z.enum(LEAD_SKIPS).nullable(),
});
export type LeadOpenOutput = z.output<typeof LeadOpenOutput>;

/** What a customer's Social panel says of their lead. */
export const JourneyLead = z.object({
  leadId: z.uuid(),
  title: z.string(),
  /** Its stage now, as the pipeline names it. */
  stage: z.string(),
  status: z.enum(['open', 'won', 'lost']),
  /**
   * Their demo is done and the lead waits for the person's won or lost (decision 106): a demo booked through the link
   * they came to, or one the person marked booked. Left out by builds of the phone from before it: read as not.
   */
  afterDemo: z.boolean().optional(),
});
export type JourneyLead = z.output<typeof JourneyLead>;

/** "In your pipeline: New", or won or lost. */
export const leadWords = (lead: JourneyLead): string =>
  lead.status === 'won'
    ? 'Won in your pipeline'
    : lead.status === 'lost'
      ? 'Lost in your pipeline'
      : `In your pipeline: ${lead.stage}`;

// ---- After the demo (decision 106, the owner's pick 3a) ----

/**
 * Where a lead goes once its demo is done: on past the stage for a visit booked (Automations' roles, as Move deals
 * along reads them), or to that stage when it's the last open one; with no such stage, the next open stage. Never
 * back, and nowhere from won or lost. The person then marks it won or lost (`outreach.demo.outcome`).
 */
export function stageAfterDemo(
  stages: readonly RoleStage[],
  roles: Readonly<Record<string, RoleOverride>>,
  currentStageId: string,
): RoleStage | null {
  const current = stages.find((s) => s.id === currentStageId);
  if (!current || current.kind !== 'open') return null;
  const open = stages.filter((s) => s.kind === 'open').sort((a, b) => a.position - b.position);
  const booked = stepStages(stages, roles).booked ?? null;
  const target = booked
    ? (open.find((s) => s.position > booked.position) ?? booked)
    : (open.find((s) => s.position > current.position) ?? null);
  return target && target.position > current.position ? target : null;
}

export const DemoHeldInput = z.object({ workspaceId: z.uuid(), appointmentId: z.uuid() });
export type DemoHeldInput = z.input<typeof DemoHeldInput>;
export const DemoHeldOutput = z.object({
  /** The leads it moved on: one a profile booked through a demo link on that booking. */
  moved: z.array(z.object({ leadId: z.uuid(), stageId: z.uuid() })),
});
export type DemoHeldOutput = z.output<typeof DemoHeldOutput>;

export const DEMO_OUTCOMES = ['won', 'lost'] as const;
export type DemoOutcome = (typeof DEMO_OUTCOMES)[number];
/** The most a lost demo's reason says (core's lost reason). */
export const DEMO_LOST_WHY_MOST = 300;
/** A lost demo's reason when the person gives none. */
export const DEMO_LOST_WHY = 'Not after the demo';

export const DemoOutcomeInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  outcome: z.enum(DEMO_OUTCOMES),
  /** For lost: why, in the person's words. */
  why: z.string().trim().min(1).max(DEMO_LOST_WHY_MOST).nullable().default(null),
});
export type DemoOutcomeInput = z.input<typeof DemoOutcomeInput>;
export const DemoOutcomeOutput = z.object({
  profileId: z.uuid(),
  leadId: z.uuid(),
  outcome: z.enum(DEMO_OUTCOMES),
});
export type DemoOutcomeOutput = z.output<typeof DemoOutcomeOutput>;

/** The Social panel's words for won or lost after the demo, on the web and the phone alike. */
export const DEMO_OUTCOME_WORDS = {
  ask: 'Their demo is done. How did it go?',
  won: 'Won',
  lost: 'Lost',
  why: 'Why it didn’t go ahead (you can leave it blank)',
  markLost: 'Mark lost',
  cancel: 'Cancel',
  done: (name: string, outcome: DemoOutcome): string =>
    outcome === 'won'
      ? `${name} is won in your pipeline.`
      : `${name} is lost in your pipeline, and marked not a fit here.`,
} as const;
