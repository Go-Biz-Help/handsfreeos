/**
 * Plain words about a calendar's settings: the builder's "How this calendar works" list and each module's
 * one-line summary. They live once, in `@hfos/core` (calendar/describe.ts), so the Assistant gives the same summary
 * the screen does; these are the web's names for them.
 */
export {
  CALENDAR_SECTIONS as MODULES,
  describeCalendar,
  joinWords,
  moduleOfField,
  moduleSummary,
  reservedNames,
  teamSentence,
  type CalendarSectionKey as ModuleKey,
} from '@hfos/core';
