import { change, newId } from '@/changes';

/**
 * The changes the Calendar makes. Each is one command from the phone's contract, under its own offline class
 * (`src/changes/commands.ts`):
 *
 * - **Asking for a time, moving one and cancelling one reach a customer**, so they are fresh-for-30-minutes: with no
 *   signal they wait on the phone and go by themselves when it comes back, and after half an hour the phone asks
 *   "Still send?" rather than texting somebody about a visit they may have rearranged since. Until HandsFreeOS
 *   answers, the screen shows the time as **"Not booked yet"** — nobody else's calendar has it.
 * - **Marking a visit complete or a no-show, and confirming a customer's attendance**, reach nobody, so they work with
 *   no signal for as long as it takes.
 *
 * None of them is refused for being offline, and none is sent twice: the command id is the phone's.
 */

export interface AskForTime {
  readonly workspaceId: string;
  readonly calendarId: string;
  /** The moment the visit starts, as an instant. */
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly serviceId: string | null;
  readonly personId: string | null;
  /** Who goes; left out, the calendar chooses (round robin, first free). */
  readonly userIds: readonly string[] | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly address: string | null;
  readonly leadId: string | null;
  /** Tell the customer it's booked. Reminders follow the calendar's settings either way. */
  readonly notify: boolean;
  /** Ask anyway, after the API warned about hours, buffers, busy time or a time in the past. */
  readonly acknowledgeWarnings?: boolean;
  /** The phone's own id for this booking, so asking twice books once. Made here when it isn't given. */
  readonly clientId?: string;
}

/**
 * Ask for a time. The phone makes the booking's `clientId`, so the same ask never books twice however often the queue
 * retries, and HandsFreeOS's own row comes back carrying it — which is how the screen knows the ask is through.
 */
export async function askForTime(a: AskForTime): Promise<{ id: string; clientId: string }> {
  const clientId = a.clientId ?? newId();
  const made = await change('appointment.create', {
    workspaceId: a.workspaceId,
    calendarId: a.calendarId,
    startsAt: a.startsAt,
    durationMinutes: a.durationMinutes,
    ...(a.serviceId ? { serviceId: a.serviceId } : {}),
    ...(a.userIds && a.userIds.length ? { userIds: [...a.userIds] } : {}),
    ...(a.personId ? { personId: a.personId } : {}),
    partySize: 1,
    ...(a.title ? { title: a.title } : {}),
    notes: a.notes ?? '',
    ...(a.address ? { location: { kind: 'customer_address' as const, address: a.address } } : {}),
    ...(a.leadId ? { leadId: a.leadId } : {}),
    acknowledgeWarnings: a.acknowledgeWarnings ?? false,
    clientId,
    notify: a.notify,
  });
  return { id: made.id, clientId };
}

/** Move a visit to another time. Fresh for 30 minutes, like asking for one. */
export function moveVisit(input: {
  workspaceId: string;
  appointmentId: string;
  startsAt: string;
  durationMinutes: number;
  notify: boolean;
  acknowledgeWarnings?: boolean;
}): Promise<{ id: string }> {
  return change('appointment.reschedule', {
    workspaceId: input.workspaceId,
    appointmentId: input.appointmentId,
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes,
    acknowledgeWarnings: input.acknowledgeWarnings ?? false,
    notify: input.notify,
  });
}

/** Call a visit off. The reason is kept in the history, never sent. */
export function cancelVisit(input: {
  workspaceId: string;
  appointmentId: string;
  reason: string;
  notify: boolean;
}): Promise<{ id: string }> {
  return change('appointment.cancel', {
    workspaceId: input.workspaceId,
    appointmentId: input.appointmentId,
    reason: input.reason,
    notify: input.notify,
  });
}

/** Mark a visit done, or that nobody was there. Works with no signal for as long as it takes. */
export function setVisitStatus(input: {
  workspaceId: string;
  appointmentId: string;
  status: 'completed' | 'no_show';
}): Promise<{ id: string }> {
  return change('appointment.set_status', input);
}

/**
 * Mark a customer's visit confirmed, or take the mark back. Reaches nobody — it records what they already told you —
 * so it works with no signal, and it shows on the screen the moment it is pressed.
 */
export function confirmSeat(input: {
  workspaceId: string;
  attendeeId: string;
  confirmed: boolean;
}): Promise<{ id: string }> {
  return change('attendee.confirm', input);
}

/**
 * M18: move a visit's job along. It reaches the customer (a text for each change), so a change that waited too long
 * for signal asks before it goes. On my way carries where the phone is, for the arrival time; never kept.
 */
export function setJobStatus(input: {
  workspaceId: string;
  appointmentId: string;
  status: 'scheduled' | 'on_the_way' | 'in_progress' | 'waiting_on_parts' | 'done';
  origin?: { lat: number; lng: number } | null;
}): Promise<{ id: string }> {
  return change('job.set_status', { ...input, notify: true });
}
