import {
  ADDON_CATALOG,
  CHAT_VISITOR_NAME,
  emptyTeammateConfig,
  type AssistantCard,
  type AssistantEvent,
} from '@hfos/core';
import type { Ok } from '../api/types';
import {
  appointmentDetail,
  appointmentItem,
  CALENDAR,
  chatOf as videoChatOf,
  documentOf,
  findSuggestion,
  findVisit,
  leadTimeline,
  notesOf,
  seatOf,
  suggestionsOf,
  tasksWith,
  teamWithMe,
  transcriptsOf,
  videoCallOf,
  visitsBetween,
  webinarChatOf,
  webinarLeadsOf,
} from './respond-calendar';
import {
  boardWith,
  importOf,
  offersWith,
  peopleWith,
  reviewsWith,
  searchWith,
} from './respond-growth';
import { buildWorld, findScene } from './scenes';
import type { DemoState } from './state';
import {
  businessOf,
  DEMO_MEDIA_BUCKET,
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
  type DemoLeadRecord,
  type DemoLesson,
  type DemoLine,
  type DemoPerson,
  type DemoReferral,
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
const RUN = demoId(0xa004);
const THREAD = demoId(0xa005);
const ANSWER = demoId(0xa006);
const WIDGET = demoId(0xa008);
const FROM_NUMBER = '+15125550100';
const STAGE = demoId(0xa00a);
const PIPELINE = demoId(0xa00b);
const SOCIAL_ACCOUNT = demoId(0xa00c);
/** The business's card account, for a scene's invoices to be paid into. */
const STRIPE = demoId(0xa023);

/** "brightpathhomeservices": the business's name as an address or a handle. */
const slugOf = (w: DemoWorld) =>
  businessOf(w)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'business';
/** The business's mailbox that email scenes write to. */
const mailboxOf = (w: DemoWorld) => `office@${slugOf(w)}.com`;
const isSocial = (c: DemoConversation) => c.channel === 'messenger' || c.channel === 'instagram';

const iso = (ms: number) => new Date(ms).toISOString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What a message or a call reads as in the inbox's row. A call out reads as core's callPreview words it. */
const previewOf = (m: DemoConversation['messages'][number]) =>
  m.call
    ? m.direction === 'outbound'
      ? m.call.status === 'completed' && m.call.seconds !== null
        ? `Call · ${Math.floor(m.call.seconds / 60)}:${String(m.call.seconds % 60).padStart(2, '0')}`
        : 'Calling…'
      : m.call.status === 'missed'
        ? 'Missed call'
        : m.call.status === 'completed'
          ? 'Call answered by your AI teammate'
          : 'Incoming call'
    : m.body || (m.media?.length ? 'Sent a photo' : '');

/** A website chat's counterpart is its visitor; a text's is the phone number. */
const chatOf = (c: DemoConversation) => (c.channel === 'chat' ? (c.visitor ?? null) : null);

function summary(w: DemoWorld, c: DemoConversation): Summary {
  const last = c.messages[c.messages.length - 1]!;
  const waiting = last.direction === 'inbound' ? iso(last.at) : null;
  const visitor = chatOf(c);
  const known = c.known ?? true;
  const channel = c.channel ?? 'sms';
  const email = channel === 'email' ? (c.person.email ?? null) : null;
  const social = isSocial(c) ? (c.social ?? null) : null;
  return {
    id: c.id,
    channel,
    counterpart: visitor
      ? visitor.id
      : (email ?? (social ? (social.username ?? social.name) : c.person.phone)),
    counterpartDisplay: visitor
      ? known
        ? visitor.name
        : CHAT_VISITOR_NAME
      : (email ?? social?.name ?? phoneDisplay(c.person.phone)),
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
    openLead: c.openLead
      ? {
          id: c.openLead.id,
          title: c.openLead.title,
          stageId: STAGE,
          pipelineId: PIPELINE,
          stageName: c.openLead.stage,
          valueCents: c.openLead.valueCents,
          nextAction: null,
          nextActionAt: null,
        }
      : null,
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
        lineDisplay: visitor
          ? visitor.site
          : channel === 'email'
            ? mailboxOf(w)
            : social
              ? channel === 'instagram'
                ? `@${slugOf(w)}`
                : w.state.business
              : phoneDisplay(FROM_NUMBER),
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
          email: p.email ?? null,
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
    social: socialOf(w, c),
    fromNumber: (c.channel ?? 'sms') === 'sms' ? phoneDisplay(FROM_NUMBER) : null,
    rcs: false,
    quiet: { quiet: false, localTime: now, endsAt: null },
    timezone: w.state.timeZone,
  };
}

/** A Messenger or Instagram thread's Page or account, who wrote, and Meta's day to reply in. */
function socialOf(w: DemoWorld, c: DemoConversation): Conversation['social'] {
  if (!isSocial(c) || !c.social) return null;
  const instagram = c.channel === 'instagram';
  const lastIn = [...c.messages].reverse().find((m) => m.direction === 'inbound');
  return {
    account: {
      id: SOCIAL_ACCOUNT,
      platform: instagram ? 'instagram' : 'facebook',
      name: w.state.business,
      username: instagram ? slugOf(w) : null,
      label: instagram ? `@${slugOf(w)}` : w.state.business,
      status: 'active',
      problem: null,
    },
    contact: { name: c.social.name, username: c.social.username },
    everWrote: true,
    window: {
      open: true,
      peopleOnly: false,
      closesAt: iso((lastIn?.at ?? c.createdAt) + 24 * 3600_000),
    },
    textLimit: instagram ? 1000 : 2000,
  };
}

function thread(w: DemoWorld, c: DemoConversation): Thread {
  const chat = c.channel === 'chat';
  const email = c.channel === 'email';
  const social = isSocial(c);
  const sms = (c.channel ?? 'sms') === 'sms';
  const me = { id: w.state.me.id, fullName: w.state.me.name };
  const items = c.messages.map((m): ThreadMessage => ({
    type: m.call ? 'call' : 'message',
    id: m.id,
    occurredAt: iso(m.at),
    direction: m.direction,
    status: m.call
      ? m.call.status === 'missed'
        ? 'no-answer'
        : m.call.status
      : m.direction === 'inbound'
        ? 'received'
        : 'delivered',
    channel: m.call ? null : (c.channel ?? 'sms'),
    body: m.call ? null : m.body || null,
    subject: m.subject ?? null,
    fromAddress:
      chat || social
        ? null
        : email
          ? m.direction === 'inbound'
            ? (c.person.email ?? null)
            : mailboxOf(w)
          : m.direction === 'inbound'
            ? c.person.phone
            : FROM_NUMBER,
    media: (m.media ?? []).map((x) => ({
      bucket: DEMO_MEDIA_BUCKET,
      objectPath: x.path,
      contentType: x.contentType,
      sizeBytes: x.sizeBytes,
      name: x.name,
    })),
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
    toAddresses:
      chat || social || m.call
        ? []
        : email
          ? [m.direction === 'inbound' ? mailboxOf(w) : (c.person.email ?? '')]
          : [m.direction === 'inbound' ? FROM_NUMBER : c.person.phone],
    ccAddresses: [],
    via: null,
    teammate: m.teammate ? { id: TEAMMATE, name: w.state.teammate } : null,
    approvedBy: m.approved ? { id: w.state.me.id, fullName: w.state.me.name } : null,
    aiDraftId: m.draftId ?? null,
    handoffLine: !!m.handoffLine,
    transport: m.call || !sms ? null : m.media?.length ? 'mms' : 'sms',
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
  const ask = d.ask;
  return {
    id: d.id,
    kind: ask ? 'ask' : 'reply',
    status: d.status,
    teammate: { id: TEAMMATE, name: w.state.teammate },
    runId: RUN,
    conversationId: c.id,
    channel: c.channel ?? 'sms',
    person: { id: c.person.id, fullName: fullName(c.person) },
    lead: null,
    preview: {
      message: {
        channel: c.channel ?? 'sms',
        body: d.body,
        subject: d.subject ?? null,
        inReplyToMessageId: d.inReplyTo,
      } as Draft['preview']['message'],
      actions: [
        ...(d.book
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
              } as const,
            ]
          : []),
        ...actionOf(d),
      ],
      discount: null,
      call: null,
      ask: ask
        ? {
            addonId: ask.addonId,
            addonName: ADDON_CATALOG.find((m) => m.id === ask.addonId)?.name ?? ask.addonId,
            operation: ask.operation,
            tool: ask.tool,
            input: { ...ask.input },
            recordId: ask.recordId,
            summary: ask.summary,
          }
        : null,
      flags: [],
      funnel: null,
    },
    edits: d.edited ? { body: d.edited } : null,
    reason: null,
    decidedBy: d.status === 'pending' ? null : { id: w.state.me.id, fullName: w.state.me.name },
    decidedAt: d.decidedAt ? iso(d.decidedAt) : null,
    via: null,
    expiresAt: iso(d.at + 24 * 3600_000),
    createdAt: iso(d.at),
    canDecide: true,
    record: ask ? { id: ask.recordId, name: ask.recordName } : null,
    knowledge: (d.knowledge ?? []).map((title) => ({ title })),
  };
}

/** The draft's other action, as the API reads it back. */
function actionOf(d: DemoDraft): Draft['preview']['actions'] {
  const a = d.action;
  if (!a) return [];
  if (a.kind === 'reschedule')
    return [
      {
        kind: 'reschedule',
        appointmentId: a.visitId,
        startsAt: iso(a.startsAt),
        sessionId: null,
        summary: a.summary,
      },
    ];
  if (a.kind === 'cancel')
    return [{ kind: 'cancel', appointmentId: a.visitId, reason: null, summary: a.summary }];
  return [
    { kind: 'share_link', document: 'estimate', documentId: a.estimateId, summary: a.summary },
  ];
}

/** Newest first, as the API lists them. */
const draftsOf = (w: DemoWorld, c: DemoConversation) =>
  [...c.drafts].sort((a, b) => b.at - a.at).map((d) => draft(w, c, d));

/** Their visits; a cancelled one only when asked for, as the API lists them. */
function visits(w: DemoWorld, c: DemoConversation, status: unknown): Visits {
  const cancelled = Array.isArray(status) && status.includes('cancelled');
  return {
    timezone: w.state.timeZone,
    items: c.visits
      .filter((v) => cancelled || !v.cancelled)
      .map((visit) => appointmentItem(w, { visit, person: c.person, conversationId: c.id })),
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

const moneyPerson = (p: DemoPerson, email: string | null) => ({
  id: p.id,
  fullName: fullName(p),
  email,
  phone: phoneDisplay(p.phone),
});

/** What an invoice bills: its estimate's customer and lines, or its own. */
interface Bill {
  readonly title: string;
  readonly person: DemoPerson;
  readonly email: string | null;
  readonly lines: readonly DemoLine[];
}

function billOf(w: DemoWorld, inv: DemoInvoice): Bill | null {
  if (inv.estimateId) {
    const e = w.estimates.find((x) => x.id === inv.estimateId);
    return e ? { title: e.title, person: e.person, email: e.email, lines: e.lines } : null;
  }
  return inv.person && inv.lines
    ? { title: inv.title ?? '', person: inv.person, email: inv.email ?? null, lines: inv.lines }
    : null;
}

const NO_TERMS = { kind: 'none', percentBp: 0, amountCents: 0 } as const;

function invoiceRow(w: DemoWorld, inv: DemoInvoice, bill: Bill) {
  const totals = moneyTotals(bill.lines);
  const paid = inv.paid ?? null;
  const status = paid ? ('paid' as const) : inv.sentAt ? ('sent' as const) : ('draft' as const);
  return {
    id: inv.id,
    publicRef: inv.id.slice(-8),
    number: inv.sentAt ? inv.number : null,
    status,
    state: status,
    purpose: inv.purpose ?? ('standard' as const),
    origin: inv.estimateId
      ? ('estimate' as const)
      : inv.purpose === 'deposit'
        ? ('booking' as const)
        : ('staff' as const),
    title: bill.title,
    person: moneyPerson(bill.person, bill.email),
    leadId: null,
    attendeeId: inv.appointmentId ? seatOf(inv.appointmentId) : null,
    estimateId: inv.estimateId ?? null,
    subscriptionId: null,
    connectionId: STRIPE,
    assignee: { id: w.state.me.id, fullName: w.state.me.name },
    totals,
    amountPaidCents: paid ? totals.totalCents : 0,
    amountRefundedCents: 0,
    balanceCents: paid ? 0 : totals.totalCents,
    dueOn: inv.dueOn,
    terms: null,
    sentAt: inv.sentAt ? iso(inv.sentAt) : null,
    // Opened from the text a moment after it went, and paid from there.
    firstViewedAt: paid ? iso(Math.max((inv.sentAt ?? paid.at) + 5_000, paid.at - 60_000)) : null,
    paidAt: paid ? iso(paid.at) : null,
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
      person: moneyPerson(e.person, e.email),
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
  const bill = billOf(w, inv);
  if (!bill) return null;
  const row = invoiceRow(w, inv, bill);
  const paid = inv.paid ?? null;
  return {
    invoice: {
      ...row,
      notes: null,
      revision: 1,
      linkVersion: 1,
      voidReason: null,
      lines: moneyLines(bill.lines, 0xd100),
    },
    // Paid by card from the link on their phone, through the business's Stripe account.
    payments: paid
      ? [
          {
            id: demoId(parseInt(inv.id.slice(-12), 16) + 0x8200),
            invoiceId: inv.id,
            amountCents: row.totals.totalCents,
            method: 'card',
            provider: 'stripe',
            providerStatus: 'succeeded',
            status: 'succeeded',
            cardBrand: paid.brand,
            cardLast4: paid.last4,
            connectionId: STRIPE,
            feeCents: null,
            netCents: null,
            failureCode: null,
            refundedCents: 0,
            recordedBy: null,
            receivedAt: iso(paid.at),
            createdAt: iso(paid.at - 20_000),
          },
        ]
      : [],
    refunds: [],
  };
}

/** The invoices written for one visit, as its sheet reads them. */
function visitInvoices(w: DemoWorld, appointmentId: unknown) {
  return w.invoices
    .filter((i) => i.appointmentId === appointmentId)
    .flatMap((i) => {
      const bill = billOf(w, i);
      return bill ? [invoiceRow(w, i, bill)] : [];
    });
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
    stageFrom: c.stageFrom ?? null,
    stageTo: c.stageTo ?? null,
    warnings: [...(c.note ? [{ kind: 'note', text: c.note }] : []), ...(c.warnings ?? [])].slice(
      0,
      3,
    ),
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

type Attention = Ok<'/v1/queries/attention.list'>;

/** Home's card for a lesson the AI teammate made of the presenter's change, as the Action Center words it. */
function lessonItem(w: DemoWorld, l: DemoLesson): Attention['items'][number] {
  const chip = `Corrected once · “${l.line}”`;
  return {
    ...cardBase(l.id, l.at),
    kind: 'ai_corrections',
    subject: { type: 'lesson', id: l.id },
    title: `${w.state.teammate} was corrected`,
    detail: l.why,
    valueCents: 0,
    reasons: [{ code: 'corrected', label: chip, text: chip }],
    score: 40,
    handleLabel: 'Add to its instructions',
    actions: { handle: true, letHandle: false, assign: false, snooze: true, dismiss: true },
  };
}

/** Home's card for somebody a customer mentioned, as the Action Center words it: one press makes the lead. */
function referralItem(r: DemoReferral): Attention['items'][number] {
  return {
    ...cardBase(r.id, r.at),
    kind: 'referral_mentioned',
    subject: { type: 'referral', id: r.id },
    personId: r.from.id,
    conversationId: r.conversationId,
    title: `${fullName(r.from)} · Mentioned ${r.name}`,
    detail: r.quote,
    // Somebody new: the business's typical job, as an estimate.
    valueCents: 45_000,
    reasons: [
      { code: 'referral', label: `${r.relation} · ${r.need}`, text: `${r.relation} · ${r.need}` },
    ],
    score: 60,
    handleLabel: 'Create lead',
    actions: { handle: true, letHandle: false, assign: true, snooze: true, dismiss: true },
  };
}

/** What every made-up Home card shares: open, nobody's yet, nothing done about it. */
function cardBase(id: string, at: number) {
  return {
    id,
    state: 'open' as const,
    personId: null,
    leadId: null,
    conversationId: null,
    appointmentId: null,
    startsAt: null,
    reach: null,
    callable: false,
    addonAlert: null,
    valueIsEstimate: true,
    urgent: false,
    urgency: 0,
    since: iso(at),
    urgentFrom: null,
    dueAt: null,
    openedAt: iso(at),
    assignee: null,
    snoozedUntil: null,
    dismissedAt: null,
    dismissReason: null,
    handled: null,
    auto: { action: null, state: null, scheduledFor: null, doneAt: null, skipReason: null },
    letHandleMode: 'none' as const,
  };
}

/** The business's pipeline, as Bright Path's seed names its stages. */
const STAGES = [
  { name: 'New', kind: 'open' },
  { name: 'Quoted', kind: 'open' },
  { name: 'Scheduled', kind: 'open' },
  { name: 'Won', kind: 'won' },
  { name: 'Lost', kind: 'lost' },
] as const;
const stageId = (name: string) =>
  demoId(
    0xa010 +
      Math.max(
        0,
        STAGES.findIndex((s) => s.name === name),
      ),
  );

function lead(w: DemoWorld, l: DemoLeadRecord): Ok<'/v1/queries/lead.get'> {
  const stage = STAGES.find((s) => s.name === l.stage) ?? STAGES[0];
  return {
    lead: {
      id: l.id,
      title: l.title,
      pipelineId: PIPELINE,
      stageId: stageId(stage.name),
      stageName: stage.name,
      stageKind: stage.kind,
      status: 'open',
      person: { id: l.person.id, fullName: fullName(l.person), archived: false },
      company: null,
      valueCents: l.valueCents,
      source: l.source,
      assignee: { id: w.state.me.id, fullName: w.state.me.name },
      expectedCloseOn: null,
      nextAction: null,
      nextActionAt: null,
      needsNextAction: true,
      nextActionOverdue: false,
      lastContactAt: null,
      wonAt: null,
      lostAt: null,
      lostReason: null,
      position: 0,
      tags: [],
      stageEnteredAt: iso(l.at),
      archivedAt: null,
      createdAt: iso(l.at),
      updatedAt: iso(l.at),
      qualification: null,
    },
    stages: STAGES.map((s, i) => ({
      id: stageId(s.name),
      name: s.name,
      kind: s.kind,
      position: i,
    })),
  };
}

/** Where a Messenger or Instagram conversation's customer came from: the ad they tapped. */
function attribution(w: DemoWorld, c: DemoConversation | null): Ok<'/v1/queries/attribution.list'> {
  const ad = c?.social?.ad;
  if (!c || !ad) return { touches: [], first: null, latest: null, total: 0 };
  const id = demoId(0xa00d);
  const instagram = c.channel === 'instagram';
  return {
    touches: [
      {
        id,
        touchedAt: iso(ad.at),
        kind: 'started',
        platform: instagram ? 'instagram' : 'facebook',
        channel: instagram ? 'instagram' : 'messenger',
        source: 'ADS',
        referralType: 'OPEN_THREAD',
        ref: null,
        adId: '120210000000000001',
        adTitle: ad.headline,
        adPhotoUrl: null,
        postId: null,
        refererUri: null,
        conversationId: c.id,
        personId: c.person.id,
        leadId: c.openLead?.id ?? null,
        accountName: w.state.business,
        formName: null,
        ad: {
          externalId: '120210000000000001',
          status: 'resolved',
          name: ad.name,
          adsetId: null,
          adsetName: null,
          campaignId: '120210000000000002',
          campaignName: ad.campaign,
          campaignObjective: 'OUTCOME_ENGAGEMENT',
          creativeId: null,
          creativeName: null,
          creativeTitle: ad.headline,
          creativeBody: ad.body,
          creativeThumbnailUrl: null,
          callToAction: 'MESSAGE_PAGE',
          platforms: [instagram ? 'instagram' : 'facebook'],
        },
      },
    ],
    first: id,
    latest: id,
    total: 1,
  };
}

/** Replying by email: from the business's mailbox, to the customer, on the thread's subject. */
function composeOptions(
  w: DemoWorld,
  c: DemoConversation,
): Ok<'/v1/queries/email.compose_options'> {
  const subject = [...c.messages].reverse().find((m) => m.subject)?.subject ?? null;
  const address = demoId(0xa00e);
  return {
    to: c.person.email ?? null,
    conversationId: c.id,
    canEmail: c.person.email ? { ok: true, reason: null } : { ok: false, reason: 'no_email' },
    suppressed: null,
    addresses: [
      {
        id: address,
        address: mailboxOf(w),
        displayName: w.state.business,
        isDefault: true,
        usable: true,
      },
    ],
    fromAddressId: address,
    mailboxes: [],
    replySubject: subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : null,
  };
}

/**
 * A business as account.me and workspace.get describe it, with the scene's add-ons on: in its list, and every one of
 * their permissions held, as an owner holds them.
 */
type Shelled = { addons: string[]; permissions: string[] };
function withAddons<T extends Shelled>(ws: T, addons: readonly string[]): T {
  const keys = addons.flatMap(
    (id) => ADDON_CATALOG.find((m) => m.id === id)?.permissions.map((p) => p.key) ?? [],
  );
  return {
    ...ws,
    addons: [...new Set([...ws.addons, ...addons])],
    permissions: [...new Set([...ws.permissions, ...keys])],
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
  // Copy link on a made-up estimate, invoice or plan: a customer's link in the shape the worker mints.
  if (path === '/v1/money/link' && names) {
    const letter = String(body['kind'] ?? 'estimate').slice(0, 1);
    return json({ url: `https://app.handsfreeos.com/${letter}/${String(body['id']).slice(-8)}` });
  }

  const op = /^\/v1\/(queries|commands)\/(.+)$/.exec(path);
  // The scene's own answers, whatever they name: an import that never leaves the tab. The worker's test chat is
  // `ai_team.test`.
  const scene = findScene(state.scene);
  const own = scene?.answers?.[path === '/v1/ai-team/test' ? 'ai_team.test' : (op?.[2] ?? '')];
  if (own) {
    const answer = await own(
      w,
      body,
      async () => {
        const r = await real();
        return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
      },
      signal,
    );
    if (answer instanceof Response) return answer;
    if (answer !== undefined) return json(answer);
  }
  if (!op) return null;
  const [, kind, name] = op;
  // An add-on the scene shows as on: the shell draws its menu row and opens its pages.
  if (scene?.addons?.length && (name === 'account.me' || name === 'workspace.get')) {
    const r = await real();
    if (!r.ok) return r;
    const got = (await r.json()) as Record<string, unknown>;
    const on = scene.addons;
    return json(
      name === 'account.me'
        ? { ...got, workspaces: (got['workspaces'] as Shelled[]).map((x) => withAddons(x, on)) }
        : { ...got, workspace: withAddons(got['workspace'] as Shelled, on) },
    );
  }
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
    if (name === 'referral.create_lead') {
      // The step that presses it has already made the lead.
      const r = w.referrals.find((x) => x.id === body['referralId']);
      const l = r?.leadId ? w.leads.find((x) => x.id === r.leadId) : null;
      if (r && l)
        return json({
          referralId: r.id,
          personId: l.person.id,
          leadId: l.id,
          existingPerson: false,
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
    if (name === 'invoice.create') {
      // The step that presses Invoice this visit has already written it.
      const inv = [...w.invoices]
        .reverse()
        .find(
          (i) => !i.estimateId && i.appointmentId && seatOf(i.appointmentId) === body['attendeeId'],
        );
      const bill = inv ? billOf(w, inv) : null;
      if (inv && bill) {
        const total = moneyTotals(bill.lines).totalCents;
        return json({
          invoiceId: inv.id,
          number: null,
          status: 'draft',
          totalCents: total,
          balanceCents: total,
          dueOn: inv.dueOn,
          revision: 1,
          changed: true,
        });
      }
    }
    if (name === 'appointment.set_status' && findVisit(w, body['appointmentId']))
      return json({ appointmentId: body['appointmentId'], status: body['status'] });
    if (name === 'call_suggestion.decide') {
      const found = findSuggestion(w, body['suggestionId']);
      if (found)
        return json({
          suggestionId: found.id,
          status: body['decision'] === 'dismiss' ? 'dismissed' : 'approved',
          taskId:
            found.kind === 'task' && body['decision'] !== 'dismiss'
              ? demoId(parseInt(found.id.slice(-12), 16) + 0x8300)
              : null,
          conversationId: null,
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
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Ok<'/v1/queries/ai_teammate.get'>;
      if (got.teammate && !w.teammateAutomatic) return json(got);
      // A business with no AI teammate yet (Bright Path has none) gets one in training, with its default
      // settings, so its drafts and banners read as they would. Past its training, replies go out on their own.
      const status = w.teammateAutomatic ? 'automatic' : (got.teammate?.status ?? 'training');
      const since = new Date(w.state.startedAt - 30 * 24 * 3600_000).toISOString();
      const teammate = got.teammate ?? {
        id: TEAMMATE,
        name: w.state.teammate,
        status,
        config: emptyTeammateConfig() as unknown as Record<string, unknown>,
        configVersion: 1,
        revision: 1,
        labels: [],
        trainingStartedAt: since,
        automaticSince: null,
        createdAt: since,
        updatedAt: since,
      };
      const progress = got.progress ?? {
        status,
        approvedCount: 17,
        editedCount: 1,
        rejectedCount: 0,
        approvalsNeeded: 20,
        remaining: 3,
        automaticVia: null,
      };
      return json({
        ...got,
        teammate: { ...teammate, status },
        progress: w.teammateAutomatic
          ? {
              ...progress,
              status,
              approvedCount: Math.max(progress.approvedCount, progress.approvalsNeeded),
              remaining: 0,
              automaticVia: 'threshold',
            }
          : progress,
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
    case 'attention.list': {
      const mine = [
        ...w.referrals.filter((r) => !r.leadId).map(referralItem),
        ...w.lessons.filter((l) => !l.applied).map((l) => lessonItem(w, l)),
      ];
      if (!mine.length) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Attention;
      return json({
        ...got,
        items: [...mine, ...got.items],
        counts: {
          ...got.counts,
          total: got.counts.total + mine.length,
          mine: got.counts.mine + mine.length,
          everyone: got.counts.everyone + mine.length,
        },
      });
    }
    case 'appointment.list': {
      // The calendar's week: the real visits, and the scene's in it. A person's or a lead's list is answered below.
      if (body['personId'] || body['leadId'] || body['conversationId'] || names) break;
      const mine = visitsBetween(w, body['from'], body['to']);
      if (!mine.length) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Visits;
      return json({ ...got, items: [...got.items, ...mine] });
    }
    case 'schedule.team': {
      // The scene's visits are the presenter's, so the calendar has a column for them, with their Google busy times.
      if (!visitsBetween(w, null, null).length && !w.google.connected) return null;
      const res = await real();
      if (!res.ok) return res;
      return json(teamWithMe(w, (await res.json()) as Ok<'/v1/queries/schedule.team'>));
    }
    case 'payment_connection.list': {
      // A scene's invoices are paid by card, into an account of the business's that only the scene has.
      if (!w.invoices.some((i) => !i.estimateId)) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Ok<'/v1/queries/payment_connection.list'>;
      const since = iso(w.state.startedAt - 200 * 24 * 3600_000);
      return json({
        connections: [
          {
            id: STRIPE,
            provider: 'stripe',
            environment: 'live',
            status: 'active',
            displayName: null,
            label: null,
            externalAccountId: 'acct_demo',
            isDefault: true,
            usableByMe: true,
            usedBy: 'everyone',
            userIds: [],
            capabilities: {},
            connectedAt: since,
            disconnectedAt: null,
            disconnectedReason: null,
            failures: 0,
            lastError: null,
            liveSubscriptions: 0,
            locationId: null,
            tokenExpiresAt: null,
          },
          ...got.connections.map((c) => ({ ...c, isDefault: false })),
        ],
      });
    }
    case 'review.list': {
      if (!w.reviews.length && !w.reviewsConnected) return null;
      const res = await real();
      if (!res.ok) return res;
      return json(reviewsWith(w, (await res.json()) as Ok<'/v1/queries/review.list'>));
    }
    case 'offer.list': {
      if (!w.offers.length) return null;
      const res = await real();
      if (!res.ok) return res;
      return json(offersWith(w, (await res.json()) as Ok<'/v1/queries/offer.list'>));
    }
    case 'lead.board': {
      if (!w.leads.some((l) => l.onBoard)) return null;
      const res = await real();
      if (!res.ok) return res;
      return json(boardWith(w, (await res.json()) as Ok<'/v1/queries/lead.board'>));
    }
    case 'person.list': {
      // Only the plain list: a search, a tag or a page further on is the real one alone.
      const plain = !body['q'] && !body['tagId'] && !body['cursor'] && !body['standing'];
      if (!w.imports.length || !plain) return null;
      const res = await real();
      if (!res.ok) return res;
      return json(peopleWith(w, (await res.json()) as Ok<'/v1/queries/person.list'>));
    }
    case 'crm.summary': {
      const brought = w.imports.reduce((n, i) => n + i.people.length, 0);
      if (!brought) return null;
      const res = await real();
      if (!res.ok) return res;
      const got = (await res.json()) as Ok<'/v1/queries/crm.summary'>;
      return json({ ...got, people: got.people + brought });
    }
    case 'search.everything': {
      const out = await searchWith(w, body, real);
      return out instanceof Response ? out : out ? json(out) : null;
    }
    case 'task.list': {
      // The tasks the AI added in the scene: on the Tasks page, opened by Open task, and on the lead's page.
      const out = await tasksWith(w, body, real);
      if (out) return out instanceof Response ? out : json(out);
      break;
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
  // A made-up lead's page.
  const l = w.leads.find((x) => x.id === (body['leadId'] ?? body['recordId']));
  if (l || w.leads.some((x) => x.person.id === body['personId']))
    switch (name) {
      case 'lead.get':
        return l ? json(lead(w, l)) : null;
      case 'timeline.list':
        return json(l ? leadTimeline(w, l) : { items: [], nextCursor: null });
      case 'task.list':
        return json({ items: [], nextCursor: null, timezone: w.state.timeZone });
      case 'file.list':
        return json({ files: [] });
      case 'workflow.run_list':
        return json({ items: [], nextCursor: null });
      case 'appointment.list':
        // Their conversation's visits, when they have one: a lead's visit is booked in its chat.
        return json(c ? visits(w, c, body['status']) : { timezone: w.state.timeZone, items: [] });
    }
  // A visit's sheet, what the AI made of a recorded call, and a contract sent to sign.
  switch (name) {
    case 'appointment.get': {
      const v = findVisit(w, body['appointmentId']);
      if (v) return json({ appointment: appointmentDetail(w, v) });
      break;
    }
    case 'appointment.transcripts': {
      const v = findVisit(w, body['appointmentId']);
      return json(transcriptsOf(notesOf(w, body), v ? 'zoom' : 'handsfree'));
    }
    case 'call_suggestion.list':
      return json(suggestionsOf(notesOf(w, body), !!body['callId']));
    case 'video_call.chat': {
      const chat = videoChatOf(w, body['callId']) ?? webinarChatOf(w, body['callId']);
      if (chat) return json(chat);
      break;
    }
    case 'video_call.get': {
      const call = videoCallOf(w, body);
      if (call) return json(call);
      break;
    }
    case 'video_call.leads': {
      const leads = webinarLeadsOf(w, body);
      if (leads) return json(leads);
      break;
    }
    case 'import.get': {
      const i = w.imports.find((x) => x.id === body['importId']);
      if (i) return json(importOf(w, i));
      break;
    }
    case 'document.get': {
      const d = w.documents.find((x) => x.id === body['documentId']);
      if (d) return json(documentOf(w, d));
      break;
    }
    case 'calendar.get':
      // The made-up visits' calendar has no settings of its own: the sheet does without, as it does for a refusal.
      if (body['calendarId'] === CALENDAR)
        return json(
          { error: { code: 'not_found', message: 'Not in this demo.', rule: 'demo_not_found' } },
          404,
        );
      break;
  }
  // The panels beside a made-up conversation.
  switch (name) {
    case 'appointment.list':
      return c ? json(visits(w, c, body['status'])) : null;
    case 'timeline.list':
      return c ? json(timeline(c)) : null;
    case 'attention.for_record':
      return json({ items: [] });
    case 'attribution.list':
      return json(attribution(w, c));
    case 'email.compose_options':
      return c ? json(composeOptions(w, c)) : null;
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
    case 'money.for_record': {
      const invoices =
        body['recordType'] === 'appointment' ? visitInvoices(w, body['recordId']) : [];
      return json({
        estimates: [],
        invoices,
        subscriptions: [],
        balanceCents: invoices.reduce((n, i) => n + i.balanceCents, 0),
        collectedCents: invoices.reduce((n, i) => n + i.amountPaidCents, 0),
        quotedCents: 0,
      });
    }
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
