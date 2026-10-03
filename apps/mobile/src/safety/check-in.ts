import {
  fmtTime,
  PushData,
  SAFETY_DEFAULTS,
  safetyAskWords,
  type PushData as PushDataType,
} from '@hfos/core';

/**
 * A check-in on this phone (round six, core): the one that's open, and the reminder the phone sets for its planned
 * end. The phone holds the person's own check-ins (records_v1), and a check-in made with no signal is written here at
 * once, so the banner, +15 min and check-out work before anything reaches HandsFreeOS.
 *
 * **The reminder** is the server's "Still at …?" push, made here: same category, same words, same buttons, and the
 * same notification id (`safety-<check-in>`), so when the server's arrives it takes the reminder's place rather than
 * showing twice. Its buttons carry command ids made here, so pressing one works like pressing the server's. What it
 * says comes from the phone's copy as the worker reads the database (apps/worker/src/safety/ladder.ts): the business's
 * name, time zone and times (Settings → Safety) and the contacts who'd be told. A teammate counts while they're on the
 * business's team here (the worker asks whether they can still open it, which the phone can't see for other people).
 */

/** Still going: neither checked out nor settled. */
export const OPEN_STATES: readonly string[] = ['in', 'asked', 'alerted', 'help'];

export interface CheckInRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly place: string;
  readonly planned_end_at: string;
  readonly started_at: string;
  readonly state: string;
  readonly appointment_id: string | null;
  readonly extended_count: number | null;
}

export interface ActiveCheckIn {
  readonly id: string;
  readonly workspaceId: string;
  readonly place: string;
  readonly plannedEndAt: string;
  readonly startedAt: string;
  readonly state: 'in' | 'asked' | 'alerted' | 'help';
  /** Past its planned end: the banner says so and asks. */
  readonly overdue: boolean;
  readonly appointmentId: string | null;
}

/** The person's open check-in in a business, newest first, or null. */
export function activeCheckIn(rows: readonly CheckInRow[], now: number): ActiveCheckIn | null {
  const open = rows
    .filter((r) => OPEN_STATES.includes(r.state))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
  if (!open) return null;
  return {
    id: open.id,
    workspaceId: open.workspace_id,
    place: open.place,
    plannedEndAt: new Date(Date.parse(open.planned_end_at)).toISOString(),
    startedAt: new Date(Date.parse(open.started_at)).toISOString(),
    state: open.state as ActiveCheckIn['state'],
    overdue: Date.parse(open.planned_end_at) <= now,
    appointmentId: open.appointment_id,
  };
}

/** When a check-in ends after +N minutes: from its planned end, or from now when that's passed (as the server adds). */
export function endAfterAdding(plannedEndAt: string, minutes: number, now: number): string {
  return new Date(Math.max(Date.parse(plannedEndAt), now) + minutes * 60_000).toISOString();
}

export const reminderId = (checkInId: string) => `safety-${checkInId}`;

/** The business's times from its settings (`workspaces.settings`, JSON), read and bounded as the worker reads them. */
export function safetyTimesOf(settings: string | null): {
  readonly askAfterMinutes: number;
  readonly alertAfterMinutes: number;
} {
  let safety: Record<string, unknown> = {};
  try {
    const parsed = settings ? (JSON.parse(settings) as { safety?: unknown }) : null;
    if (parsed?.safety && typeof parsed.safety === 'object')
      safety = parsed.safety as Record<string, unknown>;
  } catch {
    // Settings the phone can't read: the business's defaults.
  }
  const minutes = (k: 'askAfterMinutes' | 'alertAfterMinutes') => {
    const n = Number(safety[k]);
    return Number.isInteger(n) && n >= 0 && n <= 60 ? n : SAFETY_DEFAULTS[k];
  };
  return {
    askAfterMinutes: minutes('askAfterMinutes'),
    alertAfterMinutes: Math.max(1, minutes('alertAfterMinutes')),
  };
}

export interface ContactRow {
  readonly contact_user_id: string | null;
  readonly name: string;
  readonly agreed_at: string | null;
  readonly stopped_at: string | null;
}

/**
 * First names of the contacts who'd be told, in their order: teammates still on the team, and people outside who
 * agreed and haven't said STOP.
 */
export function toldOf(contacts: readonly ContactRow[], team: ReadonlySet<string>): string[] {
  return contacts
    .filter((k) => (k.contact_user_id ? team.has(k.contact_user_id) : k.agreed_at && !k.stopped_at))
    .map((k) => k.name.split(/\s+/)[0] ?? k.name);
}

/** When the person is asked: the planned end, plus the business's wait before asking. */
export const reminderAt = (plannedEndAt: string, askAfterMinutes: number): Date =>
  new Date(Date.parse(plannedEndAt) + askAfterMinutes * 60_000);

/** The reminder's push, as the server would send it at the planned end. */
export function reminderData(c: {
  readonly checkInId: string;
  readonly workspaceId: string;
  readonly business: string;
  readonly place: string;
  readonly plannedEndAt: string;
  readonly timeZone: string;
  /** First names of the contacts who'd be told. */
  readonly contacts: readonly string[];
  readonly alertAfterMinutes: number;
  readonly newId: () => string;
}): PushDataType {
  const words = safetyAskWords({
    place: c.place,
    plannedEnd: fmtTime(Date.parse(c.plannedEndAt), c.timeZone),
    alertAfterMinutes: c.alertAfterMinutes,
    contacts: c.contacts,
  });
  return PushData.parse({
    v: 1,
    notificationId: c.newId(),
    category: 'safety_check',
    workspaceId: c.workspaceId,
    business: c.business,
    path: `/app/w/${c.workspaceId}/safety`,
    sentAt: c.plannedEndAt,
    refs: { checkInId: c.checkInId },
    commandIds: { im_ok: c.newId(), add_15: c.newId() },
    collapseId: reminderId(c.checkInId),
    title: words.title,
    subtitle: `Safety · ${c.business}`,
    body: words.body,
  });
}
