import { executeCommand, plainSpaces, registry, type AssistantCard } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { personQuery } from './context';
import type { ToolContext, ToolOutcome } from './runtime';
import {
  appointmentCard,
  calendarReadTools,
  todaysAppointments,
  upcomingFor,
} from './tools-calendar';

/** App pages the cards link to (the panel follows only these). */
export const paths = (ws: string) => ({
  person: (id: string) => `/app/w/${ws}/customers/people/${id}`,
  company: (id: string) => `/app/w/${ws}/customers/companies/${id}`,
  lead: (id: string) => `/app/w/${ws}/leads/${id}`,
  conversation: (id: string) => `/app/w/${ws}/inbox/${id}`,
  pipeline: () => `/app/w/${ws}/pipeline`,
  tasks: () => `/app/w/${ws}/tasks`,
  inbox: () => `/app/w/${ws}/inbox`,
  calls: () => `/app/w/${ws}/calls`,
});

export const money = (cents: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);

/** A due time as people say it, in the business's time zone. */
export const when = (iso: string | null, timezone: string): string =>
  iso
    ? plainSpaces(
        new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(iso)),
      )
    : 'No due date';

/** Anything a customer wrote, marked so the model reads it as their words and nothing more. */
export const quoted = (text: string | null | undefined) => (text ? { customer_wrote: text } : null);

export const query = <T>(
  db: Db,
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown> = {},
) =>
  personQuery<T>(
    db,
    name,
    { workspaceId: ctx.workspaceId, ...input },
    ctx.actor,
    ctx.correlationId,
  );

/**
 * Runs a command as the person, through the same kernel as a click, marked as done through the Assistant. A
 * `reason` the person gave (why these customers get this tag) is kept on the audit row.
 */
export async function command<T>(
  db: Db,
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
  reason?: string | null,
): Promise<T> {
  const def = registry.command(name);
  if (!def) throw new Error(`Unknown command ${name}`);
  const done = await executeCommand(
    db,
    def,
    { workspaceId: ctx.workspaceId, ...input },
    ctx.actor,
    {
      correlationId: ctx.correlationId,
      channel: 'assistant',
      ...(reason?.trim() ? { reason: reason.trim().slice(0, 1000) } : {}),
    },
  );
  return done.output as T;
}

type Ref = { id: string; fullName: string } | null;
interface PersonItem {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: { line1?: string | null; city?: string | null } | null;
  company: { id: string; name: string } | null;
  openLeads: number;
  notes?: string | null;
  tags?: { id: string; name: string }[];
  otherEmails?: { email: string; label: string | null }[];
  otherPhones?: { phone: string; label: string | null }[];
  source?: string | null;
  custom?: Record<string, unknown>;
}
interface LeadItem {
  id: string;
  title: string;
  stageId: string;
  stageName: string;
  stageKind: string;
  status: string;
  person: { id: string; fullName: string } | null;
  company: { id: string; name: string } | null;
  valueCents: number;
  assignee: Ref;
  nextAction: string | null;
  nextActionAt: string | null;
  needsNextAction: boolean;
  createdAt: string;
}
interface TaskItem {
  id: string;
  title: string;
  dueAt: string | null;
  dueBucket: 'overdue' | 'today' | 'week' | 'later' | 'none';
  assignee: Ref;
  person: { id: string; fullName: string } | null;
}
interface ConversationItem {
  id: string;
  channel: 'sms' | 'email';
  counterpartDisplay: string;
  status: string;
  person: { id: string; fullName: string } | null;
  assignee: Ref;
  lastPreview: string | null;
  lastDirection: 'inbound' | 'outbound' | null;
  awaitingReplySince: string | null;
}

const customerOf = (l: LeadItem) => l.person?.fullName ?? l.company?.name ?? 'No customer';
const detailOf = (p: PersonItem) =>
  [p.phone, p.address?.line1 ?? p.address?.city].filter(Boolean).join(' · ') ||
  p.email ||
  'No phone or email on file';
const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));

async function customerCard(db: Db, ctx: ToolContext, p: PersonItem): Promise<AssistantCard> {
  const [leads, convs] = await Promise.all([
    query<{ items: LeadItem[] }>(db, ctx, 'lead.list', {
      personId: p.id,
      status: 'open',
      limit: 1,
    }),
    query<{ items: ConversationItem[] }>(db, ctx, 'inbox.list', { personId: p.id, limit: 5 }).catch(
      () => ({ items: [] }),
    ),
  ]);
  const lead = leads.items[0];
  const waiting =
    convs.items
      .map((c) => c.awaitingReplySince)
      .filter((w): w is string => !!w)
      .sort()[0] ?? null;
  return {
    type: 'customer',
    personId: p.id,
    fullName: p.fullName,
    detail: detailOf(p),
    href: paths(ctx.workspaceId).person(p.id),
    lead: lead
      ? { title: lead.title, stageName: lead.stageName, valueCents: lead.valueCents }
      : null,
    waitingSince: waiting,
  };
}

const leadResult = (l: LeadItem) => ({
  id: l.id,
  title: l.title,
  customer: customerOf(l),
  personId: l.person?.id ?? null,
  stage: l.stageName,
  status: l.status,
  value: money(l.valueCents),
  assignee: l.assignee?.fullName ?? null,
  nextAction: l.nextAction,
  needsNextAction: l.needsNextAction,
  createdAt: l.createdAt,
});

export type ReadTool = (
  db: Db,
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolOutcome>;

export const readTools: Record<string, ReadTool> = {
  async search_customers(db, ctx, args) {
    const [people, companies] = await Promise.all([
      query<{ items: PersonItem[] }>(db, ctx, 'person.list', { q: args['query'], limit: 5 }),
      query<{ items: { id: string; name: string; phone: string | null }[] }>(
        db,
        ctx,
        'company.list',
        {
          q: args['query'],
          limit: 3,
        },
      ),
    ]);
    const result = {
      people: people.items.map((p) => ({
        id: p.id,
        name: p.fullName,
        phone: p.phone,
        email: p.email,
        company: p.company?.name ?? null,
        openLeads: p.openLeads,
      })),
      companies: companies.items.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
    };
    const only =
      people.items.length === 1 && companies.items.length === 0 ? people.items[0] : undefined;
    if (only) return { result, card: await customerCard(db, ctx, only) };
    const hits = people.items.length + companies.items.length;
    if (hits < 2) return { result };
    const p = paths(ctx.workspaceId);
    return {
      result,
      card: {
        type: 'choices',
        title: `${hits} customers match “${String(args['query'])}”`,
        items: [
          ...people.items.map((x) => ({
            id: x.id,
            label: x.fullName,
            detail: detailOf(x),
            href: p.person(x.id),
          })),
          ...companies.items.map((c) => ({
            id: c.id,
            label: c.name,
            detail: c.phone ?? 'Company',
            href: p.company(c.id),
          })),
        ].slice(0, 8),
      },
    };
  },

  async get_customer(db, ctx, args) {
    const personId = String(args['personId']);
    const { person } = await query<{ person: PersonItem }>(db, ctx, 'person.get', { personId });
    const [leads, tasks, convs, upcoming] = await Promise.all([
      query<{ items: LeadItem[] }>(db, ctx, 'lead.list', { personId, status: 'open', limit: 5 }),
      query<{ items: TaskItem[] }>(db, ctx, 'task.list', {
        scope: 'all',
        status: 'open',
        personId,
        limit: 10,
      }),
      query<{ items: ConversationItem[] }>(db, ctx, 'inbox.list', { personId, limit: 5 }).catch(
        () => ({ items: [] }),
      ),
      upcomingFor(db, ctx, personId),
    ]);
    const next = upcoming.items[0];
    // The business's own fields, by id and name, so update_customer can change them (0107).
    const custom = person.custom ?? {};
    const fields = Object.keys(custom).length
      ? (
          await query<{ fields: { id: string; label: string }[] }>(db, ctx, 'custom_field.list', {
            entity: 'person',
          }).catch(() => ({ fields: [] as { id: string; label: string }[] }))
        ).fields
          .filter((f) => custom[f.id] !== undefined)
          .map((f) => ({ id: f.id, name: f.label, value: custom[f.id] }))
      : [];
    return {
      result: {
        person: {
          id: person.id,
          name: person.fullName,
          phone: person.phone,
          email: person.email,
          address: person.address,
          otherPhones: person.otherPhones ?? [],
          otherEmails: person.otherEmails ?? [],
          company: person.company?.name ?? null,
          source: person.source ?? null,
          tags: (person.tags ?? []).map((t) => ({ id: t.id, name: t.name })),
          fields,
          notes: person.notes ?? null,
        },
        openLeads: leads.items.map(leadResult),
        openTasks: tasks.items.map((t) => ({
          id: t.id,
          title: t.title,
          due: when(t.dueAt, ctx.timezone),
          assignee: t.assignee?.fullName ?? null,
        })),
        upcomingAppointments: upcoming.results,
        conversations: convs.items.map((c) => ({
          id: c.id,
          channel: c.channel,
          status: c.status,
          lastMessage: c.lastDirection === 'inbound' ? quoted(c.lastPreview) : c.lastPreview,
          waitingSince: c.awaitingReplySince,
        })),
      },
      card: await customerCard(db, ctx, person),
      cards: next ? [appointmentCard(ctx, next, ctx.timezone)] : [],
    };
  },

  async list_leads(db, ctx, args) {
    const { items } = await query<{ items: LeadItem[] }>(db, ctx, 'lead.list', {
      status: args['status'],
      createdAfter: args['createdAfter'],
      assigneeUserId: args['assigneeUserId'],
      personId: args['personId'],
      withoutNextAction: args['withoutNextAction'],
      limit: args['limit'] ?? 10,
    });
    const p = paths(ctx.workspaceId);
    return {
      result: { count: items.length, leads: items.map(leadResult) },
      card: items.length
        ? {
            type: 'list',
            title: items.length === 1 ? '1 lead' : `${items.length} leads`,
            items: items.slice(0, 12).map((l) => ({
              title: `${l.title} · ${customerOf(l)}`,
              detail: `${l.stageName} · ${money(l.valueCents)}${l.needsNextAction ? ' · no next action' : ''}`,
              tone: l.needsNextAction ? 'warning' : 'accent',
              href: p.lead(l.id),
            })),
          }
        : null,
    };
  },

  async get_lead(db, ctx, args) {
    const { lead, stages } = await query<{
      lead: LeadItem;
      stages: { id: string; name: string; kind: string }[];
    }>(db, ctx, 'lead.get', { leadId: args['leadId'] });
    return {
      result: {
        lead: leadResult(lead),
        stages: stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      },
      card: {
        type: 'lead',
        leadId: lead.id,
        title: lead.title,
        customer: customerOf(lead),
        stageName: lead.stageName,
        valueCents: lead.valueCents,
        assignee: lead.assignee?.fullName ?? null,
        nextAction: lead.nextAction,
        needsNextAction: lead.needsNextAction,
        href: paths(ctx.workspaceId).lead(lead.id),
      },
    };
  },

  async business_numbers(db, ctx, args) {
    const m = await query<{
      leadsCreated: number;
      leadsWon: number;
      leadsLost: number;
      wonValueCents: number;
      newPeople: number;
      textsIn: number;
      textsOut: number;
      emailsIn: number;
      emailsOut: number;
      callsIn: number;
      callsOut: number;
      callsMissed: number;
    }>(db, ctx, 'crm.metrics', { since: args['since'], until: args['until'] });
    return {
      result: {
        since: args['since'],
        until: args['until'] ?? 'now',
        ...m,
        wonValue: money(m.wonValueCents),
      },
      card: {
        type: 'numbers',
        label: 'New leads',
        value: String(m.leadsCreated),
        delta: null,
        stats: [
          { value: `${m.leadsWon} won`, label: money(m.wonValueCents) },
          { value: String(m.textsIn + m.emailsIn), label: 'Messages in' },
          { value: String(m.callsMissed), label: 'Missed calls' },
        ],
        href: paths(ctx.workspaceId).pipeline(),
      },
    };
  },

  // what_needs_attention reads the Action Center: tools-attention.ts.

  async list_tasks(db, ctx, args) {
    const { items } = await query<{ items: TaskItem[] }>(db, ctx, 'task.list', {
      scope: args['scope'] ?? 'mine',
      status: 'open',
      assigneeUserId: args['assigneeUserId'],
      limit: 60,
    });
    const due = args['due'] ?? 'any';
    const picked = items.filter((t) =>
      due === 'any'
        ? true
        : due === 'week'
          ? ['overdue', 'today', 'week'].includes(t.dueBucket)
          : t.dueBucket === due,
    );
    return {
      result: {
        tasks: picked.map((t) => ({
          id: t.id,
          title: t.title,
          due: when(t.dueAt, ctx.timezone),
          dueBucket: t.dueBucket,
          assignee: t.assignee?.fullName ?? null,
          customer: t.person?.fullName ?? null,
        })),
      },
      card: picked.length
        ? {
            type: 'list',
            title: picked.length === 1 ? '1 task' : `${picked.length} tasks`,
            items: picked.slice(0, 12).map((t) => ({
              title: t.title,
              detail: `${when(t.dueAt, ctx.timezone)} · ${t.assignee?.fullName ?? 'Nobody'}`,
              tone:
                t.dueBucket === 'overdue' ? 'danger' : t.dueBucket === 'today' ? 'accent' : 'muted',
              href: paths(ctx.workspaceId).tasks(),
            })),
          }
        : null,
    };
  },

  async todays_schedule(db, ctx) {
    const [appointments, { items }] = await Promise.all([
      todaysAppointments(db, ctx),
      query<{ items: TaskItem[] }>(db, ctx, 'task.list', {
        scope: 'mine',
        status: 'open',
        limit: 60,
      }),
    ]);
    const due = items.filter((t) => t.dueBucket === 'overdue' || t.dueBucket === 'today');
    return {
      result: {
        ...appointments.result,
        tasksDueToday: due.map((t) => ({
          title: t.title,
          due: when(t.dueAt, ctx.timezone),
          overdue: t.dueBucket === 'overdue',
        })),
      },
      card: appointments.card,
      cards: due.length
        ? [
            {
              type: 'list',
              title: 'Due today',
              items: due.slice(0, 12).map((t) => ({
                title: t.title,
                detail:
                  t.dueBucket === 'overdue'
                    ? `Overdue · ${t.assignee?.fullName ?? 'You'}`
                    : when(t.dueAt, ctx.timezone),
                tone: t.dueBucket === 'overdue' ? 'danger' : 'accent',
                href: paths(ctx.workspaceId).tasks(),
              })),
            },
          ]
        : [],
    };
  },

  async get_conversation(db, ctx, args) {
    let conversationId = args['conversationId'] as string | undefined;
    if (!conversationId && args['personId']) {
      const { items } = await query<{ items: ConversationItem[] }>(db, ctx, 'inbox.list', {
        personId: args['personId'],
        channel: args['channel'] ?? 'sms',
        limit: 1,
      });
      conversationId = items[0]?.id;
    }
    if (!conversationId)
      return {
        result: { messages: [], note: 'There is no conversation with them on that channel yet.' },
      };
    const [{ conversation }, thread] = await Promise.all([
      query<{ conversation: ConversationItem }>(db, ctx, 'conversation.get', { conversationId }),
      query<{
        items: {
          type: 'message' | 'call';
          occurredAt: string;
          direction: 'inbound' | 'outbound';
          status: string;
          body: string | null;
          subject: string | null;
          sentBy: Ref;
          durationSeconds: number | null;
          isVoicemail: boolean;
          transcript: string | null;
        }[];
      }>(db, ctx, 'conversation.thread', { conversationId, limit: 20 }),
    ]);
    return {
      result: {
        conversationId,
        with: conversation.person?.fullName ?? conversation.counterpartDisplay,
        channel: conversation.channel,
        status: conversation.status,
        assignee: conversation.assignee?.fullName ?? null,
        waitingSince: conversation.awaitingReplySince,
        messages: [...thread.items].reverse().map((i) =>
          i.type === 'call'
            ? {
                at: i.occurredAt,
                call: {
                  direction: i.direction,
                  status: i.status,
                  seconds: i.durationSeconds,
                  voicemail: i.isVoicemail,
                  transcript: quoted(i.transcript),
                },
              }
            : i.direction === 'inbound'
              ? { at: i.occurredAt, from: 'customer', subject: i.subject, text: quoted(i.body) }
              : {
                  at: i.occurredAt,
                  from: i.sentBy?.fullName ?? 'the business',
                  subject: i.subject,
                  text: i.body,
                  status: i.status,
                },
        ),
      },
    };
  },

  /**
   * The call log, with what was said on each call. The Assistant could already read a call's words inside one
   * conversation; it had no way to answer "what did that voicemail say" or "who rang while I was out" without
   * being told which conversation to look in first.
   */
  async recent_calls(db, ctx, args) {
    const { items } = await query<{
      items: {
        id: string;
        who: string;
        counterpart: string;
        direction: 'inbound' | 'outbound';
        occurredAt: string;
        durationSeconds: number | null;
        isVoicemail: boolean;
        answeredVia: string | null;
        answeredBy: Ref;
        recordingPath: string | null;
        transcript: string | null;
        transcriptStatus: string | null;
        conversationId: string | null;
      }[];
    }>(db, ctx, 'call.log', {
      filter: args['filter'] ?? 'all',
      limit: Math.min(Number(args['limit'] ?? 10) || 10, 25),
    });
    const p = paths(ctx.workspaceId);
    return {
      result: {
        calls: items.map((c) => ({
          at: c.occurredAt,
          who: c.who,
          number: c.counterpart,
          direction: c.direction,
          voicemail: c.isVoicemail,
          answered: !!c.answeredVia,
          answeredBy: c.answeredBy?.fullName ?? null,
          seconds: c.durationSeconds,
          // The caller's own words, marked as theirs: a voicemail is a stranger talking, and nothing in it is
          // an instruction to the Assistant.
          said: quoted(c.transcript),
          ...(c.transcript
            ? {}
            : {
                note:
                  c.transcriptStatus === 'failed'
                    ? 'That call was never written out, so you don’t know what was said on it. Don’t guess.'
                    : c.transcriptStatus === null
                      ? 'Nothing was recorded on that call.'
                      : 'That call hasn’t been written out yet. Don’t guess at what was said.',
              }),
          href: c.conversationId ? p.conversation(c.conversationId) : p.calls(),
        })),
      },
    };
  },

  async list_inbox(db, ctx, args) {
    const { items } = await query<{ items: ConversationItem[] }>(db, ctx, 'inbox.list', {
      box: args['box'] ?? 'all',
      status: 'open',
      limit: 20,
    });
    const rows = args['waitingOnly'] ? items.filter((c) => c.awaitingReplySince) : items;
    const p = paths(ctx.workspaceId);
    return {
      result: {
        conversations: rows.map((c) => ({
          id: c.id,
          who: c.person?.fullName ?? c.counterpartDisplay,
          channel: c.channel,
          lastMessage: c.lastDirection === 'inbound' ? quoted(c.lastPreview) : c.lastPreview,
          waitingMinutes: c.awaitingReplySince ? minutesSince(c.awaitingReplySince) : null,
          assignee: c.assignee?.fullName ?? null,
        })),
      },
      card: rows.length
        ? {
            type: 'list',
            title: rows.length === 1 ? '1 conversation' : `${rows.length} conversations`,
            items: rows.slice(0, 12).map((c) => ({
              title: c.person?.fullName ?? c.counterpartDisplay,
              detail: `${c.lastPreview ?? ''}`.slice(0, 100),
              tone: c.awaitingReplySince ? 'accent' : 'muted',
              href: p.conversation(c.id),
            })),
          }
        : null,
    };
  },

  async list_team(db, ctx) {
    const team = await query<{
      members: { userId: string; fullName: string; email: string; role: string }[];
      organizationAdmins: { userId: string; fullName: string; email: string; orgRole: string }[];
    }>(db, ctx, 'workspace.members');
    return {
      result: {
        team: [
          ...team.members.map((m) => ({
            userId: m.userId,
            name: m.fullName || m.email,
            role: m.role,
          })),
          ...team.organizationAdmins.map((a) => ({
            userId: a.userId,
            name: a.fullName || a.email,
            role: `organization ${a.orgRole}`,
          })),
        ],
      },
    };
  },

  async call_customer(db, ctx, args) {
    const { person } = await query<{ person: PersonItem }>(db, ctx, 'person.get', {
      personId: args['personId'],
    });
    if (!person.phone)
      return { result: { error: 'There is no phone number on file for them.' }, isError: true };
    return {
      result: { phone: person.phone, note: 'A Call button is shown; the person places the call.' },
      card: { type: 'call', personId: person.id, fullName: person.fullName, phone: person.phone },
    };
  },

  ...calendarReadTools,
};

export { executeCommand };
