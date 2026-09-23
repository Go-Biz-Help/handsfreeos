import {
  assistantTools,
  ATTENTION_KIND_LABELS,
  briefFromProfile,
  executeQuery,
  groundingRules,
  holds,
  quoteData,
  registry,
  ROLE_LABELS,
  type AssistantTool,
  type AttentionKind,
  type HumanActor,
  type Permission,
} from '@hfos/core/server';
import { asWorker, type Db } from '@hfos/db/client';
import { loadGrounding } from '../knowledge/grounding';
import type { TenantScope } from '../services';
import { approvalPreview, approvalWhat } from './approval-words';
import { atLabel, joinAnd, rangeLabel } from './calendar-format';
import type { PromptContext } from './prompt';

export interface PageRecord {
  readonly type:
    'person' | 'company' | 'lead' | 'conversation' | 'appointment' | 'workflow' | 'workflow_run';
  readonly id: string;
}

export interface QuestionContext {
  readonly prompt: PromptContext;
  /** The tools this person's role allows (the commands check again when they run). */
  readonly tools: readonly AssistantTool[];
  readonly organizationId: string;
  readonly timezone: string;
}

/** The tools a person is offered: only the ones their permissions allow, so the model never sees the rest. */
export const toolsFor = (can: (permission: Permission) => boolean): AssistantTool[] =>
  assistantTools.filter((t) => can(t.permission));

/** Runs one of the person's own queries, exactly as the web app would. */
export async function personQuery<T>(
  db: Db,
  name: string,
  input: Record<string, unknown>,
  actor: HumanActor,
  correlationId: string,
): Promise<T> {
  const query = registry.query(name);
  if (!query) throw new Error(`Unknown query ${name}`);
  return (await executeQuery(db, query, input, actor, {
    correlationId,
    channel: 'assistant',
  })) as T;
}

interface WorkspaceGet {
  workspace: {
    name: string;
    timezone: string;
    organizationId: string;
    role: 'owner' | 'admin' | 'member';
    /** What the business lets them do (0105): what the tools follow. */
    permissions: string[];
  };
}
interface PipelineList {
  pipelines: {
    name: string;
    archivedAt: string | null;
    stages: { id: string; name: string; kind: string }[];
  }[];
}
interface Members {
  members: { userId: string; fullName: string; email: string; role: string }[];
  organizationAdmins: { userId: string; fullName: string; email: string; orgRole: string }[];
}
interface CalendarList {
  items: { id: string; name: string; status: string; memberIds: string[] }[];
}
interface CalendarGet {
  calendar: {
    config: { team: { assignment: string }; services: { items: { serviceId: string }[] } };
  };
}
interface ServiceList {
  items: { id: string; name: string; durations: number[]; archivedAt: string | null }[];
}
interface AppointmentLite {
  id: string;
  title: string;
  service: { name: string } | null;
  startsAt: string;
  endsAt: string;
  staff: { fullName: string }[];
  attendees: { fullName: string; status: string }[];
}

type Ask = <T>(name: string, input?: Record<string, unknown>) => Promise<T>;

interface WorkflowList {
  items: { id: string; name: string; status: string; trigger: { summary: string } }[];
}
interface ApprovalList {
  items: {
    id: string;
    workflow: { name: string };
    person: { fullName: string } | null;
    preview: Record<string, unknown>;
    canDecide: boolean;
  }[];
}
interface AttentionList {
  scope: 'mine' | 'everyone';
  counts: { total: number };
  items: {
    id: string;
    kind: AttentionKind;
    title: string;
    urgent: boolean;
    reasons: { text: string }[];
  }[];
}

/** The Action Center's top items as Home shows them to this person, with their ids. */
const attentionFor = (list: AttentionList | null): PromptContext['attention'] =>
  list && {
    scope: list.scope,
    total: list.counts.total,
    items: list.items.slice(0, 8).map((i) => ({
      id: i.id,
      title: i.title,
      kind: ATTENTION_KIND_LABELS[i.kind],
      urgent: i.urgent,
      chips: i.reasons.slice(0, 3).map((r) => r.text),
    })),
  };

/** The name of the record on screen, or null when it can't be read (gone, or not this person's to see). */
async function pageLabel(
  ask: Ask,
  page: PageRecord & { readonly type: Exclude<PageRecord['type'], 'workflow_run'> },
  timezone: string,
): Promise<string | null> {
  try {
    switch (page.type) {
      case 'workflow':
        return (await ask<{ workflow: { name: string } }>('workflow.get', { workflowId: page.id }))
          .workflow.name;
      case 'person':
        return (await ask<{ person: { fullName: string } }>('person.get', { personId: page.id }))
          .person.fullName;
      case 'company':
        return (await ask<{ company: { name: string } }>('company.get', { companyId: page.id }))
          .company.name;
      case 'lead': {
        const { lead } = await ask<{
          lead: { title: string; person: { fullName: string } | null };
        }>('lead.get', {
          leadId: page.id,
        });
        return lead.person ? `${lead.title} (${lead.person.fullName})` : lead.title;
      }
      case 'conversation': {
        const { conversation } = await ask<{
          conversation: {
            channel: string;
            counterpartDisplay: string;
            person: { fullName: string } | null;
          };
        }>('conversation.get', { conversationId: page.id });
        const who = conversation.person?.fullName ?? conversation.counterpartDisplay;
        return `${conversation.channel === 'email' ? 'Email' : 'Texts'} with ${who}`;
      }
      case 'appointment': {
        const { appointment: a } = await ask<{ appointment: AppointmentLite }>('appointment.get', {
          appointmentId: page.id,
        });
        const who = a.attendees.filter((p) => p.status !== 'cancelled').map((p) => p.fullName);
        const when = rangeLabel(Date.parse(a.startsAt), Date.parse(a.endsAt), timezone);
        return `${a.service?.name ?? a.title}${who.length ? ` with ${joinAnd(who)}` : ''}, ${when}`;
      }
    }
  } catch {
    return null;
  }
}

/** The record on screen: its name, and for a run, the workflow and customer it belongs to. */
async function pageDetails(
  ask: Ask,
  page: PageRecord,
  timezone: string,
): Promise<{ label: string; related: string | null } | null> {
  if (page.type !== 'workflow_run') {
    const label = await pageLabel(ask, { ...page, type: page.type }, timezone);
    return label ? { label, related: null } : null;
  }
  try {
    const { run } = await ask<{
      run: {
        workflow: { id: string; name: string };
        person: { id: string; fullName: string } | null;
      };
    }>('workflow.run_get', { runId: page.id });
    const who = run.person;
    return {
      label: `a run of ${run.workflow.name}${who ? ` for ${who.fullName}` : ''}`,
      related: `It belongs to ${run.workflow.name} (workflow id ${run.workflow.id})${who ? ` and is for ${who.fullName} (person id ${who.id})` : ''}. "It" usually means this workflow, and "him", "her" or "them" its customer.`,
    };
  } catch {
    return null;
  }
}

/** The business profile's brief and the grounding rules: what the Assistant may say about the business. */
async function knowledgeFor(db: Db, scope: TenantScope): Promise<PromptContext['knowledge']> {
  const g = await asWorker(db, scope, (tx) => loadGrounding(tx, scope.workspaceId));
  return {
    brief: quoteData(briefFromProfile(g.profile, g.business)),
    rules: groundingRules(g.profile, g.business),
  };
}

/** A customer's next appointment, so "move his appointment" has one to mean. */
async function nextAppointment(
  ask: Ask,
  personId: string,
  timezone: string,
): Promise<{ id: string; label: string } | null> {
  const now = Date.now();
  const { items } = await ask<{ items: AppointmentLite[] }>('appointment.list', {
    personId,
    from: new Date(now).toISOString(),
    to: new Date(now + 60 * 86_400_000).toISOString(),
    status: ['scheduled'],
  }).catch(() => ({ items: [] as AppointmentLite[] }));
  const a = items.find((x) => Date.parse(x.endsAt) > now);
  if (!a) return null;
  const staff = a.staff.map((s) => s.fullName);
  return {
    id: a.id,
    label: `${a.service?.name ?? a.title} on ${atLabel(Date.parse(a.startsAt), timezone)}${staff.length ? ` with ${joinAnd(staff)}` : ''}`,
  };
}

/** The calendars the Assistant can look up and book on, with their services and people. */
async function calendarsFor(
  ask: Ask,
  names: ReadonlyMap<string, string>,
  services: ServiceList['items'],
): Promise<PromptContext['calendars']> {
  const { items } = await ask<CalendarList>('calendar.list').catch((): CalendarList => ({
    items: [],
  }));
  const list = items.slice(0, 8);
  const details = await Promise.all(
    list.map((c) => ask<CalendarGet>('calendar.get', { calendarId: c.id }).catch((): null => null)),
  );
  return list.map((c, i) => {
    const config = details[i]?.calendar.config;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      assignment: config?.team.assignment ?? 'fixed',
      services: (config?.services.items ?? []).flatMap((item) => {
        const s = services.find((x) => x.id === item.serviceId);
        return s ? [{ id: s.id, name: s.name }] : [];
      }),
      people: c.memberIds.map((u) => names.get(u) ?? 'Someone'),
    };
  });
}

/** Everything the model is told about the business, the person and the page, read as that person. */
export async function questionContext(
  db: Db,
  actor: HumanActor,
  workspaceId: string,
  page: PageRecord | null,
  correlationId: string,
  now: Date = new Date(),
): Promise<QuestionContext> {
  const ask: Ask = (name, input = {}) =>
    personQuery(db, name, { workspaceId, ...input }, actor, correlationId);
  const [{ workspace }, { pipelines }, team, services] = await Promise.all([
    ask<WorkspaceGet>('workspace.get'),
    ask<PipelineList>('pipeline.list'),
    ask<Members>('workspace.members'),
    ask<ServiceList>('service.list').catch((): ServiceList => ({ items: [] })),
  ]);
  const me =
    team.members.find((m) => m.userId === actor.userId) ??
    team.organizationAdmins.find((m) => m.userId === actor.userId);
  const people = [
    ...team.members.map((m) => ({
      userId: m.userId,
      fullName: m.fullName || m.email,
      role: m.role,
    })),
    ...team.organizationAdmins
      .filter((a) => !team.members.some((m) => m.userId === a.userId))
      .map((a) => ({
        userId: a.userId,
        fullName: a.fullName || a.email,
        role: `organization ${a.orgRole}`,
      })),
  ];
  const live = services.items.filter((s) => !s.archivedAt);
  const scope = { workspaceId, organizationId: workspace.organizationId };
  const [calendars, shown, next, flows, approvals, knowledge, attention] = await Promise.all([
    calendarsFor(ask, new Map(people.map((p) => [p.userId, p.fullName])), live),
    page ? pageDetails(ask, page, workspace.timezone) : Promise.resolve(null),
    page?.type === 'person'
      ? nextAppointment(ask, page.id, workspace.timezone)
      : Promise.resolve(null),
    ask<WorkflowList>('workflow.list').catch((): WorkflowList => ({ items: [] })),
    ask<ApprovalList>('workflow.approval_list', { status: 'pending', limit: 10 }).catch(
      (): ApprovalList => ({ items: [] }),
    ),
    knowledgeFor(db, scope).catch(() => null),
    ask<AttentionList>('attention.list').catch((): null => null),
  ]);
  return {
    organizationId: workspace.organizationId,
    timezone: workspace.timezone,
    tools: toolsFor((p) => holds(workspace, p)),
    prompt: {
      businessName: workspace.name,
      personName: me?.fullName || actor.email,
      role: ROLE_LABELS[workspace.role],
      timezone: workspace.timezone,
      now,
      pipelines: pipelines
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          name: p.name,
          stages: p.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
        })),
      team: people,
      calendars,
      services: live.map((s) => ({ id: s.id, name: s.name, minutes: s.durations })),
      page:
        page && shown
          ? { type: page.type, id: page.id, label: shown.label, next, related: shown.related }
          : null,
      workflows: flows.items
        .filter((w) => w.status !== 'archived')
        .slice(0, 25)
        .map((w) => ({ id: w.id, name: w.name, status: w.status, trigger: w.trigger.summary })),
      approvals: approvals.items
        .filter((a) => a.canDecide)
        .map((a) => ({
          id: a.id,
          workflow: a.workflow.name,
          customer: a.person?.fullName ?? approvalPreview(a.preview).customer,
          what: approvalWhat(a.preview),
        })),
      knowledge,
      attention: attentionFor(attention),
    },
  };
}
