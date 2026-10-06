/**
 * What quick setup starts from: what the business has today, as `ai_setup.get` reads it
 * (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5). The picks, the plan and the summary are all worked out
 * from it and the answers, the same way on the web, on the phone and in `ai_setup.finish`. Browser-safe.
 */
import { z } from 'zod';
import { parseTeammateConfig, type TeammateConfig } from '../ai-team/config';
import { WeeklyHours } from '../calendar/config';
import { KnowledgeProfile } from '../knowledge/profile';
import { ONBOARDING_GOALS } from '../onboarding/steps';
import { SETUP_KINDS } from './kinds';

/** Facts quick setup writes carry this tag, so it finds its own again and never rewrites one a person wrote. */
export const AI_SETUP_FACT_TAG = 'Quick setup';

const id = z.uuid();
const named = z.object({ id, name: z.string() });

/** The website scan, for "What Ava learned". */
export const AI_SETUP_SCAN_STATES = ['none', 'running', 'done', 'failed'] as const;
export type AiSetupScanState = (typeof AI_SETUP_SCAN_STATES)[number];

export const AiSetupStateOut = z.object({
  businessName: z.string(),
  industry: z.string().nullable(),
  kind: z.enum(SETUP_KINDS),
  /** Getting started's "What do you want help with first?". */
  goal: z.enum(ONBOARDING_GOALS).nullable(),
  /** Knowledge → Website, else Getting started's answer; null when they have none. */
  website: z.string().nullable(),
  timeZone: z.string(),
  /** Settings → Workspace's open hours; null until someone sets them. */
  openHours: WeeklyHours.nullable(),
  /** The teammate's settings come as stored; `aiSetupStateOf` reads them. */
  teammate: z
    .object({
      id,
      name: z.string(),
      status: z.enum(['off', 'training', 'automatic']),
      revision: z.int(),
      config: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  profile: KnowledgeProfile,
  /** The facts quick setup wrote before (tagged `AI_SETUP_FACT_TAG`), whatever happened to them since. */
  facts: z.array(
    z.object({
      id,
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()),
      status: z.enum(['draft', 'published', 'archived']),
    }),
  ),
  /** Calendars → Services. */
  services: z.array(named),
  /** Calendars customers can book online. */
  calendars: z.array(named),
  /** Service areas in Calendars → Service areas. */
  territories: z.int(),
  /** The address it would email from. */
  emailAddress: z.object({ id, address: z.string() }).nullable(),
  /** The website chat it would answer. */
  chat: named.nullable(),
  /** The business number works, so a cell can be confirmed with a call from it. */
  number: z.boolean(),
  /** Texting is registered with the carriers. */
  textingReady: z.boolean(),
  scan: z.object({
    state: z.enum(AI_SETUP_SCAN_STATES),
    /** What it found that nobody has kept or turned down. */
    pending: z.int(),
  }),
});
export type AiSetupStateOut = z.infer<typeof AiSetupStateOut>;

export interface AiSetupTeammate extends Omit<NonNullable<AiSetupStateOut['teammate']>, 'config'> {
  readonly config: TeammateConfig;
}
export interface AiSetupState extends Omit<AiSetupStateOut, 'teammate'> {
  readonly teammate: AiSetupTeammate | null;
}

/** The state as the functions here take it, with the teammate's settings read (every default filled in). */
export function aiSetupStateOf(out: AiSetupStateOut | AiSetupState): AiSetupState {
  return {
    ...out,
    teammate: out.teammate && {
      ...out.teammate,
      config: parseTeammateConfig(out.teammate.config),
    },
  };
}
