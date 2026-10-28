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
});
export type JourneyLead = z.output<typeof JourneyLead>;

/** "In your pipeline: New", or won or lost. */
export const leadWords = (lead: JourneyLead): string =>
  lead.status === 'won'
    ? 'Won in your pipeline'
    : lead.status === 'lost'
      ? 'Lost in your pipeline'
      : `In your pipeline: ${lead.stage}`;
