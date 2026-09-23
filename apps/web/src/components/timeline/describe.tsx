/**
 * The timeline's wording lives in `@hfos/core` (M10 step 15), so the phone's record page says exactly what this one
 * says. This file keeps the names the timeline already imports, and turns core's dot **tone** into the web's classes.
 */
import { timelineTone, type TimelineTone } from '@hfos/core';
import type { TimelineEntry } from '@/lib/api/types';
import { fmtAt } from '@/lib/calendar/time';
import {
  describeTimeline as describeTimelineCore,
  isChannelEntry,
  timelineActor,
  timelineApproval,
  timelineBody,
  timelineRunId,
  timelineEditable,
} from '@hfos/core';

export {
  isChannelEntry,
  timelineActor,
  timelineApproval,
  timelineBody,
  timelineRunId,
  timelineEditable,
};

/**
 * The sentence after the actor's name, with the web's own appointment formatter. A business with no calendar yet has
 * no zone to pass, and this page has always read those times in the browser's own zone, so that is what it hands in.
 */
export function describeTimeline(
  e: TimelineEntry,
  recordType: 'person' | 'company' | 'lead' | 'custom_record',
  viewerId?: string,
  timeZone?: string,
): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return describeTimelineCore(e, recordType, viewerId, zone, fmtAt);
}

const DOT: Record<TimelineTone, string> = {
  // The AI teammate's entries wear its violet.
  ai: 'bg-[color-mix(in_oklab,#7c3aed_85%,var(--text))]',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-card-3',
};

export function timelineDotClass(e: TimelineEntry): string {
  return DOT[timelineTone(e)];
}
