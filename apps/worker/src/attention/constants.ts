/** The Action Center's job kinds, dedupe keys, timings and the events the worker records (M8). */

export const ATTENTION_JOBS = {
  /** Global and hourly (ensureRecurringJobs): every business has its sweep waiting. */
  plan: 'attention.plan',
  /** One per business, hourly: the whole business reconciled. */
  sweep: 'attention.sweep',
  /** One per subject, at the exact moment one of its kinds turns (begins to hold, turns urgent, expires). */
  recheck: 'attention.recheck',
  /** One per snoozed item, at its snooze time. */
  unsnooze: 'attention.unsnooze',
  /** One per item with an automatic action waiting: it goes out when the cancel window ends (auto.ts). */
  autoHandle: 'attention.auto_handle',
  /** One per item that turned urgent: the urgent email (alerts.ts). */
  urgentAlert: 'attention.urgent_alert',
  /** One per business, daily at 7 AM where it is: the morning summary (digest.ts). */
  digest: 'attention_digest.send',
} as const;

export const ATTENTION_PLAN_KEY = 'plan:attention';
export const sweepJobKey = (workspaceId: string): string => `attention-sweep:${workspaceId}`;
/** Per subject: `attention-recheck:lead:<id>`, `…:conversation:<id>`, `…:attendee:<id>`, `…:approval:<id>`, `…:task:<id>`. */
export const recheckJobKey = (subjectType: string, subjectId: string): string =>
  `attention-recheck:${subjectType}:${subjectId}`;
export const unsnoozeJobKey = (itemId: string): string => `attention-unsnooze:${itemId}`;
export const autoJobKey = (itemId: string): string => `attention-auto:${itemId}`;
export const alertJobKey = (itemId: string): string => `attention-alert:${itemId}`;
export const digestJobKey = (workspaceId: string): string => `attention-digest:${workspaceId}`;

const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** How often each business is swept. */
export const SWEEP_EVERY_MS = HOUR;
/** A sweep schedules only the rechecks due before the next sweep (plus this margin); that sweep sees the rest. */
export const SWEEP_HORIZON_MARGIN_MS = 5 * MINUTE;
/** When reconciling after an event fails, the subjects are looked at again this much later (the job retries). */
export const RETRY_RECHECK_MS = MINUTE;
/**
 * The first-sweep guard: an item that should have counted as urgent more than this long before the worker
 * noticed (data from before the Action Center, or a worker that was down) is marked as already alerted instead of
 * "becoming urgent", so no urgent email goes out about it.
 */
export const STALE_URGENCY_MS = DAY;

/** The morning summary's local time, worked out again each run so it follows daylight saving. */
export const DIGEST_SEND_AT = '07:00';
/** A text held for quiet hours goes out up to this long after they end, so many don't land at once. */
export const QUIET_JITTER_MS = 5 * MINUTE;
/** A sent confirmation request keeps its item handled until this long before the appointment starts. */
export const CONFIRM_HANDLED_UNTIL_MS = 12 * HOUR;

/** The worker's notes on real transitions, as event types (also the audit log's actions). */
export const ITEM_EVENTS = {
  opened: 'attention_item.opened',
  reopened: 'attention_item.reopened',
  unsnoozed: 'attention_item.snooze_ended',
  resolved: 'attention_item.resolved',
  urgent: 'attention_item.became_urgent',
} as const;
