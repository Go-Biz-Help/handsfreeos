/**
 * Answers to "What should your AI teammate do?". A preset only prefills skills: the result is an ordinary
 * settings document that can be changed in any way afterwards, and its labels follow the settings.
 */
import {
  applyTeammatePatch,
  emptyTeammateConfig,
  type DisclosureMode,
  type QualifyingQuestion,
  type QualifyingQuestionInput,
  type TeammateConfig,
  type TeammatePatch,
} from './config';

export const TEAMMATE_PRESET_KEYS = [
  'lead_responder',
  'lead_qualifier',
  'appointment_coordinator',
  'blank',
] as const;
export type TeammatePresetKey = (typeof TEAMMATE_PRESET_KEYS)[number];

export interface TeammatePreset {
  readonly key: TeammatePresetKey;
  readonly name: string;
  readonly description: string;
  /** The skills it fills in (channels, questions and calendars come from the context). */
  readonly config: TeammatePatch;
}

export const TEAMMATE_PRESETS: readonly TeammatePreset[] = [
  {
    key: 'lead_responder',
    name: 'Lead Responder',
    description:
      'Replies to new leads in seconds, answers their questions and nudges them if they go quiet.',
    config: {
      respond: { enabled: true, newLeads: { enabled: true } },
      answer: { enabled: true },
      followUp: { enabled: true },
    },
  },
  {
    key: 'lead_qualifier',
    name: 'Lead Qualifier',
    description: 'Asks your qualifying questions and tells you when a lead is ready.',
    config: {
      respond: { enabled: true, newLeads: { enabled: true } },
      answer: { enabled: true },
      qualify: { enabled: true },
      followUp: { enabled: true },
    },
  },
  {
    key: 'appointment_coordinator',
    name: 'Appointment Coordinator',
    description: 'Answers questions, and books, moves and cancels appointments on your calendars.',
    config: {
      respond: { enabled: true, newLeads: { enabled: false } },
      answer: { enabled: true },
      book: { enabled: true, reschedule: true, cancel: true },
    },
  },
  {
    key: 'blank',
    name: 'Start from scratch',
    description: 'Nothing turned on. Pick the skills yourself in the builder.',
    // Every skill off, first messages to new leads too, so turning Respond on later only answers.
    config: {
      respond: { enabled: false, newLeads: { enabled: false } },
      answer: { enabled: false },
      qualify: { enabled: false },
      book: { enabled: false },
      followUp: { enabled: false },
    },
  },
];

export interface TeammatePresetContext {
  /** Picked in the preset step. */
  readonly name?: string;
  readonly disclosure?: DisclosureMode;
  /** The workspace's industry, for the Lead Qualifier's suggested questions. */
  readonly industry?: string | null;
  /** The address it emails from and the chat widget it answers; the channel stays off without one. */
  readonly emailAddressId?: string | null;
  readonly widgetId?: string | null;
  /** Calendars customers can book online; the Appointment Coordinator books on them. */
  readonly calendarIds?: readonly string[];
}

const HOME_SERVICES: QualifyingQuestionInput[] = [
  {
    id: 'need',
    question: 'What do you need help with?',
    kind: 'choice',
    options: ['Repair', 'Maintenance', 'New installation', 'Something else'],
  },
  {
    id: 'timeline',
    question: 'How soon do you need it done?',
    kind: 'choice',
    options: ['Today or tomorrow', 'This week', 'This month', 'Just planning'],
  },
  { id: 'owner', question: 'Do you own the home?', kind: 'yes_no' },
  { id: 'zip', question: 'What ZIP code is the job in?', kind: 'text' },
];

const GENERAL: QualifyingQuestionInput[] = [
  { id: 'need', question: 'What can we help you with?', kind: 'text' },
  {
    id: 'timeline',
    question: 'When are you hoping to get started?',
    kind: 'choice',
    options: ['As soon as possible', 'In the next month', 'Just looking'],
  },
  { id: 'budget', question: 'Do you have a budget in mind?', kind: 'text', required: false },
];

/** Starting questions for the workspace's industry (general ones when it has none). Nothing rules a lead out. */
export function suggestedQuestions(industry?: string | null): QualifyingQuestion[] {
  const list = industry === 'home_services' ? HOME_SERVICES : GENERAL;
  return applyTeammatePatch(emptyTeammateConfig(), { qualify: { questions: list } }).qualify
    .questions;
}

const unique = (ids: readonly string[]) => [...new Set(ids)];

/** A complete settings document from a preset. */
export function teammateConfigFromPreset(
  preset: TeammatePresetKey,
  ctx: TeammatePresetContext = {},
): TeammateConfig {
  const found = TEAMMATE_PRESETS.find((p) => p.key === preset);
  if (!found) throw new RangeError(`Unknown preset: ${preset}`);
  const name = ctx.name?.trim();
  let config = applyTeammatePatch(emptyTeammateConfig(), found.config);
  config = applyTeammatePatch(config, {
    identity: {
      ...(name ? { name } : {}),
      ...(ctx.disclosure ? { disclosure: ctx.disclosure } : {}),
    },
    channels: {
      sms: true,
      email: !!ctx.emailAddressId,
      emailAddressId: ctx.emailAddressId ?? null,
      chat: !!ctx.widgetId,
      widgetId: ctx.widgetId ?? null,
    },
    // A new teammate reaches the team on their phones; email is there to turn on.
    handOff: { alerts: { email: false } },
  });
  if (preset === 'lead_qualifier')
    config = applyTeammatePatch(config, {
      qualify: { questions: suggestedQuestions(ctx.industry) },
    });
  // Without a calendar, booking_needs_calendar shows with its fixes.
  if (preset === 'appointment_coordinator' && ctx.calendarIds?.length)
    config = applyTeammatePatch(config, {
      book: { calendarIds: unique(ctx.calendarIds).slice(0, 20) },
    });
  return config;
}
