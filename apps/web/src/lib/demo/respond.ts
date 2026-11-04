import type { AssistantCard, AssistantEvent } from '@hfos/core';
import type { Ok } from '../api/types';
import { buildWorld } from './scenes';
import type { DemoState } from './state';
import {
  demoId,
  fullName,
  namesDemoRecord,
  phoneDisplay,
  type DemoCampaign,
  type DemoConfirmCard,
  type DemoConversation,
  type DemoDraft,
  type DemoWorld,
} from './world';

/**
 * The answers a scene makes up, for the API (queries and commands) and the worker (Ask HandsFreeOS). A request
 * that names a made-up record gets a made-up answer; a list a scene adds to gets the real list with the scene's rows
 * on top; anything else goes through untouched. Commands on made-up records answer OK and change nothing.
 */

type Conversation = Ok<'/v1/queries/conversation.get'>;
type Summary = Conversation['conversation'];
type Thread = Ok<'/v1/queries/conversation.thread'>;
type ThreadMessage = Thread['items'][number];
type Drafts = Ok<'/v1/queries/ai_teammate.draft_list'>;
type Draft = Drafts['items'][number];
type Visits = Ok<'/v1/queries/appointment.list'>;
type Campaign = Ok<'/v1/queries/campaign.get'>;
type Timeline = Ok<'/v1/queries/timeline.list'>;

const TEAMMATE = demoId(0xa001);
const LINE = demoId(0xa002);
const CALENDAR = demoId(0xa003);
const RUN = demoId(0xa004);
const THREAD = demoId(0xa005);
const ANSWER = demoId(0xa006);
const FROM_NUMBER = '+15125550100';

const iso = (ms: number) => new Date(ms).toISOString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function summary(w: DemoWorld, c: DemoConversation): Summary {
  const last = c.messages[c.messages.length - 1]!;
  const waiting = last.direction === 'inbound' ? iso(last.at) : null;
  return {
    id: c.id,
    channel: 'sms',
    counterpart: c.person.phone,
    counterpartDisplay: phoneDisplay(c.person.phone),
    status: 'open',
    person: { id: c.person.id, fullName: fullName(c.person) },
    assignee: null,
    unreadCount: c.unread,
    lastMessageAt: iso(last.at),
    lastPreview: last.body.slice(0, 140),
    lastDirection: last.direction,
    lastSentBy: null,
    awaitingReplySince: waiting,
    snoozedUntil: null,
    archived: false,
    openLead: null,
    createdAt: iso(c.createdAt),
    handledBy: 'ai',
    teammate: { id: TEAMMATE, name: w.state.teammate },
    needsPersonSince: null,
    handoffReason: null,
    handoffNote: null,
    takenOverBy: null,
    onSiteNow: false,
    lanes: [
      {
        id: c.id,
        channel: 'sms',
        lineId: LINE,
        lineDisplay: phoneDisplay(FROM_NUMBER),
        unreadCount: c.unread,
        status: 'open',
        archived: false,
        lastMessageAt: iso(last.at),
        assignee: null,
      },
    ],
    unreadTotal: c.unread,
    sameAs: null,
    folder: 'inbox',
    private: false,
    record: null,
  };
}

function conversation(w: DemoWorld, c: DemoConversation): Conversation {
  const p = c.person;
  const now = new Intl.DateTimeFormat('en-US', {
    timeZone: w.state.timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
  return {
    conversation: summary(w, c),
    chat: null,
    person: {
      id: p.id,
      fullName: fullName(p),
      firstName: p.firstName,
      lastName: p.lastName,
      phone: phoneDisplay(p.phone),
      phoneE164: p.phone,
      email: null,
      address: {
        line1: null,
        line2: null,
        city: p.city,
        state: null,
        postalCode: null,
        country: 'US',
      },
      tags: [],
      customerSince: iso(p.customerSince ?? c.createdAt),
      smsConsent: 'unknown',
      archived: false,
    },
    openTasks: [],
    sender: null,
    canText: { ok: true, reason: null },
    social: null,
    fromNumber: phoneDisplay(FROM_NUMBER),
    rcs: false,
    quiet: { quiet: false, localTime: now, endsAt: null },
    timezone: w.state.timeZone,
  };
}

function thread(w: DemoWorld, c: DemoConversation): Thread {
  const items = c.messages.map((m): ThreadMessage => ({
    type: 'message',
    id: m.id,
    occurredAt: iso(m.at),
    direction: m.direction,
    status: m.direction === 'inbound' ? 'received' : 'delivered',
    channel: 'sms',
    body: m.body,
    subject: null,
    fromAddress: m.direction === 'inbound' ? c.person.phone : FROM_NUMBER,
    media: [],
    sentBy: null,
    errorCode: null,
    errorMessage: null,
    deliveredAt: m.direction === 'outbound' ? iso(m.at + 2000) : null,
    durationSeconds: null,
    isVoicemail: false,
    hasRecording: false,
    recordingPath: null,
    recordingSeconds: null,
    answeredVia: null,
    scheduledFor: null,
    transcript: null,
    transcriptStatus: null,
    answeredBy: null,
    conversationId: c.id,
    lineDisplay: null,
    bodyHtml: null,
    toAddresses: [m.direction === 'inbound' ? FROM_NUMBER : c.person.phone],
    ccAddresses: [],
    via: null,
    teammate: m.teammate ? { id: TEAMMATE, name: w.state.teammate } : null,
    approvedBy: m.approved ? { id: w.state.me.id, fullName: w.state.me.name } : null,
    aiDraftId: m.draftId ?? null,
    handoffLine: false,
    transport: 'sms',
    readAt: null,
    rich: null,
    buttonReply: null,
    social: null,
    editedAt: null,
    unsentAt: null,
  }));
  return { items, nextCursor: null };
}

function draft(w: DemoWorld, c: DemoConversation, d: DemoDraft): Draft {
  return {
    id: d.id,
    kind: 'reply',
    status: d.status,
    teammate: { id: TEAMMATE, name: w.state.teammate },
    runId: RUN,
    conversationId: c.id,
    channel: 'sms',
    person: { id: c.person.id, fullName: fullName(c.person) },
    lead: null,
    preview: {
      message: { channel: 'sms', body: d.body, subject: null, inReplyToMessageId: d.inReplyTo },
      actions: d.book
        ? [
            {
              kind: 'book',
              calendarId: CALENDAR,
              startsAt: iso(d.book.startsAt),
              serviceId: null,
              durationMinutes: d.book.minutes,
              sessionId: null,
              notes: null,
              postalCode: null,
              point: null,
              summary: d.book.summary,
            },
          ]
        : [],
      discount: null,
      call: null,
      ask: null,
      flags: [],
      funnel: null,
    },
    edits: null,
    reason: null,
    decidedBy: d.status === 'pending' ? null : { id: w.state.me.id, fullName: w.state.me.name },
    decidedAt: d.decidedAt ? iso(d.decidedAt) : null,
    via: null,
    expiresAt: iso(d.at + 24 * 3600_000),
    createdAt: iso(d.at),
    canDecide: true,
    record: null,
    knowledge: [],
  };
}

/** Newest first, as the API lists them. */
const draftsOf = (w: DemoWorld, c: DemoConversation) =>
  [...c.drafts].sort((a, b) => b.at - a.at).map((d) => draft(w, c, d));

function visits(w: DemoWorld, c: DemoConversation): Visits {
  return {
    timezone: w.state.timeZone,
    items: c.visits.map((v) => ({
      id: v.id,
      calendar: { id: CALENDAR, name: 'Service calls', color: '#2d69d8' },
      service: { id: demoId(0xa007), name: v.title },
      kind: 'booking',
      title: v.title,
      startsAt: iso(v.startsAt),
      endsAt: iso(v.startsAt + v.minutes * 60_000),
      bufferBefore: 0,
      bufferAfter: 0,
      capacity: 1,
      seatsTaken: 1,
      status: 'scheduled',
      location: {
        kind: null,
        address: null,
        meetingUrl: null,
        postalCode: null,
        video: null,
        meetingId: null,
        meetingFor: null,
        meetingError: null,
        record: false,
      },
      seriesId: null,
      occurrence: null,
      source: 'ai_teammate',
      leadId: null,
      customRecord: null,
      notes: null,
      staff: [],
      resources: [],
      attendees: [],
      heldUntil: null,
      createdAt: iso(v.bookedAt),
      updatedAt: iso(v.bookedAt),
    })),
  };
}

function timeline(c: DemoConversation): Timeline {
  const entries = [
    ...c.messages.map((m) => ({
      id: demoId(0xb0000 + c.messages.indexOf(m)),
      entry: 'activity',
      kind: 'sms',
      subtype: m.direction,
      body: m.body,
      occurredAt: iso(m.at),
      actor: null,
      actorType: m.teammate ? 'ai_teammate' : 'system',
      personId: c.person.id,
      companyId: null,
      leadId: null,
      customRecordId: null,
      meta: { direction: m.direction, messageId: m.id, transport: 'sms', conversationId: c.id },
    })),
    ...c.visits.map((v) => ({
      id: demoId(0xb1000 + c.visits.indexOf(v)),
      entry: 'activity',
      kind: 'system',
      subtype: 'appointment_booked',
      body: v.title,
      occurredAt: iso(v.bookedAt + 1),
      actor: null,
      actorType: 'ai_teammate',
      personId: c.person.id,
      companyId: null,
      leadId: null,
      customRecordId: null,
      meta: {
        startsAt: iso(v.startsAt),
        endsAt: iso(v.startsAt + v.minutes * 60_000),
        calendarId: CALENDAR,
        appointmentId: v.id,
      },
    })),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return { items: entries, nextCursor: null } as unknown as Timeline;
}

function campaign(c: DemoCampaign): Campaign {
  const now = Date.now();
  // The AI writes them one by one over `writingMs`; the page refreshes every few seconds meanwhile.
  const picked = c.recipients.filter((r) => !r.skipReason);
  const written = Math.min(
    picked.length,
    Math.floor(((now - c.createdAt) / c.writingMs) * picked.length),
  );
  const writing = written < picked.length;
  // Once approved, the first goes straight away and the rest wait their turn at the pace.
  const recipients = c.recipients.map((r) => {
    const i = picked.indexOf(r);
    const sentFirst = c.approvedAt && !r.removed && picked.filter((x) => !x.removed)[0] === r;
    const status: Campaign['recipients'][number]['status'] = r.skipReason
      ? 'skipped'
      : r.removed
        ? 'removed'
        : i >= written
          ? 'drafting'
          : sentFirst
            ? 'sent'
            : c.approvedAt
              ? 'approved'
              : 'ready';
    return {
      id: r.id,
      personId: r.person.id,
      name: fullName(r.person),
      phone: phoneDisplay(r.person.phone),
      email: null,
      status,
      skipReason: r.skipReason ?? null,
      draft: status === 'skipped' || status === 'drafting' ? null : r.draft,
      edited: false,
      sentAt: sentFirst ? iso(c.approvedAt! + 4000) : null,
      error: null,
      call: null,
    };
  });
  const count = (s: string) => recipients.filter((r) => r.status === s).length;
  const status: Campaign['campaign']['status'] = writing
    ? 'drafting'
    : c.approvedAt
      ? 'sending'
      : 'review';
  return {
    campaign: {
      id: c.id,
      name: c.name,
      goal: c.goal,
      channel: 'sms',
      status,
      pausedReason: null,
      perHour: c.perHour,
      keepAdding: false,
      counts: {
        total: recipients.length,
        drafting: count('drafting'),
        ready: count('ready'),
        approved: count('approved'),
        sent: count('sent'),
        failed: 0,
        skipped: count('skipped') + count('removed'),
        removed: count('removed'),
      },
      offer: null,
      createdAt: iso(c.createdAt),
      approvedAt: c.approvedAt ? iso(c.approvedAt) : null,
      finishedAt: null,
      audience: { tagIds: [], stageIds: [] },
      email: null,
      call: null,
    },
    recipients,
    nextSendAt: c.approvedAt ? iso(c.approvedAt + 3 * 60_000) : null,
  };
}

function confirmCard(c: DemoConfirmCard): AssistantCard {
  return {
    type: 'confirm',
    toolCallId: c.toolCallId,
    tool: c.tool,
    personId: null,
    conversationId: null,
    title: c.title,
    fields: [...c.fields],
    body: null,
    stageFrom: null,
    stageTo: null,
    warnings: c.note ? [{ kind: 'note', text: c.note }] : [],
    reasons: [],
    confirmLabel: c.confirmLabel,
    editable: false,
  };
}

/** Where a card stands: confirmed once the presenter pressed Confirm, else waiting. */
function decision(w: DemoWorld, c: DemoConfirmCard) {
  const confirmed = w.confirmed.includes(c.toolCallId);
  return {
    id: c.toolCallId,
    tool: c.tool,
    status: confirmed ? ('confirmed' as const) : ('awaiting_confirmation' as const),
    outcome: confirmed ? c.outcome : null,
    error: null,
    href: confirmed && c.opens ? `/app/w/${w.workspaceId}/${c.opens}` : null,
    undone: false,
  };
}

/** The chat as the worker saved it, for a page reloaded mid-scene. */
function savedChat(w: DemoWorld): Ok<'/v1/queries/assistant_thread.get'> {
  const last = w.chat[w.chat.length - 1];
  return {
    thread: {
      id: THREAD,
      title: w.chat[0]?.question.slice(0, 60) ?? 'New chat',
      lastMessageAt: iso(last?.at ?? w.state.startedAt),
    },
    messages: w.chat.flatMap((t, i) => [
      {
        id: demoId(0xc000 + i * 2),
        role: 'user' as const,
        text: t.question,
        cards: [],
        createdAt: iso(t.at),
      },
      {
        id: demoId(0xc001 + i * 2),
        role: 'assistant' as const,
        text: t.answer.text,
        cards: t.answer.card ? [confirmCard(t.answer.card)] : [],
        createdAt: iso(t.at + 4000),
      },
    ]),
    toolCalls: Object.values(w.cards).map((c) => decision(w, c)),
    answering: null,
  };
}

/** The scripted answer, streamed as the worker streams one: the steps, the words a few at a time, then the card. */
function stream(w: DemoWorld, signal: AbortSignal | null | undefined): Response {
  const a = w.answer!;
  const events: { wait: number; event: AssistantEvent }[] = [
    { wait: 150, event: { type: 'run', runId: RUN, threadId: THREAD } },
  ];
  for (const s of a.steps) {
    events.push({
      wait: 350,
      event: { type: 'step', id: s.id, label: s.label, status: 'running' },
    });
    events.push({ wait: 1100, event: { type: 'step', id: s.id, label: s.label, status: 'done' } });
  }
  const words = a.text.split(/(?<= )/);
  for (let i = 0; i < words.length; i += 2)
    events.push({ wait: 70, event: { type: 'text', delta: words.slice(i, i + 2).join('') } });
  if (a.card) events.push({ wait: 400, event: { type: 'card', card: confirmCard(a.card) } });
  events.push({ wait: 100, event: { type: 'done', messageId: ANSWER } });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const { wait, event } of events) {
        await new Promise((r) => setTimeout(r, wait));
        if (signal?.aborted) break;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const findConversation = (w: DemoWorld, id: unknown) =>
  w.conversations.find((c) => c.id === id || c.person.id === id) ?? null;

/**
 * The made-up answer to one request, or null to let it through. `path` is the URL's path (`/v1/queries/inbox.list`,
 * `/v1/assistant/messages`); `real` fetches the real answer, for the lists a scene adds rows to.
 */
export async function demoResponse(
  state: DemoState,
  path: string,
  bodyText: string,
  real: () => Promise<Response>,
  signal?: AbortSignal | null,
): Promise<Response | null> {
  let body: Record<string, unknown> = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  const workspaceId = typeof body['workspaceId'] === 'string' ? body['workspaceId'] : '';
  const w = buildWorld(state, workspaceId);
  if (!w) return null;
  const names = namesDemoRecord(bodyText);

  // Ask HandsFreeOS: the scripted answer, and Confirm or Cancel on its card.
  if (path === '/v1/assistant/messages') return w.answer ? stream(w, signal) : null;
  const decided = /^\/v1\/assistant\/tool-calls\/([^/]+)\/(confirm|cancel)$/.exec(path);
  if (decided) {
    const card = w.cards[decodeURIComponent(decided[1]!)];
    if (!card) return null;
    if (decided[2] === 'cancel')
      return json({ ...decision(w, card), status: 'cancelled', outcome: null, href: null });
    // The step that presses Confirm has already counted it as confirmed.
    return json(decision(w, card));
  }
  if (/^\/v1\/assistant\/runs\/[^/]+\/stop$/.test(path) && names) return json({ stopping: false });

  const op = /^\/v1\/(queries|commands)\/(.+)$/.exec(path);
  if (!op) return null;
  const [, kind, name] = op;
  const c = findConversation(w, body['conversationId'] ?? body['personId']);

  if (kind === 'commands') {
    if (!names) return null;
    if (name === 'ai_teammate.decide_draft') {
      // In training, a few approvals short of working on its own: the toast says how far it's come.
      return json({
        draftId: body['draftId'],
        status: body['decision'] === 'reject' ? 'rejected' : 'approved',
        progress: {
          status: 'training',
          approvedCount: 18,
          editedCount: 1,
          rejectedCount: 0,
          approvalsNeeded: 20,
          remaining: 2,
          automaticVia: null,
          becameAutomatic: false,
        },
      });
    }
    return json({});
  }

  switch (name) {
    case 'conversation.get':
      return c ? json(conversation(w, c)) : null;
    case 'conversation.thread':
      return c ? json(thread(w, c)) : null;
    case 'ai_teammate.draft_list': {
      if (c) return json({ items: draftsOf(w, c), nextCursor: null });
      if (body['status'] !== 'pending' || body['conversationId']) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Drafts;
      const mine = w.conversations.flatMap((x) =>
        draftsOf(w, x).filter((d) => d.status === 'pending'),
      );
      return json({ ...got, items: [...mine, ...got.items] });
    }
    case 'inbox.list': {
      const open = (body['status'] ?? 'open') === 'open';
      const plain = !body['q'] && !body['mailbox'] && !body['channel'] && !body['cursor'];
      if (!w.conversations.length || !open || !plain) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Ok<'/v1/queries/inbox.list'>;
      const mine = w.conversations
        .filter((x) => !body['unread'] || x.unread > 0)
        .map((x) => summary(w, x));
      return json({ ...got, items: [...mine, ...got.items] });
    }
    case 'inbox.summary': {
      if (!w.conversations.length) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Ok<'/v1/queries/inbox.summary'>;
      const unread = w.conversations.filter((x) => x.unread > 0).length;
      const open = w.conversations.length;
      return json({
        ...got,
        unread: {
          ...got.unread,
          unassigned: got.unread.unassigned + unread,
          all: got.unread.all + unread,
        },
        open: { ...got.open, unassigned: got.open.unassigned + open, all: got.open.all + open },
        ai: got.ai + open,
      });
    }
    case 'assistant_thread.get':
      return body['threadId'] === THREAD ? json(savedChat(w)) : null;
    case 'campaign.get': {
      const found = w.campaigns.find((x) => x.id === body['campaignId']);
      return found ? json(campaign(found)) : null;
    }
  }
  if (!names) return null;
  // The panels beside a made-up conversation.
  switch (name) {
    case 'appointment.list':
      return c ? json(visits(w, c)) : null;
    case 'timeline.list':
      return c ? json(timeline(c)) : null;
    case 'attention.for_record':
      return json({ items: [] });
    case 'ai_teammate.feedback':
      return json({ feedback: [], messageRuns: [], canSaveRules: false });
    case 'funnel.of_person':
      return json({
        current: null,
        stages: [],
        suggestion: null,
        canJoin: [],
        timeZone: w.state.timeZone,
      });
    case 'money.for_record':
      return json({
        estimates: [],
        invoices: [],
        subscriptions: [],
        balanceCents: 0,
        collectedCents: 0,
        quotedCents: 0,
      });
  }
  // A made-up record this scene has no answer for yet: as if it weren't there, never the real API's guess.
  if (process.env.NODE_ENV !== 'production') console.warn(`demo: no made-up answer for ${name}`);
  return json(
    {
      error: {
        code: 'not_found',
        message: 'That isn’t part of this demo scene.',
        rule: 'demo_not_found',
      },
    },
    404,
  );
}
