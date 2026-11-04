import { CHAT_VISITOR_NAME, type AssistantCard, type AssistantEvent } from '@hfos/core';
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
  type DemoEstimate,
  type DemoInvoice,
  type DemoLine,
  type DemoService,
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
type EstimateGet = Ok<'/v1/queries/estimate.get'>;
type InvoiceGet = Ok<'/v1/queries/invoice.get'>;

const TEAMMATE = demoId(0xa001);
const LINE = demoId(0xa002);
const CALENDAR = demoId(0xa003);
const RUN = demoId(0xa004);
const THREAD = demoId(0xa005);
const ANSWER = demoId(0xa006);
const WIDGET = demoId(0xa008);
const FROM_NUMBER = '+15125550100';

const iso = (ms: number) => new Date(ms).toISOString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What a message or a call reads as in the inbox's row. */
const previewOf = (m: DemoConversation['messages'][number]) =>
  m.call
    ? m.call.status === 'completed'
      ? 'Call answered by your AI teammate'
      : 'Incoming call'
    : m.body;

/** A website chat's counterpart is its visitor; a text's is the phone number. */
const chatOf = (c: DemoConversation) => (c.channel === 'chat' ? (c.visitor ?? null) : null);

function summary(w: DemoWorld, c: DemoConversation): Summary {
  const last = c.messages[c.messages.length - 1]!;
  const waiting = last.direction === 'inbound' ? iso(last.at) : null;
  const visitor = chatOf(c);
  const known = c.known ?? true;
  const channel = c.channel ?? 'sms';
  return {
    id: c.id,
    channel,
    counterpart: visitor ? visitor.id : c.person.phone,
    counterpartDisplay: visitor
      ? known
        ? visitor.name
        : CHAT_VISITOR_NAME
      : phoneDisplay(c.person.phone),
    status: 'open',
    person: known ? { id: c.person.id, fullName: fullName(c.person) } : null,
    assignee: null,
    unreadCount: c.unread,
    lastMessageAt: iso(last.at),
    lastPreview: previewOf(last).slice(0, 140),
    lastDirection: last.direction,
    lastSentBy: last.byMe ? { id: w.state.me.id, fullName: w.state.me.name } : null,
    awaitingReplySince: waiting,
    snoozedUntil: null,
    archived: false,
    openLead: null,
    createdAt: iso(c.createdAt),
    handledBy: c.takenOver ? 'person' : 'ai',
    teammate: { id: TEAMMATE, name: w.state.teammate },
    needsPersonSince: c.handoff ? iso(c.handoff.since) : null,
    handoffReason: c.handoff?.reason ?? null,
    handoffNote: c.handoff?.note ?? null,
    takenOverBy: c.takenOver ? { id: w.state.me.id, fullName: w.state.me.name } : null,
    onSiteNow: !!visitor,
    lanes: [
      {
        id: c.id,
        channel,
        lineId: LINE,
        lineDisplay: visitor ? visitor.site : phoneDisplay(FROM_NUMBER),
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
  const visitor = chatOf(c);
  const known = c.known ?? true;
  return {
    conversation: summary(w, c),
    chat: visitor
      ? {
          visitorId: visitor.id,
          widgetId: WIDGET,
          site: visitor.site,
          name: known ? visitor.name : null,
          phone: known ? phoneDisplay(p.phone) : null,
          phoneE164: known ? p.phone : null,
          email: null,
          // They gave their details in the chat, so they were added to Contacts: nobody was matched.
          matchedOn: null,
          pagePath: visitor.pagePath,
          lastSeenAt: iso(Date.now()),
          onSiteNow: true,
          blocked: false,
          networkBlockedUntil: null,
        }
      : null,
    person: known
      ? {
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
        }
      : null,
    openTasks: [],
    sender: null,
    canText: visitor ? { ok: false, reason: 'chat_channel' } : { ok: true, reason: null },
    social: null,
    fromNumber: phoneDisplay(FROM_NUMBER),
    rcs: false,
    quiet: { quiet: false, localTime: now, endsAt: null },
    timezone: w.state.timeZone,
  };
}

function thread(w: DemoWorld, c: DemoConversation): Thread {
  const chat = c.channel === 'chat';
  const me = { id: w.state.me.id, fullName: w.state.me.name };
  const items = c.messages.map((m): ThreadMessage => ({
    type: m.call ? 'call' : 'message',
    id: m.id,
    occurredAt: iso(m.at),
    direction: m.direction,
    status: m.call ? m.call.status : m.direction === 'inbound' ? 'received' : 'delivered',
    channel: m.call ? null : (c.channel ?? 'sms'),
    body: m.call ? null : m.body,
    subject: null,
    fromAddress: chat ? null : m.direction === 'inbound' ? c.person.phone : FROM_NUMBER,
    media: [],
    sentBy: m.byMe ? me : null,
    errorCode: null,
    errorMessage: null,
    deliveredAt: m.direction === 'outbound' && !chat ? iso(m.at + 2000) : null,
    durationSeconds: m.call?.status === 'completed' ? m.call.seconds : null,
    isVoicemail: false,
    hasRecording: false,
    recordingPath: null,
    recordingSeconds: null,
    answeredVia: m.call?.answeredByAi && m.call.status !== 'ringing' ? 'ai' : null,
    scheduledFor: null,
    transcript: m.call?.transcript ?? null,
    transcriptStatus: m.call?.transcript ? 'completed' : null,
    answeredBy: null,
    conversationId: c.id,
    lineDisplay: null,
    bodyHtml: null,
    toAddresses: chat || m.call ? [] : [m.direction === 'inbound' ? FROM_NUMBER : c.person.phone],
    ccAddresses: [],
    via: null,
    teammate: m.teammate ? { id: TEAMMATE, name: w.state.teammate } : null,
    approvedBy: m.approved ? { id: w.state.me.id, fullName: w.state.me.name } : null,
    aiDraftId: m.draftId ?? null,
    handoffLine: !!m.handoffLine,
    transport: m.call || chat ? null : 'sms',
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
    ...c.messages
      .filter((m) => !m.call)
      .map((m) => ({
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

// ---------------------------------------------------------------------------------------- estimates and invoices

/** The lines as the API reads them back, with nothing off and no tax, so each line's net is its amount. */
function moneyLines(lines: readonly DemoLine[], seed: number): EstimateGet['estimate']['lines'] {
  return lines.map((l, i) => {
    const amount = Math.round(l.quantity * l.unitPriceCents);
    return {
      id: demoId(seed + i),
      position: i,
      productId: null,
      name: l.name,
      description: l.description,
      quantity: l.quantity,
      unitLabel: 'each',
      unitPriceCents: l.unitPriceCents,
      taxable: false,
      discountCents: 0,
      allocatedCents: 0,
      amountCents: amount,
      netCents: amount,
    };
  });
}

function moneyTotals(lines: readonly DemoLine[]): EstimateGet['estimate']['totals'] {
  const total = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitPriceCents), 0);
  return {
    subtotalCents: total,
    discountCents: 0,
    discountPercentBp: null,
    taxableBaseCents: 0,
    taxCents: 0,
    taxRateBp: 0,
    taxLabel: null,
    totalCents: total,
    currency: 'usd',
  };
}

const moneyPerson = (e: DemoEstimate) => ({
  id: e.person.id,
  fullName: fullName(e.person),
  email: e.email,
  phone: phoneDisplay(e.person.phone),
});

const NO_TERMS = { kind: 'none', percentBp: 0, amountCents: 0 } as const;

function invoiceRow(w: DemoWorld, inv: DemoInvoice, e: DemoEstimate) {
  const totals = moneyTotals(e.lines);
  return {
    id: inv.id,
    publicRef: inv.id.slice(-8),
    number: inv.sentAt ? inv.number : null,
    status: inv.sentAt ? ('sent' as const) : ('draft' as const),
    state: inv.sentAt ? 'sent' : 'draft',
    purpose: 'standard' as const,
    origin: 'estimate' as const,
    title: e.title,
    person: moneyPerson(e),
    leadId: null,
    attendeeId: null,
    estimateId: e.id,
    subscriptionId: null,
    connectionId: null,
    assignee: { id: w.state.me.id, fullName: w.state.me.name },
    totals,
    amountPaidCents: 0,
    amountRefundedCents: 0,
    balanceCents: totals.totalCents,
    dueOn: inv.dueOn,
    terms: null,
    sentAt: inv.sentAt ? iso(inv.sentAt) : null,
    firstViewedAt: null,
    paidAt: null,
    voidedAt: null,
    createdAt: iso(inv.createdAt),
  };
}

function estimate(w: DemoWorld, e: DemoEstimate): EstimateGet {
  const totals = moneyTotals(e.lines);
  const accepted = e.accepted ?? null;
  return {
    estimate: {
      id: e.id,
      publicRef: e.id.slice(-8),
      number: e.number,
      status: accepted ? 'accepted' : 'sent',
      state: accepted ? 'accepted' : 'viewed',
      title: e.title,
      person: moneyPerson(e),
      leadId: null,
      assignee: { id: w.state.me.id, fullName: w.state.me.name },
      totals,
      deposit: NO_TERMS,
      depositCents: 0,
      expiresOn: e.expiresOn,
      sentAt: iso(e.sentAt),
      firstViewedAt: iso(e.viewedAt),
      acceptedAt: accepted ? iso(accepted.at) : null,
      declinedAt: null,
      voidedAt: null,
      createdAt: iso(e.createdAt),
      notes: 'Price includes the permit. Good for 30 days.',
      revision: 2,
      linkVersion: 1,
      acceptedName: accepted?.name ?? null,
      acceptedVia: accepted ? 'link' : null,
      acceptedBy: null,
      acceptedWording: accepted
        ? `By typing my name, I approve this estimate from ${w.state.business}.`
        : null,
      declinedReason: null,
      voidReason: null,
      lines: moneyLines(e.lines, 0xd000),
    },
    invoices: w.invoices
      .filter((i) => i.estimateId === e.id)
      .map((i) => {
        const row = invoiceRow(w, i, e);
        return {
          id: row.id,
          number: row.number,
          status: row.status,
          state: row.state,
          purpose: row.purpose,
          totalCents: row.totals.totalCents,
          balanceCents: row.balanceCents,
        };
      }),
  };
}

function invoice(w: DemoWorld, inv: DemoInvoice): InvoiceGet | null {
  const e = w.estimates.find((x) => x.id === inv.estimateId);
  if (!e) return null;
  return {
    invoice: {
      ...invoiceRow(w, inv, e),
      notes: null,
      revision: 1,
      linkVersion: 1,
      voidReason: null,
      lines: moneyLines(e.lines, 0xd100),
    },
    payments: [],
    refunds: [],
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
    body: c.body ?? null,
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
        cards: [...(t.answer.shows ?? []), ...(t.answer.cards ?? []).map(confirmCard)],
        createdAt: iso(t.at + 4000),
      },
    ]),
    toolCalls: Object.values(w.cards).map((c) => decision(w, c)),
    answering: null,
  };
}

/**
 * The scripted answer, streamed as the worker streams one: the steps, what it looked up, the words a few at a time,
 * then a card for each thing it asks to do.
 */
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
  for (const card of a.shows ?? []) events.push({ wait: 250, event: { type: 'card', card } });
  const words = a.text.split(/(?<= )/);
  for (let i = 0; i < words.length; i += 2)
    events.push({ wait: 70, event: { type: 'text', delta: words.slice(i, i + 2).join('') } });
  for (const card of a.cards ?? [])
    events.push({ wait: 400, event: { type: 'card', card: confirmCard(card) } });
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

type ServiceItem = Ok<'/v1/queries/service.list'>['items'][number];
const SERVICE_COLORS = ['#2563eb', '#0d9488', '#d97706', '#7c3aed'];

/** A service added in the scene, as Settings → Calendars → Services lists it: anyone on the team can do it. */
function serviceRow(s: DemoService, i: number): ServiceItem {
  return {
    id: s.id,
    name: s.name,
    description: null,
    durations: [s.minutes],
    defaultDuration: s.minutes,
    bufferBefore: 0,
    bufferAfter: 15,
    color: SERVICE_COLORS[i % SERVICE_COLORS.length]!,
    priceCents: s.priceCents,
    repeatMonths: null,
    locationKinds: [],
    staffUserIds: [],
    resources: [],
    hours: null,
    archivedAt: null,
  };
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
    if (name === 'conversation.take_over' && c)
      return json({ conversationId: c.id, draftCancelled: false });
    if (name === 'conversation.hand_to_ai' && c)
      return json({ conversationId: c.id, teammateId: TEAMMATE });
    if (name === 'estimate.convert') {
      // The step that presses it has already raised the invoice.
      const inv = w.invoices.find((i) => i.estimateId === body['estimateId']);
      const e = w.estimates.find((x) => x.id === body['estimateId']);
      if (inv && e)
        return json({
          estimateId: e.id,
          invoiceId: inv.id,
          purpose: 'standard',
          totalCents: moneyTotals(e.lines).totalCents,
          depositCents: 0,
        });
    }
    if (name === 'invoice.send' || name === 'estimate.send') {
      const inv = w.invoices.find((i) => i.id === body['invoiceId']);
      if (inv) return json({ invoiceId: inv.id, number: inv.number, status: 'sent' });
    }
    if (name === 'message.send' && c) {
      // The step that types it has already put it in the thread: the composer swaps its own copy for that one.
      const sent = [...c.messages].reverse().find((m) => m.byMe);
      return json({
        messageId: sent?.id ?? demoId(0xa009),
        conversationId: c.id,
        status: 'sent',
        duplicate: false,
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
    case 'ai_teammate.get': {
      if (!w.teammateAutomatic) return null;
      // Past its training: replies go out on their own, so the banner says so.
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Ok<'/v1/queries/ai_teammate.get'>;
      return json({
        ...got,
        teammate: got.teammate ? { ...got.teammate, status: 'automatic' } : null,
        progress: got.progress
          ? { ...got.progress, status: 'automatic', remaining: 0, automaticVia: 'threshold' }
          : null,
      });
    }
    case 'assistant_thread.get':
      return body['threadId'] === THREAD ? json(savedChat(w)) : null;
    case 'estimate.get': {
      const found = w.estimates.find((x) => x.id === body['estimateId']);
      return found ? json(estimate(w, found)) : null;
    }
    case 'invoice.get': {
      const found = w.invoices.find((x) => x.id === body['invoiceId']);
      const out = found ? invoice(w, found) : null;
      return out ? json(out) : null;
    }
    case 'campaign.get': {
      const found = w.campaigns.find((x) => x.id === body['campaignId']);
      return found ? json(campaign(found)) : null;
    }
    case 'service.list': {
      if (!w.services.length) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Ok<'/v1/queries/service.list'>;
      // A real service of the same name gives way to the scene's, so the list never shows it twice.
      const mine = w.services.map(serviceRow);
      const items = [...got.items.filter((s) => !mine.some((m) => m.name === s.name)), ...mine];
      return json({ ...got, items: items.sort((a, b) => a.name.localeCompare(b.name)) });
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
