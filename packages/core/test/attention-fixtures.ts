/** Shared facts for the Action Center's pure tests: a Chicago business, open weekdays 8 to 5. */
import type {
  BusinessFacts,
  LeadFacts,
  RepeatCustomerFacts,
  StageFacts,
} from '../src/attention/index';
import type { WeeklyHours } from '../src/calendar/config';
import { localInstant } from '../src/calendar/engine/zoned';

export const TZ = 'America/Chicago';
export const WEEKDAYS_8_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '08:00',
  end: '17:00',
}));
export const business: BusinessFacts = {
  timeZone: TZ,
  openHours: WEEKDAYS_8_TO_5,
  medianWonCents: null,
};

/** A moment in Chicago. 2026-09-15 is a Tuesday. */
export const at = (date: string, clock: string): Date => new Date(localInstant(date, clock, TZ));
/** Tuesday 10 AM. */
export const NOW = at('2026-09-15', '10:00');

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const shift = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
export const ago = (ms: number, from: Date = NOW): string =>
  new Date(from.getTime() - ms).toISOString();
export const later = (ms: number, from: Date = NOW): string =>
  new Date(from.getTime() + ms).toISOString();
export const iso = (d: Date): string => d.toISOString();
export const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const STAGE_NEW: StageFacts = { id: uid(101), name: 'New lead', index: 0, openStages: 4 };
export const STAGE_QUOTED: StageFacts = {
  id: uid(102),
  name: 'Quote sent',
  index: 2,
  openStages: 4,
};
export const STAGE_DECIDING: StageFacts = {
  id: uid(103),
  name: 'Deciding',
  index: 3,
  openStages: 4,
};

export const DALE = uid(900);
export const MARIA = uid(2);
export const NO_REPEAT: RepeatCustomerFacts = { otherWonLeads: 0, pastVisits: 0 };

/** A new web lead that came in five minutes ago, nobody has reached yet, with no value set. */
export function lead(over: Partial<LeadFacts> = {}): LeadFacts {
  return {
    id: uid(1),
    personId: MARIA,
    status: 'open',
    archived: false,
    valueCents: 0,
    createdAt: ago(5 * MIN),
    createdByPerson: false,
    imported: false,
    assigneeUserId: DALE,
    stage: STAGE_NEW,
    stageEnteredAt: ago(5 * MIN),
    nextAction: null,
    nextActionAt: null,
    firstResponseAt: null,
    lastContactAt: null,
    qualification: null,
    ...over,
  };
}
