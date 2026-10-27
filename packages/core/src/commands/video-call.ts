/**
 * HandsFreeOS video calls (docs/video-calls.md): an appointment's own call, carried by LiveKit, with nothing for the
 * business to connect. The worker holds LiveKit's keys: it opens a call when an appointment is booked for one, hands
 * out the tickets people join with once these commands say they may, and tells these commands who came and went
 * (LiveKit's webhooks). Everyone in a call is a row of `app.video_call_people`, whose id is their identity in the
 * room.
 *
 * - **The team** joins from the appointment (`video_call.join`): anyone who can see it and holds
 *   `appointments.write`, straight in.
 * - **A customer on their own Join link** (`video_call.enter`, the worker's) goes straight in once someone from the
 *   team is in the call. Until then they wait, and the people on the appointment get a push.
 * - **Anyone else** asks to be let in (`video_call.knock`): someone on the call's link who isn't on the team, or a
 *   second phone on a customer's link while they're already in. The team lets them in or turns them away.
 * - **In the call** the team can take someone out, mute them, or end the call for everyone. LiveKit is told by the
 *   worker, from the events.
 * - **When it ends**, the minutes everyone was in go on the balance (`video.minute`), once per stretch of the call.
 * - **The AI hears it** while the call's AI notes are on (part 2): the worker's listener sends what it heard a few
 *   lines at a time (`video_call.heard`), and when a stretch is over the lines become the appointment's transcript
 *   (`video_call.keep_words`), which today's After the call starts from. The team can turn the notes off for one
 *   call (`video_call.set_ai`), which forgets what was heard of it so far.
 * - **The Sales Coach hears it** too (part 3), while the AI notes are on: the listener makes the stretch of the call
 *   a live meeting for the person on the team it coaches (`video_call.coach`), and hands the words to the add-ons
 *   that listen, as with a Zoom meeting.
 */
import { and, asc, eq, inArray, lte, sql as dsql } from 'drizzle-orm';
import {
  appointmentAttendees,
  appointments,
  appointmentStaff,
  appointmentTranscripts,
  people,
  users,
  videoCallLines,
  videoCallPeople,
  videoCalls,
  workspaces,
} from '@hfos/db/schema';
import { rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { CommandContext, QueryContext } from '../kernel/types';
import {
  hostFirstName,
  sideOfKind,
  VIDEO_CALL_KINDS,
  VIDEO_CALL_MAX_PEOPLE,
  VIDEO_CALL_PERSON_STATES,
  VIDEO_CALL_STATES,
  videoCallTranscript,
  type VideoCallKind,
} from '../meetings/video-calls';
import { AppointmentLocation } from '../schemas/calendar';
import { isoDateTime, uuid } from '../schemas/common';
import { attendeeSetAttendance } from './attendance';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Most people waiting at once: past this, a call's link is being misused rather than shared. */
const MOST_WAITING = 20;

type CallRow = typeof videoCalls.$inferSelect;
type PersonRow = typeof videoCallPeople.$inferSelect;
type Tx = QueryContext['tx'];

const nameOf = (first: string | null, last: string | null) =>
  [first, last].filter(Boolean).join(' ').trim();
const iso = (d: Date | null) => (d ? d.toISOString() : null);
/** In the call now: came in and hasn't left since. */
const connected = (p: PersonRow) =>
  !!p.lastJoinedAt && (!p.leftAt || p.leftAt.getTime() < p.lastJoinedAt.getTime());

const notThere = () =>
  HfosError.notFound(
    'That video call isn’t there anymore, or isn’t one you can see. Open it again from the appointment.',
  );

const CallOut = z.object({
  id: uuid,
  state: z.enum(VIDEO_CALL_STATES),
  appointmentId: uuid.nullable(),
  personId: uuid.nullable(),
  hostUserId: uuid.nullable(),
  aiNotes: z.boolean(),
  startedAt: isoDateTime.nullable(),
  endedAt: isoDateTime.nullable(),
});

const PersonOut = z.object({
  id: uuid,
  kind: z.enum(VIDEO_CALL_KINDS),
  name: z.string(),
  state: z.enum(VIDEO_CALL_PERSON_STATES),
  userId: uuid.nullable(),
  personId: uuid.nullable(),
  /** In the call right now. */
  connected: z.boolean(),
  askedAt: isoDateTime.nullable(),
  joinedAt: isoDateTime.nullable(),
  leftAt: isoDateTime.nullable(),
  /** How long they've been in the call altogether, up to their last time leaving. */
  seconds: z.int(),
});

const callOut = (c: CallRow): z.infer<typeof CallOut> => ({
  id: c.id,
  state: c.state as z.infer<typeof CallOut>['state'],
  appointmentId: c.appointmentId,
  personId: c.personId,
  hostUserId: c.hostUserId,
  aiNotes: c.aiNotes,
  startedAt: iso(c.startedAt),
  endedAt: iso(c.endedAt),
});

const personOut = (p: PersonRow): z.infer<typeof PersonOut> => ({
  id: p.id,
  kind: p.kind as z.infer<typeof PersonOut>['kind'],
  name: p.name,
  state: p.state as z.infer<typeof PersonOut>['state'],
  userId: p.userId,
  personId: p.personId,
  connected: connected(p),
  askedAt: iso(p.askedAt),
  joinedAt: iso(p.joinedAt),
  leftAt: iso(p.leftAt),
  seconds: p.seconds,
});

/** The appointment's host (or its first person): who customers wait for, and whose name they see. */
async function hostOf(tx: Tx, appointmentId: string): Promise<string | null> {
  const staff = await tx
    .select({ userId: appointmentStaff.userId, role: appointmentStaff.role })
    .from(appointmentStaff)
    .where(
      and(eq(appointmentStaff.appointmentId, appointmentId), eq(appointmentStaff.active, true)),
    )
    .orderBy(asc(appointmentStaff.createdAt), asc(appointmentStaff.userId));
  return (staff.find((s) => s.role === 'host') ?? staff[0])?.userId ?? null;
}

async function userName(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await tx
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return null;
  return (u.fullName ?? '').trim() || String(u.email ?? '').split('@')[0] || null;
}

async function videoCallsOn(tx: Tx, workspaceId: string): Promise<boolean> {
  const [w] = await tx
    .select({ on: workspaces.videoCalls })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return w?.on === true;
}

const callsOff = () =>
  HfosError.rule(
    'video_calls_off',
    409,
    'HandsFreeOS video calls aren’t on for this business yet. Ask HandsFreeOS support to turn them on, or use Zoom, Google Meet or your own link for now.',
  );

const callFull = () =>
  HfosError.rule(
    'video_call_full',
    409,
    `This call is full: it has room for ${VIDEO_CALL_MAX_PEOPLE} people. Try again when someone leaves.`,
  );

/** The call for an appointment, made the first time it's asked for, its host kept in step with the appointment. */
async function callForAppointment(
  ctx: CommandContext,
  appointmentId: string,
): Promise<{ call: CallRow; created: boolean }> {
  const ws = ctx.scope.workspaceId!;
  const host = await hostOf(ctx.tx, appointmentId);
  const [made] = await ctx.tx
    .insert(videoCalls)
    .values({ workspaceId: ws, appointmentId, hostUserId: host })
    .onConflictDoNothing({
      target: videoCalls.appointmentId,
      where: dsql`appointment_id is not null`,
    })
    .returning();
  if (made) {
    await ctx.emit({
      type: 'video_call.opened',
      entityType: 'video_call',
      entityId: made.id,
      payload: { appointmentId, hostUserId: host },
      after: { appointmentId },
    });
    return { call: made, created: true };
  }
  const [call] = await ctx.tx
    .select()
    .from(videoCalls)
    .where(and(eq(videoCalls.workspaceId, ws), eq(videoCalls.appointmentId, appointmentId)))
    .for('update');
  if (!call) throw notThere();
  if (call.hostUserId !== host) {
    const [moved] = await ctx.tx
      .update(videoCalls)
      .set({ hostUserId: host })
      .where(eq(videoCalls.id, call.id))
      .returning();
    return { call: moved!, created: false };
  }
  return { call, created: false };
}

async function peopleOf(tx: Tx, callId: string): Promise<PersonRow[]> {
  return tx
    .select()
    .from(videoCallPeople)
    .where(eq(videoCallPeople.videoCallId, callId))
    .orderBy(asc(videoCallPeople.createdAt), asc(videoCallPeople.id));
}

const teamIsIn = (list: readonly PersonRow[]) =>
  list.some((p) => p.kind === 'team' && p.state === 'in' && connected(p));
const inCall = (list: readonly PersonRow[], except?: string) =>
  list.filter((p) => connected(p) && p.id !== except).length;

async function lockCall(ctx: CommandContext | QueryContext, callId: string): Promise<CallRow> {
  const [call] = await ctx.tx
    .select()
    .from(videoCalls)
    .where(and(eq(videoCalls.id, callId), eq(videoCalls.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!call) throw notThere();
  return call;
}

// ---------- the worker's: making the call, and letting customers in ----------

export const videoCallOpen = defineCommand({
  name: 'video_call.open',
  description:
    'Worker: make the HandsFreeOS video call for an online appointment set to one, or find the one it has.',
  risk: 0,
  input: z.object({ workspaceId: uuid, appointmentId: uuid }),
  output: z.object({ callId: uuid, created: z.boolean() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.opened'],
  async handler(ctx, input) {
    const { call, created } = await callForAppointment(ctx, input.appointmentId);
    return { callId: call.id, created };
  },
});

const EnterOutput = z.object({
  /**
   * in: given a ticket now (a second phone or a reload takes over from the first). waiting: nobody from the team is
   * in yet. removed: the team took them out, and they haven't asked to come back. knocking: they asked to come back,
   * and wait to be let in. full: no room.
   */
  status: z.enum(['in', 'waiting', 'removed', 'knocking', 'full']),
  callId: uuid,
  /** Their identity in the room: the row's id. A knock's is the guest row's; nobody's when it's full. */
  personId: uuid.nullable(),
  name: z.string(),
  /** Who they're waiting for, by first name. */
  host: z.string().nullable(),
});

/**
 * A customer opened their own Join link and pressed Join: straight in once the team is there, waiting until then.
 * Asked again while they wait, it answers again; only a new wait tells the team.
 */
export const videoCallEnter = defineCommand({
  name: 'video_call.enter',
  description:
    'Worker: a customer on their own Join link asks to come into the video call. In once someone from the team is there, waiting until then.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    attendeeId: uuid,
    name: z.string().trim().min(1).max(120),
    /** Taken out by the team, they pressed Ask to come back in: this asks to be let in, with this key's hash. */
    ask: z.boolean().default(false),
    knockKeyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  output: EnterOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.opened', 'video_call.waiting', 'video_call.knocked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [seat] = await ctx.tx
      .select({ a: appointmentAttendees, p: appointments })
      .from(appointmentAttendees)
      .innerJoin(appointments, eq(appointments.id, appointmentAttendees.appointmentId))
      .where(
        and(
          eq(appointmentAttendees.id, input.attendeeId),
          eq(appointmentAttendees.workspaceId, ws),
        ),
      );
    if (!seat)
      throw HfosError.notFound(
        'This Join link doesn’t open a call anymore. The booking may have been removed.',
      );
    if (seat.a.status === 'cancelled' || seat.p.status === 'cancelled')
      throw HfosError.rule(
        'booking_cancelled',
        409,
        'This booking was cancelled, so its video call is closed. To meet, book again with the business.',
      );
    const place = AppointmentLocation.safeParse(seat.p.location ?? {});
    if (!place.success || place.data.kind !== 'virtual' || place.data.video !== 'handsfree')
      throw HfosError.rule(
        'not_a_video_call',
        409,
        'This appointment isn’t a HandsFreeOS video call. Use the link in your confirmation.',
      );
    if (!(await videoCallsOn(ctx.tx, ws))) throw callsOff();
    const { call } = await callForAppointment(ctx, seat.p.id);
    await lockCall(ctx, call.id);
    const host = hostFirstName(await userName(ctx.tx, call.hostUserId));
    const list = await peopleOf(ctx.tx, call.id);
    const mine = list.find((p) => p.kind === 'customer' && p.attendeeId === input.attendeeId);
    const say = (status: z.infer<typeof EnterOutput>['status'], row: PersonRow | null) => ({
      status,
      callId: call.id,
      personId: row?.id ?? null,
      name: row?.name ?? input.name,
      host,
    });

    // Taken out by the team: they come back only by asking to be let in, like anyone else.
    if (mine?.state === 'removed') {
      if (!input.ask) return say('removed', mine);
      if (!input.knockKeyHash)
        throw HfosError.validation(
          [{ path: 'knockKeyHash', message: 'Required.' }],
          'Asking to be let in needs a key. Refresh the page and try again.',
        );
      const knock = await knockRow(ctx, call, {
        name: input.name,
        personId: seat.a.personId,
        knockKeyHash: input.knockKeyHash,
      });
      return say('knocking', knock);
    }
    if (inCall(list, mine?.id) >= VIDEO_CALL_MAX_PEOPLE) return say('full', mine ?? null);
    const there = teamIsIn(list);
    const now = new Date();
    if (!mine) {
      const [row] = await ctx.tx
        .insert(videoCallPeople)
        .values({
          workspaceId: ws,
          videoCallId: call.id,
          kind: 'customer',
          attendeeId: input.attendeeId,
          personId: seat.a.personId,
          name: input.name,
          state: there ? 'admitted' : 'waiting',
          askedAt: now,
          admittedAt: there ? now : null,
        })
        .returning();
      if (!there) await waiting(ctx, call, row!, seat.p.title);
      return say(there ? 'in' : 'waiting', row!);
    }
    if (there) {
      const [row] = await ctx.tx
        .update(videoCallPeople)
        .set({ state: 'admitted', admittedAt: now, name: input.name })
        .where(eq(videoCallPeople.id, mine.id))
        .returning();
      return say('in', row!);
    }
    if (mine.state === 'waiting') {
      if (mine.name !== input.name)
        await ctx.tx
          .update(videoCallPeople)
          .set({ name: input.name })
          .where(eq(videoCallPeople.id, mine.id));
      return say('waiting', { ...mine, name: input.name });
    }
    // Back to waiting (they left, or were let in and the team has gone): a new wait, so the team hears.
    const [row] = await ctx.tx
      .update(videoCallPeople)
      .set({ state: 'waiting', askedAt: now, name: input.name })
      .where(eq(videoCallPeople.id, mine.id))
      .returning();
    await waiting(ctx, call, row!, seat.p.title);
    return say('waiting', row!);
  },
});

async function waiting(ctx: CommandContext, call: CallRow, row: PersonRow, title: string) {
  await ctx.emit({
    type: 'video_call.waiting',
    entityType: 'video_call',
    entityId: call.id,
    payload: {
      appointmentId: call.appointmentId,
      personRowId: row.id,
      personId: row.personId,
      name: row.name,
      title,
    },
    after: { name: row.name, state: 'waiting' },
  });
}

async function knockRow(
  ctx: CommandContext,
  call: CallRow,
  who: { name: string; personId: string | null; knockKeyHash: string },
): Promise<PersonRow> {
  const ws = ctx.scope.workspaceId!;
  const [{ n } = { n: 0 }] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from app.video_call_people
        where video_call_id = ${call.id} and state = 'waiting'`,
  );
  if (n >= MOST_WAITING)
    throw HfosError.rule(
      'video_call_busy',
      429,
      'Too many people are asking to join this call right now. Try again in a few minutes.',
    );
  const [row] = await ctx.tx
    .insert(videoCallPeople)
    .values({
      workspaceId: ws,
      videoCallId: call.id,
      kind: 'guest',
      personId: who.personId,
      name: who.name,
      state: 'waiting',
      knockKeyHash: who.knockKeyHash,
      askedAt: new Date(),
    })
    .returning();
  const [appt] = call.appointmentId
    ? await ctx.tx
        .select({ title: appointments.title })
        .from(appointments)
        .where(eq(appointments.id, call.appointmentId))
    : [];
  await ctx.emit({
    type: 'video_call.knocked',
    entityType: 'video_call',
    entityId: call.id,
    payload: {
      appointmentId: call.appointmentId,
      personRowId: row!.id,
      personId: who.personId,
      name: who.name,
      title: appt?.title ?? 'Video call',
    },
    after: { name: who.name, state: 'waiting' },
  });
  return row!;
}

/** Someone on the call's link who isn't on the team asks to be let in. */
export const videoCallKnock = defineCommand({
  name: 'video_call.knock',
  description:
    'Worker: someone on a video call’s link who isn’t on the team asks to be let in. The team lets them in or turns them away.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    name: z.string().trim().min(1).max(120),
    /** The hash of the key only their page holds, so only they can ask how it went. */
    knockKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  output: z.object({ personId: uuid, host: z.string().nullable() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.knocked'],
  async handler(ctx, input) {
    if (!(await videoCallsOn(ctx.tx, ctx.scope.workspaceId!))) throw callsOff();
    const call = await lockCall(ctx, input.callId);
    const row = await knockRow(ctx, call, {
      name: input.name,
      personId: null,
      knockKeyHash: input.knockKeyHash,
    });
    return { personId: row.id, host: hostFirstName(await userName(ctx.tx, call.hostUserId)) };
  },
});

// ---------- the worker's: what LiveKit says happened ----------

const PresenceInput = z.object({
  workspaceId: uuid,
  callId: uuid,
  /** Their identity in the room: a row's id. */
  personId: uuid,
  /** LiveKit's id for the room as it runs now. */
  roomSid: z.string().trim().min(1).max(100).nullable().default(null),
  /** LiveKit's id for this connection: a reload or a second phone is a new one, which takes over. */
  participantSid: z.string().trim().min(1).max(100).nullable().default(null),
  at: isoDateTime.optional(),
});

/**
 * Someone LiveKit let in with a ticket they shouldn't use any more, so the worker takes them out again: taken out or
 * turned away, or back in a call that ended before anyone from the team is in it again.
 */
const kickedFrom = (call: CallRow, p: PersonRow | undefined, list: readonly PersonRow[]) =>
  !p ||
  p.state === 'removed' ||
  p.state === 'turned_away' ||
  (call.state === 'ended' && p.kind !== 'team' && !teamIsIn(list));

export const videoCallJoined = defineCommand({
  name: 'video_call.joined',
  description: 'Worker: LiveKit says someone came into a video call.',
  risk: 0,
  input: PresenceInput,
  /** kick: they came in on a ticket they shouldn't use any more (taken out, or the call was ended): take them out. */
  output: z.object({ changed: z.boolean(), kick: z.boolean() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.person_joined', 'video_call.started'],
  async handler(ctx, input) {
    const call = await lockCall(ctx, input.callId);
    const at = input.at ? new Date(input.at) : new Date();
    const [p] = await ctx.tx
      .select()
      .from(videoCallPeople)
      .where(and(eq(videoCallPeople.id, input.personId), eq(videoCallPeople.videoCallId, call.id)))
      .for('update');
    const list = call.state === 'ended' ? await peopleOf(ctx.tx, call.id) : [];
    if (kickedFrom(call, p, list)) return { changed: false, kick: true };
    const person = p!;
    // The same connection told twice.
    if (input.participantSid && person.participantSid === input.participantSid)
      return { changed: false, kick: false };
    if (call.state !== 'live') {
      await ctx.tx
        .update(videoCalls)
        .set({
          state: 'live',
          startedAt: call.startedAt ?? at,
          endedAt: null,
          roomSid: input.roomSid ?? call.roomSid,
        })
        .where(eq(videoCalls.id, call.id));
      await ctx.emit({
        type: 'video_call.started',
        entityType: 'video_call',
        entityId: call.id,
        payload: { appointmentId: call.appointmentId, roomSid: input.roomSid },
      });
    } else if (input.roomSid && call.roomSid !== input.roomSid) {
      await ctx.tx
        .update(videoCalls)
        .set({ roomSid: input.roomSid })
        .where(eq(videoCalls.id, call.id));
    }
    // A reload or a second phone: the new connection takes over, and their time in the call carries on.
    if (connected(person)) {
      await ctx.tx
        .update(videoCallPeople)
        .set({ participantSid: input.participantSid })
        .where(eq(videoCallPeople.id, person.id));
      return { changed: false, kick: false };
    }
    await ctx.tx
      .update(videoCallPeople)
      .set({
        state: 'in',
        joinedAt: person.joinedAt ?? at,
        lastJoinedAt: at,
        participantSid: input.participantSid,
      })
      .where(eq(videoCallPeople.id, person.id));
    await ctx.emit({
      type: 'video_call.person_joined',
      entityType: 'video_call',
      entityId: call.id,
      payload: {
        appointmentId: call.appointmentId,
        personRowId: person.id,
        kind: person.kind,
        userId: person.userId,
        personId: person.personId,
        attendeeId: person.attendeeId,
      },
      after: { name: person.name },
    });
    // A customer really came into the call: that's joining, for attendance and workflows.
    if (person.kind === 'customer' && person.attendeeId)
      await executeCommandWithin(ctx, attendeeSetAttendance, {
        workspaceId: ctx.scope.workspaceId!,
        attendeeId: person.attendeeId,
        attendance: 'joined',
      }).catch((e: unknown) => {
        // A cancelled booking has no attendance to mark; they were still in the call.
        if (!(e instanceof HfosError && e.rule === 'booking_cancelled')) throw e;
      });
    return { changed: true, kick: false };
  },
});

export const videoCallLeft = defineCommand({
  name: 'video_call.left',
  description: 'Worker: LiveKit says someone left a video call.',
  risk: 0,
  input: PresenceInput,
  output: z.object({ changed: z.boolean(), seconds: z.int() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.person_left'],
  async handler(ctx, input) {
    const call = await lockCall(ctx, input.callId);
    const at = input.at ? new Date(input.at) : new Date();
    const [p] = await ctx.tx
      .select()
      .from(videoCallPeople)
      .where(and(eq(videoCallPeople.id, input.personId), eq(videoCallPeople.videoCallId, call.id)))
      .for('update');
    if (!p || !connected(p)) return { changed: false, seconds: 0 };
    // An old connection a reload or a second phone took over from: they're still in the call.
    if (input.participantSid && p.participantSid && p.participantSid !== input.participantSid)
      return { changed: false, seconds: 0 };
    const stay = Math.max(0, Math.round((at.getTime() - p.lastJoinedAt!.getTime()) / 1000));
    const [row] = await ctx.tx
      .update(videoCallPeople)
      .set({
        state: p.state === 'in' ? 'left' : p.state,
        leftAt: at,
        seconds: p.seconds + stay,
        participantSid: null,
      })
      .where(eq(videoCallPeople.id, p.id))
      .returning();
    await ctx.emit({
      type: 'video_call.person_left',
      entityType: 'video_call',
      entityId: call.id,
      payload: {
        appointmentId: call.appointmentId,
        personRowId: p.id,
        kind: p.kind,
        seconds: row!.seconds,
      },
      after: { name: p.name },
    });
    return { changed: true, seconds: row!.seconds };
  },
});

/**
 * LiveKit closed the room: everyone left and it stayed empty, or the team ended it. Anyone still marked in is closed
 * now, and the minutes since the last stretch was charged go on the balance (the `video_call.ended` event's).
 */
export const videoCallFinished = defineCommand({
  name: 'video_call.finished',
  description: 'Worker: LiveKit closed a video call’s room, so the stretch of the call is over.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    roomSid: z.string().trim().min(1).max(100).nullable().default(null),
    at: isoDateTime.optional(),
  }),
  output: z.object({ changed: z.boolean(), seconds: z.int() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.ended'],
  async handler(ctx, input) {
    const call = await lockCall(ctx, input.callId);
    // Late news of a room already closed, or of one before the call started again: nothing more to close.
    if (input.roomSid && call.roomSid !== input.roomSid) return { changed: false, seconds: 0 };
    const at = input.at ? new Date(input.at) : new Date();
    const list = await peopleOf(ctx.tx, call.id);
    for (const p of list.filter(connected)) {
      const stay = Math.max(0, Math.round((at.getTime() - p.lastJoinedAt!.getTime()) / 1000));
      await ctx.tx
        .update(videoCallPeople)
        .set({
          state: p.state === 'in' ? 'left' : p.state,
          leftAt: at,
          seconds: p.seconds + stay,
          participantSid: null,
        })
        .where(eq(videoCallPeople.id, p.id));
    }
    // Let in but never came: they can ask again.
    await ctx.tx
      .update(videoCallPeople)
      .set({ state: 'left' })
      .where(and(eq(videoCallPeople.videoCallId, call.id), eq(videoCallPeople.state, 'admitted')));
    const [{ total } = { total: 0 }] = await rows<{ total: number }>(
      ctx.tx,
      sql`select coalesce(sum(seconds), 0)::int as total from app.video_call_people
          where video_call_id = ${call.id}`,
    );
    const seconds = Math.max(0, total - call.secondsBilled);
    const people = list.filter((p) => p.joinedAt || connected(p)).length;
    if (call.state === 'ended' && seconds === 0 && !call.roomSid)
      return { changed: false, seconds: 0 };
    await ctx.tx
      .update(videoCalls)
      .set({
        state: 'ended',
        endedAt: call.endedAt && call.state === 'ended' ? call.endedAt : at,
        roomSid: null,
        secondsBilled: Math.max(total, call.secondsBilled),
      })
      .where(eq(videoCalls.id, call.id));
    await ctx.emit({
      type: 'video_call.ended',
      entityType: 'video_call',
      entityId: call.id,
      payload: {
        appointmentId: call.appointmentId,
        roomSid: input.roomSid ?? call.roomSid,
        // Person-seconds in this stretch, for the balance.
        seconds,
        // Everyone the total covers, for "7 min · 2 people" on the statement.
        people,
        total,
        // When the stretch ended: what the AI heard up to here is its transcript (video_call.keep_words).
        endedAt: at.toISOString(),
      },
      after: { state: 'ended' },
    });
    return { changed: true, seconds };
  },
});

// ---------- the team's ----------

const JoinOutput = z.object({
  call: CallOut,
  /** Their identity in the room. */
  personId: uuid,
  name: z.string(),
});

/** A teammate joins from the appointment: straight in. A call that was ended starts again. */
export const videoCallJoin = defineCommand({
  name: 'video_call.join',
  description: 'Join a HandsFreeOS video call as someone from the team.',
  risk: 1,
  input: z.object({ workspaceId: uuid, callId: uuid }),
  output: JoinOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.team_joining'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    if (!(await videoCallsOn(ctx.tx, ws))) throw callsOff();
    let call = await lockCall(ctx, input.callId);
    const list = await peopleOf(ctx.tx, call.id);
    const mine = list.find((p) => p.kind === 'team' && p.userId === me);
    if ((!mine || !connected(mine)) && inCall(list, mine?.id) >= VIDEO_CALL_MAX_PEOPLE)
      throw callFull();
    const name = (await userName(ctx.tx, me)) ?? 'Team member';
    const now = new Date();
    if (call.state === 'ended') {
      const [again] = await ctx.tx
        .update(videoCalls)
        .set({ state: 'open' })
        .where(eq(videoCalls.id, call.id))
        .returning();
      call = again!;
    }
    let row: PersonRow;
    if (!mine) {
      [row] = (await ctx.tx
        .insert(videoCallPeople)
        .values({
          workspaceId: ws,
          videoCallId: call.id,
          kind: 'team',
          userId: me,
          name,
          state: 'admitted',
          admittedAt: now,
          admittedBy: me,
        })
        .returning()) as [PersonRow];
    } else if (connected(mine)) {
      row = mine;
    } else {
      [row] = (await ctx.tx
        .update(videoCallPeople)
        .set({ state: 'admitted', admittedAt: now, admittedBy: me, name })
        .where(eq(videoCallPeople.id, mine.id))
        .returning()) as [PersonRow];
    }
    if (!mine || !connected(mine))
      await ctx.emit({
        type: 'video_call.team_joining',
        entityType: 'video_call',
        entityId: call.id,
        payload: { appointmentId: call.appointmentId, personRowId: row.id, userId: me },
        broadcast: false,
      });
    return { call: callOut(call), personId: row.id, name: row.name };
  },
});

const PersonInput = z.object({ workspaceId: uuid, callId: uuid, personId: uuid });

async function lockPerson(ctx: CommandContext, callId: string, personId: string) {
  const call = await lockCall(ctx, callId);
  const [p] = await ctx.tx
    .select()
    .from(videoCallPeople)
    .where(and(eq(videoCallPeople.id, personId), eq(videoCallPeople.videoCallId, call.id)))
    .for('update');
  if (!p)
    throw HfosError.notFound(
      'That person isn’t on this call anymore. The list will catch up in a moment.',
    );
  return { call, p };
}

export const videoCallAdmit = defineCommand({
  name: 'video_call.admit',
  description: 'Let someone who is waiting into a HandsFreeOS video call.',
  risk: 1,
  input: PersonInput,
  output: z.object({ changed: z.boolean() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.admitted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const { call, p } = await lockPerson(ctx, input.callId, input.personId);
    if (p.state === 'admitted' || connected(p)) return { changed: false };
    if (p.state !== 'waiting')
      throw HfosError.rule(
        'video_call_not_waiting',
        409,
        `${p.name} isn’t waiting anymore, so there’s nobody to let in. They can ask again from their link.`,
      );
    const list = await peopleOf(ctx.tx, call.id);
    if (inCall(list) >= VIDEO_CALL_MAX_PEOPLE) throw callFull();
    await ctx.tx
      .update(videoCallPeople)
      .set({ state: 'admitted', admittedAt: new Date(), admittedBy: me })
      .where(eq(videoCallPeople.id, p.id));
    await ctx.emit({
      type: 'video_call.admitted',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId, personRowId: p.id, kind: p.kind },
      after: { name: p.name, state: 'admitted' },
    });
    return { changed: true };
  },
});

export const videoCallTurnAway = defineCommand({
  name: 'video_call.turn_away',
  description: 'Turn away someone who is asking to join a HandsFreeOS video call.',
  risk: 1,
  input: PersonInput,
  output: z.object({ changed: z.boolean() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.turned_away'],
  async handler(ctx, input) {
    const { call, p } = await lockPerson(ctx, input.callId, input.personId);
    if (p.state === 'turned_away') return { changed: false };
    if (p.state !== 'waiting')
      throw HfosError.rule(
        'video_call_not_waiting',
        409,
        `${p.name} isn’t waiting anymore. To take them out of the call, use Remove.`,
      );
    await ctx.tx
      .update(videoCallPeople)
      .set({ state: 'turned_away' })
      .where(eq(videoCallPeople.id, p.id));
    await ctx.emit({
      type: 'video_call.turned_away',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId, personRowId: p.id, kind: p.kind },
      after: { name: p.name, state: 'turned_away' },
    });
    return { changed: true };
  },
});

/** Takes someone out of the call. A customer taken out has to be let in again; the worker tells LiveKit. */
export const videoCallRemove = defineCommand({
  name: 'video_call.remove',
  description:
    'Take someone out of a HandsFreeOS video call. To come back they have to be let in again.',
  risk: 2,
  input: PersonInput,
  output: z.object({ changed: z.boolean() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.person_removed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const { call, p } = await lockPerson(ctx, input.callId, input.personId);
    if (p.kind === 'team' && p.userId === me)
      throw HfosError.rule('video_call_remove_self', 409, 'That’s you. To go, press Leave.');
    if (p.state === 'removed') return { changed: false };
    if (!connected(p) && p.state !== 'admitted' && p.state !== 'waiting') return { changed: false };
    await ctx.tx
      .update(videoCallPeople)
      .set({ state: 'removed' })
      .where(eq(videoCallPeople.id, p.id));
    await ctx.emit({
      type: 'video_call.person_removed',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId, personRowId: p.id, kind: p.kind },
      after: { name: p.name, state: 'removed' },
    });
    return { changed: true };
  },
});

/** Mutes someone's microphone. Only they can turn it back on. */
export const videoCallMute = defineCommand({
  name: 'video_call.mute',
  description:
    'Mute someone’s microphone in a HandsFreeOS video call. Only they can turn it back on.',
  risk: 1,
  input: PersonInput,
  output: z.object({ requested: z.boolean() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.mute_requested'],
  async handler(ctx, input) {
    const { call, p } = await lockPerson(ctx, input.callId, input.personId);
    if (!connected(p)) return { requested: false };
    await ctx.emit({
      type: 'video_call.mute_requested',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId, personRowId: p.id },
      after: { name: p.name },
      broadcast: false,
    });
    return { requested: true };
  },
});

/** Ends the call for everyone in it. Anyone can start it again the usual way. */
export const videoCallEnd = defineCommand({
  name: 'video_call.end',
  description:
    'End a HandsFreeOS video call for everyone in it. The team can start it again from the appointment.',
  risk: 2,
  input: z.object({ workspaceId: uuid, callId: uuid }),
  output: z.object({ changed: z.boolean() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.ended_by_host'],
  async handler(ctx, input) {
    const call = await lockCall(ctx, input.callId);
    if (call.state === 'ended') return { changed: false };
    await ctx.tx.update(videoCalls).set({ state: 'ended' }).where(eq(videoCalls.id, call.id));
    // Nobody waits for a call that's over.
    await ctx.tx
      .update(videoCallPeople)
      .set({ state: 'turned_away' })
      .where(
        and(
          eq(videoCallPeople.videoCallId, call.id),
          eq(videoCallPeople.state, 'waiting'),
          eq(videoCallPeople.kind, 'guest'),
        ),
      );
    await ctx.emit({
      type: 'video_call.ended_by_host',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId },
      before: { state: call.state },
      after: { state: 'ended' },
    });
    return { changed: true };
  },
});

// ---------- reading ----------

const GetOutput = z.object({
  call: CallOut.nullable(),
  appointment: z
    .object({
      id: uuid,
      title: z.string(),
      startsAt: isoDateTime,
      endsAt: isoDateTime,
      status: z.string(),
      customers: z.array(z.object({ personId: uuid, name: z.string() })),
    })
    .nullable(),
  host: z.object({ userId: uuid, name: z.string() }).nullable(),
  /** Everyone who has been in the call, is in it, or is asking to come in, oldest first. */
  people: z.array(PersonOut),
});

/** A call, from its id or its appointment's: who's in it and who's waiting, for the call page and the appointment. */
export const videoCallGet = defineQuery({
  name: 'video_call.get',
  description:
    'A HandsFreeOS video call: its appointment, who is in it, who has been, and who is waiting to be let in.',
  input: z
    .object({ workspaceId: uuid, callId: uuid.optional(), appointmentId: uuid.optional() })
    .refine((i) => !!i.callId !== !!i.appointmentId, {
      error: 'Name the call or its appointment, not both.',
    }),
  output: GetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [call] = await ctx.tx
      .select()
      .from(videoCalls)
      .where(
        and(
          eq(videoCalls.workspaceId, ws),
          input.callId
            ? eq(videoCalls.id, input.callId)
            : eq(videoCalls.appointmentId, input.appointmentId!),
        ),
      );
    if (!call) {
      if (input.callId) throw notThere();
      return { call: null, appointment: null, host: null, people: [] };
    }
    const [appt] = call.appointmentId
      ? await ctx.tx
          .select({
            id: appointments.id,
            title: appointments.title,
            startsAt: appointments.startsAt,
            endsAt: appointments.endsAt,
            status: appointments.status,
          })
          .from(appointments)
          .where(eq(appointments.id, call.appointmentId))
      : [];
    const customers = appt
      ? await ctx.tx
          .select({ personId: people.id, first: people.firstName, last: people.lastName })
          .from(appointmentAttendees)
          .innerJoin(people, eq(people.id, appointmentAttendees.personId))
          .where(
            and(
              eq(appointmentAttendees.appointmentId, appt.id),
              inArray(appointmentAttendees.status, ['booked', 'attended', 'no_show']),
            ),
          )
          .orderBy(asc(appointmentAttendees.createdAt))
          .limit(20)
      : [];
    const list = await peopleOf(ctx.tx, call.id);
    const hostName = await userName(ctx.tx, call.hostUserId);
    return {
      call: callOut(call),
      appointment: appt
        ? {
            id: appt.id,
            title: appt.title,
            startsAt: appt.startsAt.toISOString(),
            endsAt: appt.endsAt.toISOString(),
            status: appt.status,
            customers: customers.map((c) => ({
              personId: c.personId,
              name: nameOf(c.first, c.last) || 'Unnamed customer',
            })),
          }
        : null,
      host: call.hostUserId && hostName ? { userId: call.hostUserId, name: hostName } : null,
      // A knock turned away long ago is history nobody needs on the call page.
      people: list.filter((p) => p.state !== 'turned_away' || p.joinedAt).map(personOut),
    };
  },
});

const knockStatus = (call: CallRow, p: PersonRow, list: readonly PersonRow[]) => {
  if (p.state === 'admitted' || connected(p)) return 'in' as const;
  if (p.state === 'waiting') return 'waiting' as const;
  if (p.state === 'turned_away') return 'turned_away' as const;
  if (p.state === 'removed') return 'removed' as const;
  // Let in before, and gone: back in while the call goes on with the team in it, else they ask again.
  return call.state !== 'ended' && teamIsIn(list) ? ('in' as const) : ('left' as const);
};

/**
 * How a request to join stands, for the page that's waiting on it (the worker's, every few seconds). Only that page
 * holds the key, so its hash is what shows it's theirs. `in`: let in, or let in before and the call is still going
 * with the team in it, so the page may have a ticket.
 */
export const videoCallKnockStatus = defineQuery({
  name: 'video_call.knock_status',
  description:
    'Worker: how a request to join a HandsFreeOS video call stands, for the page that asked.',
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    personId: uuid,
    knockKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  output: z.object({
    status: z.enum(['waiting', 'in', 'turned_away', 'removed', 'left']),
    name: z.string(),
    host: z.string().nullable(),
  }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const [call] = await ctx.tx
      .select()
      .from(videoCalls)
      .where(
        and(eq(videoCalls.id, input.callId), eq(videoCalls.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!call) throw notThere();
    const list = await peopleOf(ctx.tx, call.id);
    const p = list.find((x) => x.id === input.personId);
    if (!p || p.kind !== 'guest' || p.knockKeyHash !== input.knockKeyHash)
      throw HfosError.notFound(
        'We can’t find your request to join this call. Ask again from the call’s link.',
      );
    const status = knockStatus(call, p, list);
    return { status, name: p.name, host: hostFirstName(await userName(ctx.tx, call.hostUserId)) };
  },
});

// ---------- the AI hearing the call (part 2) ----------

/**
 * AI notes on or off for one call (the owner's 8a): the team's to turn. Off, the listener leaves within seconds and
 * what it heard of the call so far is forgotten, so the call gets no notes or suggestions from it; on again, it
 * listens from then on.
 */
export const videoCallSetAi = defineCommand({
  name: 'video_call.set_ai',
  description:
    'Turn the AI’s notes on or off for one HandsFreeOS video call. Turning them off forgets what the AI heard of the call so far.',
  risk: 1,
  input: z.object({ workspaceId: uuid, callId: uuid, on: z.boolean() }),
  output: z.object({ changed: z.boolean(), aiNotes: z.boolean() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.ai_changed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const call = await lockCall(ctx, input.callId);
    if (call.aiNotes === input.on) return { changed: false, aiNotes: call.aiNotes };
    await ctx.tx.update(videoCalls).set({ aiNotes: input.on }).where(eq(videoCalls.id, call.id));
    const forgotten = input.on
      ? []
      : await ctx.tx
          .delete(videoCallLines)
          .where(eq(videoCallLines.videoCallId, call.id))
          .returning({ id: videoCallLines.id });
    await ctx.emit({
      type: 'video_call.ai_changed',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId, on: input.on, forgotten: forgotten.length },
      before: { aiNotes: call.aiNotes },
      after: { aiNotes: input.on },
    });
    return { changed: true, aiNotes: input.on };
  },
});

const HeardLine = z.object({
  /** The listener's own name for the line, so a batch sent twice keeps one copy. */
  key: z.string().trim().min(1).max(100),
  /** Who said it: their identity in the room, a row of the call's people. */
  personId: uuid,
  text: z.string().trim().min(1).max(4000),
  saidAt: isoDateTime,
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable()
    .default(null),
});

/**
 * What the listener heard, a few lines at a time, kept until the stretch of the call is over. Lines from someone who
 * isn't on the call are dropped, and nothing is kept once the call's AI notes are off: the listener is on its way
 * out, and what it heard is forgotten.
 */
export const videoCallHeard = defineCommand({
  name: 'video_call.heard',
  description:
    'Worker: what the AI’s listener heard in a HandsFreeOS video call, a few lines at a time.',
  risk: 0,
  input: z.object({ workspaceId: uuid, callId: uuid, lines: z.array(HeardLine).min(1).max(200) }),
  output: z.object({ kept: z.int() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    // Locked, so a batch can't land just after the team turned the notes off and their words were forgotten.
    const call = await lockCall(ctx, input.callId);
    if (!call.aiNotes) return { kept: 0 };
    const byId = new Map((await peopleOf(ctx.tx, call.id)).map((p) => [p.id, p]));
    const values = input.lines.flatMap((l) => {
      const p = byId.get(l.personId);
      return p
        ? [
            {
              workspaceId: call.workspaceId,
              videoCallId: call.id,
              personRowId: p.id,
              side: sideOfKind(p.kind as VideoCallKind),
              name: p.name,
              body: l.text,
              language: l.language,
              saidAt: new Date(l.saidAt),
              lineKey: l.key,
            },
          ]
        : [];
    });
    if (!values.length) return { kept: 0 };
    const kept = await ctx.tx
      .insert(videoCallLines)
      .values(values)
      .onConflictDoNothing({ target: [videoCallLines.videoCallId, videoCallLines.lineKey] })
      .returning({ id: videoCallLines.id });
    return { kept: kept.length };
  },
});

/** Fewer words than this isn't a conversation worth notes ("Can you hear me?"): it's dropped, not kept. */
export const VIDEO_CALL_TRANSCRIPT_MIN_WORDS = 15;

/**
 * A stretch of the call is over: what the listener heard up to its end becomes the appointment's transcript, which
 * the AI's notes and suggestions start from as with Zoom's (`appointment.transcript_ready`), and the lines go. Once
 * per stretch: the same stretch again keeps nothing more.
 */
export const videoCallKeepWords = defineCommand({
  name: 'video_call.keep_words',
  description:
    'Worker: a stretch of a HandsFreeOS video call is over, so what the AI heard becomes the appointment’s transcript.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    /** The end of the stretch: lines said up to here are its. */
    until: isoDateTime,
    /** The stretch's own name (LiveKit's room id), which its transcript is kept under. */
    stretch: z.string().trim().min(1).max(100),
  }),
  output: z.object({ transcriptId: uuid.nullable(), lines: z.int() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['appointment.transcript_ready'],
  async handler(ctx, input) {
    const call = await lockCall(ctx, input.callId);
    const lines = await ctx.tx
      .select()
      .from(videoCallLines)
      .where(
        and(
          eq(videoCallLines.videoCallId, call.id),
          lte(videoCallLines.saidAt, new Date(input.until)),
        ),
      )
      .orderBy(asc(videoCallLines.saidAt), asc(videoCallLines.createdAt));
    if (!lines.length) return { transcriptId: null, lines: 0 };
    await ctx.tx.delete(videoCallLines).where(
      inArray(
        videoCallLines.id,
        lines.map((l) => l.id),
      ),
    );
    const words = lines.reduce((n, l) => n + l.body.split(/\s+/).filter(Boolean).length, 0);
    // Calls that aren't for an appointment keep their words with the customer (part 5).
    if (!call.appointmentId || !call.aiNotes || words < VIDEO_CALL_TRANSCRIPT_MIN_WORDS)
      return { transcriptId: null, lines: lines.length };
    const [appt] = await ctx.tx
      .select({ id: appointments.id, title: appointments.title })
      .from(appointments)
      .where(eq(appointments.id, call.appointmentId));
    if (!appt) return { transcriptId: null, lines: lines.length };
    const [row] = await ctx.tx
      .insert(appointmentTranscripts)
      .values({
        workspaceId: call.workspaceId,
        appointmentId: appt.id,
        provider: 'handsfree',
        externalId: `video:${input.stretch}`,
        body: videoCallTranscript(lines).slice(0, 2_000_000),
      })
      .onConflictDoNothing({
        target: [appointmentTranscripts.appointmentId, appointmentTranscripts.externalId],
      })
      .returning({ id: appointmentTranscripts.id });
    if (!row) return { transcriptId: null, lines: lines.length };
    // Never the words themselves: the event and the activity log say a transcript arrived.
    await ctx.emit({
      type: 'appointment.transcript_ready',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { transcriptId: row.id, provider: 'handsfree' },
      after: { title: appt.title, provider: 'handsfree' },
    });
    return { transcriptId: row.id, lines: lines.length };
  },
});

const NoCoach = {
  liveMeetingId: null,
  personId: null,
  conversationId: null,
  startedAt: null,
  stretch: null,
} as const;

/**
 * The Sales Coach in the call (part 3): the listener hears a call with someone on the team the coach is for, so this
 * stretch of the call becomes a live meeting the add-ons that listen hear (`liveCalls`), as a Zoom meeting does. No
 * claim is needed: the call knows who's in it, and who the customer is (the customer in the call, else the call's or
 * the appointment's). The live meeting is the person's for this stretch (LiveKit's room id), and a listener that
 * restarted in the middle of it finds the same one. Nothing, while the call isn't live, its AI notes are off, or
 * the person isn't in it.
 */
export const videoCallCoach = defineCommand({
  name: 'video_call.coach',
  description:
    'Worker: the AI’s listener hears a HandsFreeOS video call with someone on the team who is coached, so the add-ons that listen hear it too.',
  risk: 0,
  input: z.object({ workspaceId: uuid, callId: uuid, userId: uuid }),
  output: z.object({
    liveMeetingId: uuid.nullable(),
    personId: uuid.nullable(),
    conversationId: uuid.nullable(),
    startedAt: isoDateTime.nullable(),
    /** The stretch of the call: LiveKit's room id. */
    stretch: z.string().nullable(),
  }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['live_meeting.started'],
  async handler(ctx, input) {
    // Locked, so the team can't turn the notes off between the check and the live meeting.
    const call = await lockCall(ctx, input.callId);
    if (call.state !== 'live' || !call.aiNotes || !call.roomSid) return NoCoach;
    const list = await peopleOf(ctx.tx, call.id);
    const theirs = list.find(
      (p) => p.kind === 'team' && p.userId === input.userId && p.state === 'in' && connected(p),
    );
    if (!theirs) return NoCoach;
    const inTheCall = list
      .filter((p) => p.kind === 'customer' && p.personId && p.state === 'in' && connected(p))
      .sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))[0];
    const [booked] =
      !inTheCall && !call.personId && call.appointmentId
        ? await ctx.tx
            .select({ personId: appointmentAttendees.personId })
            .from(appointmentAttendees)
            .where(
              and(
                eq(appointmentAttendees.appointmentId, call.appointmentId),
                inArray(appointmentAttendees.status, ['booked', 'attended', 'no_show']),
              ),
            )
            .orderBy(asc(appointmentAttendees.createdAt))
            .limit(1)
        : [];
    const personId = inTheCall?.personId ?? call.personId ?? booked?.personId ?? null;
    const ws = call.workspaceId;
    const [made] = await rows<{ id: string; started_at: Date | string }>(
      ctx.tx,
      sql`insert into app.live_meetings
            (workspace_id, user_id, provider, meeting_uuid, appointment_id, person_id, state, stream_id, started_at)
          values (${ws}, ${input.userId}, 'handsfree', ${call.roomSid}, ${call.appointmentId},
            ${personId}, 'live', ${call.roomSid}, now())
          on conflict (workspace_id, user_id, provider, meeting_uuid) where state in ('waiting', 'live')
          do nothing
          returning id, started_at`,
    );
    if (made)
      await ctx.emit({
        type: 'live_meeting.started',
        entityType: 'live_meeting',
        entityId: made.id,
        payload: { userId: input.userId, provider: 'handsfree' },
      });
    // Heard again (a listener that restarted): the same live meeting, with the customer once they're known.
    const [open] = made
      ? [{ id: made.id, started_at: made.started_at, person_id: personId }]
      : await rows<{ id: string; started_at: Date | string; person_id: string | null }>(
          ctx.tx,
          sql`update app.live_meetings set person_id = coalesce(person_id, ${personId}::uuid)
              where workspace_id = ${ws} and user_id = ${input.userId} and provider = 'handsfree'
                and meeting_uuid = ${call.roomSid} and state = 'live'
              returning id, started_at, person_id`,
        );
    if (!open) return NoCoach;
    return {
      liveMeetingId: open.id,
      personId: open.person_id,
      conversationId: call.conversationId,
      startedAt: new Date(open.started_at).toISOString(),
      stretch: call.roomSid,
    };
  },
});

export const videoCallCommands = [
  videoCallOpen,
  videoCallEnter,
  videoCallKnock,
  videoCallJoined,
  videoCallLeft,
  videoCallFinished,
  videoCallJoin,
  videoCallAdmit,
  videoCallTurnAway,
  videoCallRemove,
  videoCallMute,
  videoCallEnd,
  videoCallSetAi,
  videoCallHeard,
  videoCallKeepWords,
  videoCallCoach,
] as const;

export const videoCallQueries = [videoCallGet, videoCallKnockStatus] as const;
