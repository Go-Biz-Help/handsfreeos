/**
 * Inferred labels: a description of what the settings add up to. Stored for lists and analytics; they never
 * decide what can be edited.
 */
import type { CalendarConfig } from './config';

export const CALENDAR_LABELS = [
  'event',
  'group',
  'collective',
  'dispatch',
  'round_robin',
  'resource',
  'service',
  'personal',
  'custom',
] as const;
export type CalendarLabel = (typeof CALENDAR_LABELS)[number];

export const LABEL_NAMES: Readonly<Record<CalendarLabel, string>> = {
  event: 'Event',
  group: 'Group/Class',
  collective: 'Collective',
  dispatch: 'Dispatch',
  round_robin: 'Round Robin',
  resource: 'Resource',
  service: 'Service',
  personal: 'Personal',
  custom: 'Custom',
};

export interface CalendarLabels {
  readonly primary: CalendarLabel;
  /** Every label that applies, in precedence order; ['custom'] when none do. */
  readonly tags: readonly CalendarLabel[];
}

const ROTATING = new Set(['round_robin', 'weighted']);

/** Checked in order: Event, Group/Class, Collective, Dispatch, Round Robin, Resource, Service, Personal. */
export function inferLabels(config: CalendarConfig): CalendarLabels {
  const people = config.team.members.length;
  const checks: [CalendarLabel, boolean][] = [
    ['event', config.schedule.mode === 'sessions'],
    ['group', config.capacity.seats > 1],
    ['collective', config.team.assignment === 'collective' || config.team.crewSize > 1],
    ['dispatch', config.territory.routing === 'zip' || config.buffers.travelMinutes > 0],
    ['round_robin', ROTATING.has(config.team.assignment) && people >= 2],
    ['resource', config.resources.required.length > 0],
    ['service', config.services.mode !== 'none'],
    ['personal', people === 1 && config.team.assignment === 'fixed' && config.capacity.seats === 1],
  ];
  const tags = checks.filter(([, on]) => on).map(([label]) => label);
  return tags.length ? { primary: tags[0]!, tags } : { primary: 'custom', tags: ['custom'] };
}

/** "Dispatch · Round Robin · Service". */
export function formatLabels(labels: CalendarLabels): string {
  return labels.tags.map((t) => LABEL_NAMES[t]).join(' · ');
}
