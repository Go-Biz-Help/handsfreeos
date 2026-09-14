/**
 * Inferred labels: what the teammate's settings add up to ("Lead Responder · Books appointments"). Stored for
 * lists and analytics; they never decide what can be edited.
 */
import type { TeammateConfig } from './config';

export const TEAMMATE_LABELS = [
  'lead_qualifier',
  'lead_responder',
  'appointment_coordinator',
  'answers',
  'books',
  'follows_up',
  'custom',
] as const;
export type TeammateLabel = (typeof TEAMMATE_LABELS)[number];

export const TEAMMATE_LABEL_NAMES: Readonly<Record<TeammateLabel, string>> = {
  lead_qualifier: 'Lead Qualifier',
  lead_responder: 'Lead Responder',
  appointment_coordinator: 'Appointment Coordinator',
  answers: 'Answers questions',
  books: 'Books appointments',
  follows_up: 'Follows up',
  custom: 'Custom',
};

export interface TeammateLabels {
  /** The role it plays: Lead Qualifier, Lead Responder, Appointment Coordinator, Answers questions or Custom. */
  readonly primary: TeammateLabel;
  /** The role, then what it does beyond it. */
  readonly tags: readonly TeammateLabel[];
}

/**
 * The role, checked in order: qualifying makes a Lead Qualifier, messaging new leads a Lead Responder,
 * booking an Appointment Coordinator, and answering questions alone "Answers questions". Then booking
 * (when it isn't the role) and following up are added as tags.
 */
export function inferTeammateLabels(config: TeammateConfig): TeammateLabels {
  const roles: [TeammateLabel, boolean][] = [
    ['lead_qualifier', config.qualify.enabled],
    ['lead_responder', config.respond.enabled && config.respond.newLeads.enabled],
    ['appointment_coordinator', config.book.enabled],
    ['answers', config.answer.enabled],
  ];
  const primary = roles.find(([, on]) => on)?.[0] ?? 'custom';
  const tags: TeammateLabel[] = [primary];
  if (config.book.enabled && primary !== 'appointment_coordinator') tags.push('books');
  if (config.followUp.enabled) tags.push('follows_up');
  return { primary, tags };
}

/** "Lead Responder · Books appointments". */
export function formatTeammateLabels(labels: TeammateLabels): string {
  return labels.tags.map((t) => TEAMMATE_LABEL_NAMES[t]).join(' · ');
}
