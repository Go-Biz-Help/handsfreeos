import { taskDueBucket } from '@hfos/core';
import type { Ok } from '../api/types';
import {
  DEMO_MEDIA_BUCKET,
  demoId,
  fullName,
  isDemoId,
  phoneDisplay,
  wallTime,
  type DemoCallNotes,
  type DemoDocument,
  type DemoLeadRecord,
  type DemoPerson,
  type DemoTask,
  type DemoVisit,
  type DemoWorld,
} from './world';

/**
 * The made-up answers for the calendar and what hangs off a visit: the visits themselves (on the calendar, on a
 * conversation's side panel and on the visit's sheet), the presenter's own working hours and Google busy times, what
 * the AI made of a recorded call, a video call's chat, and a contract sent to sign. respond.ts dispatches to these.
 */

type Appointment = Ok<'/v1/queries/appointment.list'>['items'][number];
type AppointmentDetail = Ok<'/v1/queries/appointment.get'>['appointment'];
type Team = Ok<'/v1/queries/schedule.team'>;
type TeamPerson = Team['people'][number];
type Suggestions = Ok<'/v1/queries/call_suggestion.list'>;
type Tasks = Ok<'/v1/queries/task.list'>;
type Chat = Ok<'/v1/queries/video_call.chat'>;
type DocumentGet = Ok<'/v1/queries/document.get'>;
type VideoCall = Ok<'/v1/queries/video_call.get'>;
type WebinarLeads = Ok<'/v1/queries/video_call.leads'>;

const iso = (ms: number) => new Date(ms).toISOString();

/** The calendar every made-up visit is on. */
export const CALENDAR = demoId(0xa003);
const SERVICE = demoId(0xa007);
const SCHEDULE = demoId(0xa020);
const GOOGLE = demoId(0xa021);
const PDF_FILE = demoId(0xa022);
/** A webinar's live poll. */
const POLL_FORM = demoId(0xa024);

/** A visit wherever the scene keeps it: on a conversation, or on the calendar alone. */
export interface SceneVisit {
  readonly visit: DemoVisit;
  readonly person: DemoPerson;
  readonly conversationId: string | null;
}

export const sceneVisits = (w: DemoWorld): SceneVisit[] => [
  ...w.conversations.flatMap((c) =>
    c.visits.map((visit) => ({ visit, person: c.person, conversationId: c.id })),
  ),
  ...w.visits.map((visit) => ({ visit, person: visit.person, conversationId: null })),
];

export const findVisit = (w: DemoWorld, id: unknown) =>
  sceneVisits(w).find((v) => v.visit.id === id) ?? null;

/** The customer's seat on a visit: its own made-up id, kept next to the visit's (a webinar's next seats after it). */
export const seatOf = (visitId: string, i = 0) =>
  demoId(parseInt(visitId.slice(-12), 16) + 0x8000 + i);

/** Who's booked in: the one customer, or everyone in a webinar's seats. */
const peopleOn = (s: SceneVisit): readonly DemoPerson[] => s.visit.seats ?? [s.person];

const endOf = (v: DemoVisit) => v.startsAt + v.minutes * 60_000;

function location(v: DemoVisit): Appointment['location'] {
  return {
    kind: v.video ? 'virtual' : v.address ? 'customer_address' : null,
    address: v.address ?? null,
    meetingUrl: v.video === 'zoom' ? 'https://zoom.us/j/84213307715' : null,
    postalCode: null,
    video: v.video ?? null,
    meetingId: v.video === 'zoom' ? '84213307715' : null,
    meetingFor: null,
    meetingError: null,
    // A Zoom call is recorded, so its words come back for After the call.
    record: v.video === 'zoom',
  };
}

const status = (v: DemoVisit): Appointment['status'] =>
  v.cancelled ? 'cancelled' : v.completed ? 'completed' : 'scheduled';

/** One visit as the calendar and the side panel list it, the presenter on it and the customer in its seat. */
export function appointmentItem(w: DemoWorld, s: SceneVisit): Appointment {
  const v = s.visit;
  const people = peopleOn(s);
  return {
    id: v.id,
    calendar: {
      id: CALENDAR,
      name: v.webinar ? 'Webinars' : v.video ? 'Consultations' : 'Service calls',
      color: '#2d69d8',
    },
    service: { id: SERVICE, name: v.title },
    // A webinar is a session: one time, many seats.
    kind: v.webinar ? 'session' : 'booking',
    title: v.title,
    startsAt: iso(v.startsAt),
    endsAt: iso(endOf(v)),
    bufferBefore: 0,
    bufferAfter: 0,
    capacity: v.webinar ? 100 : 1,
    seatsTaken: v.cancelled ? 0 : people.length,
    status: status(v),
    location: location(v),
    seriesId: null,
    occurrence: null,
    source: v.source ?? 'ai_teammate',
    leadId: null,
    customRecord: null,
    notes: null,
    staff: [{ userId: w.state.me.id, fullName: w.state.me.name, role: 'host' }],
    resources: [],
    attendees: people.map((p, i) => ({
      id: seatOf(v.id, i),
      personId: p.id,
      fullName: fullName(p),
      seats: 1,
      status: v.cancelled ? 'cancelled' : v.completed && v.webinar ? 'attended' : 'booked',
      heldUntil: null,
      // The confirmation text went out; the customer hasn't pressed Confirm on it.
      confirmAskedAt: null,
      confirmedAt: null,
      confirmedBy: null,
      confirmedVia: null,
    })),
    heldUntil: null,
    createdAt: iso(v.bookedAt),
    updatedAt: iso(v.bookedAt),
  };
}

/** When a reminder goes: the day before at 4:00 PM, or so many minutes before (the calendar's own defaults). */
function dueOf(key: string, v: DemoVisit, timeZone: string): number {
  if (key === 'day_before') return wallTime(v.startsAt, timeZone, -1, 16);
  const minutes = Number(/^before_(\d+)$/.exec(key)?.[1] ?? 120);
  return v.startsAt - minutes * 60_000;
}

/** The visit's sheet: the customer, where, its reminders as the worker recorded them, and its price. */
export function appointmentDetail(w: DemoWorld, s: SceneVisit): AppointmentDetail {
  const item = appointmentItem(w, s);
  const v = s.visit;
  const starts = iso(v.startsAt);
  const now = Date.now();
  const r = v.reminders;
  const reminders = Object.fromEntries(
    (r?.keys ?? []).map((key) => {
      const due = dueOf(key, v, w.state.timeZone);
      const sent = due <= now;
      return [
        key,
        {
          at: iso(due),
          channel: sent ? ('sms' as const) : null,
          dueAt: sent ? null : iso(due),
          messageId: null,
          reason: null,
          startsAt: starts,
          status: sent ? ('sent' as const) : ('scheduled' as const),
        },
      ];
    }),
  );
  return {
    ...item,
    calendarRevision: 1,
    createdBy: null,
    extraServices: [],
    job: null,
    priceCents: v.priceCents ?? null,
    series: null,
    waitlist: [],
    attendees: item.attendees.map((a, i) => ({
      ...a,
      cancelledAt: null,
      contactEmail: peopleOn(s)[i]?.email ?? null,
      contactPhone: phoneDisplay(peopleOn(s)[i]?.phone ?? s.person.phone),
      intake: {},
      joinedAt: null,
      reminders: {
        confirmation: r
          ? {
              at: iso(r.confirmedAt),
              channel: 'sms',
              dueAt: null,
              messageId: null,
              reason: null,
              startsAt: starts,
              status: 'sent',
            }
          : null,
        reminders,
      },
      rescheduleCount: 0,
      smsOk: true,
      source: v.source ?? 'ai_teammate',
    })),
  };
}

/** The visits between `from` and `to` (ISO), as the calendar asks for a week at a time. */
export function visitsBetween(w: DemoWorld, from: unknown, to: unknown): Appointment[] {
  const a = typeof from === 'string' ? Date.parse(from) : -Infinity;
  const b = typeof to === 'string' ? Date.parse(to) : Infinity;
  return sceneVisits(w)
    .filter((s) => !s.visit.cancelled && endOf(s.visit) > a && s.visit.startsAt < b)
    .map((s) => appointmentItem(w, s));
}

/**
 * The team's schedules with the presenter in them, since the scene's visits are theirs: Monday to Friday, 8 to 5,
 * unless the business already has them. Their Google Calendar's busy times, when the scene connected it.
 */
export function teamWithMe(w: DemoWorld, got: Team): Team {
  const me = w.state.me;
  const found = got.people.find((p) => p.userId === me.id);
  const google = w.google.connected
    ? {
        id: GOOGLE,
        userId: me.id,
        provider: 'google' as const,
        status: 'active' as const,
        accountEmail: null,
        fullName: me.name,
        scopes: [],
        meetTranscripts: false,
        failures: 0,
        lastError: null,
        connectedAt: iso(w.state.startedAt - 90 * 24 * 3600_000),
        busySyncedAt: iso(Date.now() - 4 * 60_000),
        nextSyncAt: null,
        disconnectedAt: null,
        createdAt: iso(w.state.startedAt - 90 * 24 * 3600_000),
      }
    : null;
  const busy = w.google.busy.map((b) => ({ startsAt: iso(b.startsAt), endsAt: iso(b.endsAt) }));
  const person: TeamPerson = found
    ? {
        ...found,
        busy: [...found.busy, ...busy],
        connection: google ?? found.connection,
      }
    : {
        userId: me.id,
        fullName: me.name,
        timezone: w.state.timeZone,
        ownTimezone: null,
        scheduleId: SCHEDULE,
        defaultHours: true,
        weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' })),
        hours: workingHours(w, got),
        timeOff: [],
        busy,
        privateBusy: [],
        elsewhereBusy: [],
        connection: google,
      };
  return {
    ...got,
    people: found ? got.people.map((p) => (p === found ? person : p)) : [person, ...got.people],
  };
}

/** 8 to 5 on each weekday the business's own people have hours for, else every weekday of the coming fortnight. */
function workingHours(w: DemoWorld, got: Team): TeamPerson['hours'] {
  const tz = w.state.timeZone;
  const days = new Set<string>();
  for (const p of got.people)
    for (const h of p.hours)
      days.add(new Date(h.startsAt).toLocaleDateString('en-CA', { timeZone: tz }));
  const at = w.state.startedAt;
  const out: TeamPerson['hours'] = [];
  for (let d = -7; d <= 21; d++) {
    const start = wallTime(at, tz, d, 8);
    const day = new Date(start).toLocaleDateString('en-CA', { timeZone: tz });
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(
      new Date(start),
    );
    if (days.size ? !days.has(day) : weekday === 'Sat' || weekday === 'Sun') continue;
    out.push({ startsAt: iso(start), endsAt: iso(wallTime(at, tz, d, 17)) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- after a recorded call

/** A recorded call's notes: a visit's, a lead's video call's, or a phone call's. */
export function notesOf(w: DemoWorld, body: Record<string, unknown>): DemoCallNotes | null {
  if (body['appointmentId']) return findVisit(w, body['appointmentId'])?.visit.notes ?? null;
  if (body['callId'])
    return w.leads.find((l) => l.phoneCall?.id === body['callId'])?.phoneCall?.notes ?? null;
  const call = w.leads.find((l) => l.videoCall?.id === body['videoCallId'])?.videoCall;
  return call?.notes ?? null;
}

export const transcriptsOf = (n: DemoCallNotes | null, provider: string) => ({
  items: n ? [{ id: n.id, provider, createdAt: iso(n.at), body: n.transcript }] : [],
});

/** A call's review; a phone call keeps its words on itself, so they come with it (`phone`). */
export function suggestionsOf(n: DemoCallNotes | null, phone = false): Suggestions {
  return {
    summary: n?.summary ?? null,
    transcript: phone ? (n?.transcript ?? null) : null,
    items: (n?.suggestions ?? []).map((s) => ({
      id: s.id,
      kind: s.kind,
      status: s.status,
      preview: { ...s.preview },
      createdAt: iso(n!.at),
      taskId: s.taskId ?? null,
    })),
  };
}

/** The suggestion with this id, on any of the scene's calls. */
export function findSuggestion(w: DemoWorld, id: unknown) {
  const all = [
    ...sceneVisits(w).flatMap((s) => s.visit.notes?.suggestions ?? []),
    ...w.leads.flatMap((l) => l.videoCall?.notes.suggestions ?? []),
    ...w.leads.flatMap((l) => l.phoneCall?.notes.suggestions ?? []),
  ];
  return all.find((s) => s.id === id) ?? null;
}

export function chatOf(w: DemoWorld, callId: unknown): Chat | null {
  const call = w.leads.find((l) => l.videoCall?.id === callId)?.videoCall;
  if (!call) return null;
  return {
    callId: call.id,
    more: 0,
    messages: call.chat.map((m) => ({
      id: m.id,
      body: m.body,
      name: m.name,
      side: m.side,
      sentAt: iso(m.at),
    })),
  };
}

/** A HandsFreeOS video call on one of the scene's visits, by the visit or the call. */
function handsfreeVisit(w: DemoWorld, body: Record<string, unknown>): SceneVisit | null {
  return (
    sceneVisits(w).find(
      (s) =>
        s.visit.video === 'handsfree' &&
        (s.visit.id === body['appointmentId'] ||
          (!!s.visit.webinar && s.visit.webinar.callId === body['callId'])),
    ) ?? null
  );
}

const callIdOf = (v: DemoVisit) =>
  v.webinar?.callId ?? demoId(parseInt(v.id.slice(-12), 16) + 0x9000);

/** A visit's HandsFreeOS video call: the presenter hosting, and how long each person who came was in it. */
export function videoCallOf(w: DemoWorld, body: Record<string, unknown>): VideoCall | null {
  const s = handsfreeVisit(w, body);
  if (!s) return null;
  const v = s.visit;
  const ended = !!v.completed;
  const host = {
    id: demoId(parseInt(v.id.slice(-12), 16) + 0x9100),
    kind: 'team' as const,
    name: w.state.me.name,
    state: ended ? ('left' as const) : ('in' as const),
    userId: w.state.me.id,
    personId: null,
    connected: false,
    askedAt: null,
    joinedAt: ended ? iso(v.startsAt - 2 * 60_000) : null,
    leftAt: ended ? iso(endOf(v)) : null,
    seconds: ended ? v.minutes * 60 + 120 : 0,
    onStage: false,
  };
  const came = v.webinar
    ? v.webinar.leads.map((l, i) => ({
        id: demoId(parseInt(v.id.slice(-12), 16) + 0x9101 + i),
        kind: 'customer' as const,
        name: fullName(l.person),
        state: 'left' as const,
        userId: null,
        personId: l.person.id,
        connected: false,
        askedAt: iso(v.startsAt - 60_000),
        joinedAt: iso(v.startsAt),
        leftAt: iso(v.startsAt + l.seconds * 1000),
        seconds: l.seconds,
        onStage: false,
      }))
    : [];
  return {
    call: {
      id: callIdOf(v),
      state: ended ? 'ended' : 'open',
      appointmentId: v.id,
      personId: v.webinar ? null : s.person.id,
      hostUserId: w.state.me.id,
      aiNotes: !v.webinar,
      startedAt: ended ? iso(v.startsAt - 2 * 60_000) : null,
      endedAt: ended ? iso(endOf(v)) : null,
      format: v.webinar ? 'webinar' : 'meeting',
      attendeeVideo: 'off',
      doorKey: v.webinar ? 'summer-energy' : null,
      pollFormId: v.webinar ? POLL_FORM : null,
      pollAi: 'ask',
    },
    appointment: {
      id: v.id,
      title: v.title,
      startsAt: iso(v.startsAt),
      endsAt: iso(endOf(v)),
      status: status(v),
      customers: peopleOn(s).map((p) => ({ personId: p.id, name: fullName(p) })),
    },
    host: { userId: w.state.me.id, name: w.state.me.name },
    customer: null,
    people: [host, ...came],
  };
}

/** Who to follow up with after a webinar: everyone who came, hottest first, as the worker scored them. */
export function webinarLeadsOf(w: DemoWorld, body: Record<string, unknown>): WebinarLeads | null {
  const s = handsfreeVisit(w, body);
  if (!s) return null;
  const v = s.visit;
  const web = v.webinar;
  const counts = { hot: 0, warm: 0, cold: 0 };
  if (!web) return { call: null, counts, leads: [] };
  for (const l of web.leads) counts[l.label] += 1;
  const scoredAt = iso(endOf(v) + 60_000);
  return {
    call: {
      id: web.callId,
      ended: !!v.completed,
      endedAt: iso(endOf(v)),
      formId: POLL_FORM,
      formName: web.poll,
      hot: web.hot,
      warm: web.warm,
      hotAction: 'text',
    },
    counts,
    leads: [...web.leads]
      .sort((a, b) => b.points - a.points)
      .map((l) => ({
        id: l.id,
        personId: l.person.id,
        name: fullName(l.person),
        points: l.points,
        label: l.label,
        parts: l.parts.map((p) => ({ ...p })),
        reason: l.reason,
        stayed: l.stayed,
        seconds: l.seconds,
        followUp: l.label === 'hot' ? 'text' : 'list',
        outcome: l.outcome,
        outcomeReason: null,
        scoredAt,
      })),
  };
}

/** A webinar's chat: nothing kept, so the sheet leaves it out. */
export const webinarChatOf = (w: DemoWorld, callId: unknown): Chat | null =>
  sceneVisits(w).some((s) => s.visit.webinar?.callId === callId)
    ? { callId: String(callId), more: 0, messages: [] }
    : null;

/** A lead's timeline: its video call, as its own line with the AI's summary for a body. */
export function leadTimeline(w: DemoWorld, l: DemoLeadRecord) {
  const call = l.videoCall;
  const phone = l.phoneCall;
  const items = phone
    ? [
        {
          id: demoId(0xb2001),
          entry: 'activity',
          kind: 'call',
          subtype: 'answered',
          // The AI's summary is the call's line once its words are in.
          body: phone.notes.summary,
          occurredAt: iso(phone.at),
          actor: null,
          actorType: 'system',
          personId: l.person.id,
          companyId: null,
          leadId: l.id,
          customRecordId: null,
          meta: {
            callId: phone.id,
            direction: 'inbound',
            answeredVia: 'browser',
            answeredByUserId: w.state.me.id,
            durationSeconds: phone.seconds,
          },
        },
      ]
    : call
      ? [
          {
            id: demoId(0xb2000),
            entry: 'activity',
            kind: 'call',
            subtype: 'video',
            body: call.notes.summary,
            occurredAt: iso(call.at),
            // The presenter had the call, so the line reads "Chris had a video call".
            actor: { id: w.state.me.id, fullName: w.state.me.name },
            actorType: 'person',
            personId: l.person.id,
            companyId: null,
            leadId: l.id,
            customRecordId: null,
            meta: { videoCallId: call.id, durationSeconds: call.seconds },
          },
        ]
      : [];
  return { items, nextCursor: null };
}

// --------------------------------------------------------------------------------------------- the presenter's tasks

/** A scene's task as the Tasks page and a customer's page list it. */
export function taskRow(w: DemoWorld, t: DemoTask): Tasks['items'][number] {
  const dueAt = t.dueAt === null ? null : iso(t.dueAt);
  const me = { id: w.state.me.id, fullName: w.state.me.name };
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    dueAt,
    allDay: t.allDay,
    dueBucket: taskDueBucket({ dueAt, allDay: t.allDay, doneAt: null }, w.state.timeZone),
    assignee: me,
    person: { id: t.person.id, fullName: fullName(t.person), archived: false },
    company: null,
    lead: t.lead ? { id: t.lead.id, title: t.lead.title } : null,
    customRecord: null,
    doneAt: null,
    doneBy: null,
    createdBy: null,
    createdAt: iso(t.at),
    updatedAt: iso(t.at),
  };
}

/**
 * `task.list` with the scene's tasks: one asked for by id, a made-up customer's or lead's alone, or the Tasks page's
 * open list (mine or everyone's) with them on top. Null leaves the request to the real list.
 */
export async function tasksWith(
  w: DemoWorld,
  body: Record<string, unknown>,
  real: () => Promise<Response>,
): Promise<Tasks | Response | null> {
  if (!w.tasks.length) return null;
  const tz = w.state.timeZone;
  if (body['taskId']) {
    const t = w.tasks.find((x) => x.id === body['taskId']);
    return t ? { items: [taskRow(w, t)], nextCursor: null, timezone: tz } : null;
  }
  const open = (body['status'] ?? 'open') !== 'done';
  const on = (['personId', 'leadId', 'companyId', 'customRecordId'] as const).find((k) => body[k]);
  if (on) {
    const id = String(body[on]);
    if (!isDemoId(id)) return null;
    const mine = w.tasks.filter(
      (t) => open && (on === 'personId' ? t.person.id === id : t.lead?.id === id),
    );
    return { items: mine.map((t) => taskRow(w, t)), nextCursor: null, timezone: tz };
  }
  if (!open || (body['assigneeUserId'] && body['assigneeUserId'] !== w.state.me.id)) return null;
  const res = await real();
  if (!res.ok) return res;
  const got = (await res.json()) as Tasks;
  return { ...got, items: [...w.tasks.map((t) => taskRow(w, t)), ...got.items] };
}

// ----------------------------------------------------------------------------------------------- a contract to sign

/** A sent document as its page shows it: who signs, each step of the proof trail, and the PDF with what's filled in. */
export function documentOf(w: DemoWorld, d: DemoDocument): DocumentGet {
  const signer = demoId(parseInt(d.id.slice(-12), 16) + 0x8000);
  const who = fullName(d.person);
  const signed = d.signed ?? null;
  const day = signed
    ? new Intl.DateTimeFormat('en-CA', { timeZone: w.state.timeZone }).format(new Date(signed.at))
    : null;
  const step = (n: number, kind: DocumentGet['steps'][number]['kind'], at: number, more = {}) => ({
    id: demoId(parseInt(d.id.slice(-12), 16) + 0x8100 + n),
    kind,
    at: iso(at),
    signerId: kind === 'prepared' || kind === 'completed' ? null : signer,
    byUserId: kind === 'prepared' ? w.state.me.id : null,
    channel: null as string | null,
    device: null as string | null,
    ip: null as string | null,
    detail: {},
    ...more,
  });
  const device = signed?.device ?? null;
  const steps = [
    step(0, 'prepared', d.sentAt - 30_000),
    step(1, 'sent', d.sentAt, { channel: 'sms' }),
    step(2, 'sent', d.sentAt + 1_000, { channel: 'email' }),
    ...(d.openedAt
      ? [step(3, 'opened', d.openedAt, { device: 'iPhone · Safari', ip: '73.166.0.24' })]
      : []),
    ...(signed
      ? [
          step(4, 'agreed', signed.at - 40_000, { device, ip: '73.166.0.24' }),
          step(5, 'signed', signed.at, { device, ip: '73.166.0.24' }),
          step(6, 'completed', signed.at + 5_000),
        ]
      : []),
  ];
  const s = d.spots;
  return {
    id: d.id,
    name: d.name,
    about: { id: d.person.id, kind: 'person', name: who },
    canSend: true,
    status: signed ? 'completed' : 'out',
    finishing: false,
    sentAt: iso(d.sentAt),
    sentBy: { id: w.state.me.id, fullName: w.state.me.name },
    expiresAt: iso(d.sentAt + 30 * 24 * 3600_000),
    completedAt: signed ? iso(signed.at + 5_000) : null,
    declinedAt: null,
    expiredAt: null,
    voidedAt: null,
    voidReason: null,
    message: null,
    remindAfterDays: 2,
    remindEveryDays: 3,
    signingOrder: 'order',
    templateId: null,
    source: {
      bucket: DEMO_MEDIA_BUCKET,
      fileId: PDF_FILE,
      name: `${d.name}.pdf`,
      objectPath: d.pdf,
    },
    sourceSha256: null,
    // The signed copy is kept with the customer's files; the demo has no copy of its own to download.
    signed: null,
    signedSha256: null,
    definition: {
      version: 1,
      pages: d.pages,
      roles: [{ key: 'customer', label: 'Customer', kind: 'customer' }],
      fields: [
        {
          id: 'sig',
          type: 'signature',
          role: 'customer',
          page: 0,
          ...s.signature,
          label: 'Your signature',
        },
        { id: 'name', type: 'name', role: 'customer', page: 0, ...s.name, label: 'Your name' },
        {
          id: 'day',
          type: 'date_signed',
          role: 'customer',
          page: 0,
          ...s.date,
          label: 'Date signed',
        },
      ].map((f) => ({ required: true, fillFrom: null, options: [], fontSize: 11, ...f })),
      edits: [],
      settings: {},
      presets: {},
    },
    values: signed
      ? {
          sig: { kind: 'signature', how: 'drawn', image: signed.image, name: who, style: null },
          name: { kind: 'text', text: who },
          day: { kind: 'date', date: day },
        }
      : {},
    valuesBy: signed ? { sig: signer, name: signer, day: signer } : {},
    signers: [
      {
        id: signer,
        kind: 'signer',
        position: 0,
        roleKey: 'customer',
        roleLabel: 'Customer',
        name: who,
        email: d.email,
        phone: phoneDisplay(d.person.phone),
        personId: d.person.id,
        userId: null,
        channels: ['sms', 'email'],
        askCode: false,
        inPerson: false,
        status: signed ? 'signed' : d.openedAt ? 'opened' : 'sent',
        sentAt: iso(d.sentAt),
        lastSentAt: iso(d.sentAt),
        openedAt: d.openedAt ? iso(d.openedAt) : null,
        agreedAt: signed ? iso(signed.at - 40_000) : null,
        codeCheckedAt: null,
        signedAt: signed ? iso(signed.at) : null,
        declinedAt: null,
        declineReason: null,
        reminders: 0,
        device: signed?.device ?? null,
        ip: signed ? '73.166.0.24' : null,
      },
    ],
    steps,
  } as DocumentGet;
}
