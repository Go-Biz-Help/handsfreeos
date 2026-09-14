import { HfosError, type AssistantCard, type AssistantTool } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type {
  CommittedAction,
  PreparedAction,
  ToolContext,
  ToolExecutor,
  ToolOutcome,
} from './runtime';
import { calendarConfirmTools } from './tools-calendar';
import { command, money, paths, query, readTools, when } from './tools-read';
import { workflowAutoTools, workflowConfirmTools, type WorkflowToolDeps } from './tools-workflow';

/** The same choices as the pipeline's lost-reason dialog (apps/web/src/components/pipeline/lost-reason-dialog.tsx). */
export const LOST_REASONS = [
  'Went with another bidder',
  'Decided not to do the work',
  'No response',
];

/** The runtime puts the tool call's id on a "done" card; this stands in until then. */
const PENDING_ID = '00000000-0000-0000-0000-000000000000';

type Args = Record<string, unknown>;
type Warning = { kind: string; text: string };
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const firstName = (full: string) => full.split(' ')[0] || full;
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function confirmCard(
  toolCallId: string,
  tool: string,
  card: Omit<ConfirmCard, 'type' | 'toolCallId' | 'tool' | 'personId' | 'conversationId'> &
    Partial<Pick<ConfirmCard, 'personId' | 'conversationId'>>,
): ConfirmCard {
  return { type: 'confirm', toolCallId, tool, personId: null, conversationId: null, ...card };
}

interface Members {
  members: { userId: string; fullName: string; email: string }[];
  organizationAdmins: { userId: string; fullName: string; email: string }[];
}
async function teammate(db: Db, ctx: ToolContext, userId: unknown): Promise<string | null> {
  if (typeof userId !== 'string') return null;
  const team = await query<Members>(db, ctx, 'workspace.members');
  const m = [...team.members, ...team.organizationAdmins].find((x) => x.userId === userId);
  return m ? m.fullName || m.email : null;
}

// ---------- tasks and notes: done at once, with Undo ----------

const FIELD_WORDS: Record<string, string> = {
  title: 'title',
  dueAt: 'due time',
  allDay: 'due time',
  assigneeUserId: 'assignee',
};

const autoWrites: Record<string, (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>> = {
  async create_task(db, ctx, args) {
    const { taskId } = await command<{ taskId: string }>(db, ctx, 'task.create', {
      title: args['title'],
      notes: str(args['notes']) ?? null,
      dueAt: args['dueAt'] ?? null,
      allDay: args['allDay'] ?? false,
      // A task nobody was named for is the asker's own, as when they add one themselves.
      assigneeUserId: args['assigneeUserId'] ?? ctx.actor.userId,
      personId: args['personId'] ?? null,
      leadId: args['leadId'] ?? null,
    });
    const assignee = args['assigneeUserId'] ?? ctx.actor.userId;
    const who =
      assignee === ctx.actor.userId ? 'You' : ((await teammate(db, ctx, assignee)) ?? 'A teammate');
    const due = args['dueAt'] ? when(String(args['dueAt']), ctx.timezone) : 'No due date';
    const href = paths(ctx.workspaceId).tasks();
    const title = String(args['title']);
    return {
      result: { taskId, added: true, assignee: who, due },
      command: 'task.create',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'task',
        title,
        detail: `${who} · ${due}`,
        href,
        undoable: true,
      },
      record: { taskId, outcome: `Added “${title}”`, href },
    };
  },

  async update_task(db, ctx, args) {
    const { updated } = await command<{ taskId: string; updated: string[] }>(
      db,
      ctx,
      'task.update',
      defined({
        taskId: args['taskId'],
        title: args['title'],
        dueAt: args['dueAt'],
        assigneeUserId: args['assigneeUserId'],
      }),
    );
    const changed = [...new Set(updated.map((f) => FIELD_WORDS[f] ?? f))];
    const href = paths(ctx.workspaceId).tasks();
    return {
      result: { taskId: args['taskId'], changed },
      command: 'task.update',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'task',
        title: str(args['title']) ?? 'Task changed',
        detail: changed.length ? `Changed the ${changed.join(' and ')}` : 'Nothing needed changing',
        href,
        undoable: false,
      },
      record: { taskId: args['taskId'], outcome: 'Changed the task', href, undo: false },
    };
  },

  async complete_task(db, ctx, args) {
    await command(db, ctx, 'task.complete', { taskId: args['taskId'] });
    const href = paths(ctx.workspaceId).tasks();
    return {
      result: { taskId: args['taskId'], done: true },
      command: 'task.complete',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'task',
        title: 'Task done',
        detail: 'Marked complete',
        href,
        undoable: true,
      },
      record: { taskId: args['taskId'], outcome: 'Marked the task done', href },
    };
  },

  async add_note(db, ctx, args) {
    const p = paths(ctx.workspaceId);
    const target = defined({
      personId: args['personId'],
      leadId: args['leadId'],
      companyId: args['companyId'],
    });
    const { activityId } = await command<{ activityId: string }>(db, ctx, 'activity.log', {
      kind: 'note',
      body: args['body'],
      ...target,
    });
    let name = 'the record';
    let href: string | null = null;
    if (typeof args['personId'] === 'string') {
      const { person } = await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
        personId: args['personId'],
      });
      name = person.fullName;
      href = p.person(args['personId']);
    } else if (typeof args['leadId'] === 'string') {
      name = 'the lead';
      href = p.lead(args['leadId']);
    } else if (typeof args['companyId'] === 'string') {
      name = 'the company';
      href = p.company(args['companyId']);
    }
    const body = String(args['body']);
    return {
      result: { activityId, added: true },
      command: 'activity.log',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'note',
        title: `Note on ${name}`,
        detail: `“${body.length > 120 ? `${body.slice(0, 117)}…` : body}”`,
        href,
        undoable: true,
      },
      record: { activityId, outcome: `Added a note on ${name}`, href },
    };
  },
};

// ---------- changes that wait for the person's OK ----------

interface ConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    extra: { lostReason?: string; toolCallId: string },
  ): Promise<CommittedAction>;
}

const clientId = (toolCallId: string) => `assistant-${toolCallId}`;

interface TextTarget {
  name: string;
  phone: string | null;
  personId: string | null;
  conversationId: string | null;
  blocked: string | null;
  fromNumber: string | null;
  quiet: { quiet: boolean; localTime: string } | null;
}

async function textTarget(db: Db, ctx: ToolContext, args: Args): Promise<TextTarget> {
  const personId = str(args['personId']) ?? null;
  let conversationId = str(args['conversationId']) ?? null;
  if (!conversationId && personId) {
    const { items } = await query<{ items: { id: string }[] }>(db, ctx, 'inbox.list', {
      personId,
      channel: 'sms',
      limit: 1,
    });
    conversationId = items[0]?.id ?? null;
  }
  if (conversationId) {
    const c = await query<{
      conversation: {
        channel: string;
        counterpartDisplay: string;
        person: { id: string; fullName: string } | null;
      };
      person: { phone: string | null } | null;
      canText: { ok: boolean; reason: string | null };
      fromNumber: string | null;
      quiet: { quiet: boolean; localTime: string };
    }>(db, ctx, 'conversation.get', { conversationId });
    return {
      name: c.conversation.person?.fullName ?? c.conversation.counterpartDisplay,
      phone: c.person?.phone ?? c.conversation.counterpartDisplay,
      personId: c.conversation.person?.id ?? personId,
      conversationId,
      blocked: c.canText.ok ? null : c.canText.reason,
      fromNumber: c.fromNumber,
      quiet: c.quiet,
    };
  }
  if (!personId) throw HfosError.validation([], 'Say who the text is for.');
  const { person } = await query<{ person: { fullName: string; phone: string | null } }>(
    db,
    ctx,
    'person.get',
    { personId },
  );
  const setup = await query<{
    number: { display: string } | null;
    messagingReady: boolean;
    quiet: { quiet: boolean; localTime: string };
  }>(db, ctx, 'phone.setup_status').catch(() => null);
  const blocked = !person.phone
    ? 'no_phone'
    : setup && !setup.number
      ? 'no_number'
      : setup && !setup.messagingReady
        ? 'not_ready'
        : null;
  return {
    name: person.fullName,
    phone: person.phone,
    personId,
    conversationId: null,
    blocked,
    fromNumber: setup?.number?.display ?? null,
    quiet: setup?.quiet ?? null,
  };
}

function cannotText(reason: string, first: string): string {
  switch (reason) {
    case 'opted_out':
      return `${first} replied STOP, so texts to them are off. You can still call or email.`;
    case 'no_phone':
      return `There’s no mobile number for ${first}.`;
    case 'no_number':
      return 'This business has no phone number yet, so texts can’t go out.';
    case 'not_ready':
      return 'The carriers haven’t approved texting for this business yet.';
    case 'email_channel':
      return 'That conversation is email. Send an email instead.';
    default:
      return 'Texts to them can’t go out right now.';
  }
}

const sendText: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const t = await textTarget(db, ctx, args);
    const first = firstName(t.name);
    const warnings: Warning[] = [];
    if (t.blocked) warnings.push({ kind: 'blocked', text: cannotText(t.blocked, first) });
    else if (t.quiet?.quiet)
      warnings.push({
        kind: 'quiet_hours',
        text: `It’s ${t.quiet.localTime} for the business, inside quiet hours. Sending now is up to you.`,
      });
    return {
      card: confirmCard(toolCallId, 'send_text', {
        personId: t.personId,
        conversationId: t.conversationId,
        title: `Send this text to ${first}?`,
        fields: [
          { label: 'To', value: [t.name, t.phone].filter(Boolean).join(' · ') },
          {
            label: 'From',
            value: t.fromNumber ? `Your business number · ${t.fromNumber}` : 'Your business number',
          },
        ],
        body: String(args['body']),
        stageFrom: null,
        stageTo: null,
        warnings,
        reasons: [],
        confirmLabel: t.blocked ? '' : t.quiet?.quiet ? 'Send anyway' : 'Send text',
        editable: !t.blocked,
      }),
      result: {
        to: t.name,
        ...(t.blocked ? { cannotSend: cannotText(t.blocked, first) } : {}),
        ...(t.quiet?.quiet ? { quietHours: true } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const t = await textTarget(db, ctx, args);
    const sent = await command<{ conversationId: string }>(db, ctx, 'message.send', {
      ...(t.conversationId ? { conversationId: t.conversationId } : { personId: t.personId }),
      channel: 'sms',
      body: args['body'],
      acknowledgeQuietHours: true,
      clientId: clientId(extra.toolCallId),
    });
    return {
      outcome: `Sent to ${t.name}`,
      href: paths(ctx.workspaceId).conversation(sent.conversationId),
      command: 'message.send',
    };
  },
};

interface ComposeOptions {
  to: string | null;
  conversationId: string | null;
  canEmail: { ok: boolean; reason: 'no_email' | 'suppressed' | null };
  suppressed: { reason: string } | null;
  addresses: { id: string; address: string; displayName: string; isDefault: boolean }[];
  fromAddressId: string | null;
}

async function emailTarget(db: Db, ctx: ToolContext, args: Args) {
  const conversationId = str(args['conversationId']);
  const personId = str(args['personId']);
  if (!conversationId && !personId) throw HfosError.validation([], 'Say who the email is for.');
  const opts = await query<ComposeOptions>(
    db,
    ctx,
    'email.compose_options',
    conversationId ? { conversationId } : { personId },
  );
  const from =
    opts.addresses.find((a) => a.id === opts.fromAddressId) ??
    opts.addresses.find((a) => a.isDefault) ??
    null;
  const name = personId
    ? (await query<{ person: { fullName: string } }>(db, ctx, 'person.get', { personId })).person
        .fullName
    : ((
        await query<{
          conversation: { counterpartDisplay: string; person: { fullName: string } | null };
        }>(db, ctx, 'conversation.get', {
          conversationId,
        })
      ).conversation.person?.fullName ??
      opts.to ??
      'them');
  return {
    opts,
    from,
    name,
    conversationId: conversationId ?? opts.conversationId ?? null,
    personId: personId ?? null,
  };
}

const sendEmail: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const e = await emailTarget(db, ctx, args);
    const first = firstName(e.name);
    const blocked = e.opts.canEmail.ok
      ? null
      : e.opts.canEmail.reason === 'no_email'
        ? `There’s no email address for ${first}.`
        : `Email to ${e.opts.to} is stopped after a bounce or a complaint.`;
    return {
      card: confirmCard(toolCallId, 'send_email', {
        personId: e.personId,
        conversationId: e.conversationId,
        title: `Email ${first}?`,
        fields: [
          { label: 'To', value: [e.name, e.opts.to].filter(Boolean).join(' · ') },
          { label: 'From', value: e.from ? e.from.address : 'Your business address' },
          { label: 'Subject', value: String(args['subject']) },
        ],
        body: String(args['body']),
        stageFrom: null,
        stageTo: null,
        warnings: blocked ? [{ kind: 'blocked', text: blocked }] : [],
        reasons: [],
        confirmLabel: blocked ? '' : 'Send email',
        editable: !blocked,
      }),
      result: { to: e.name, ...(blocked ? { cannotSend: blocked } : {}) },
    };
  },
  async commit(db, ctx, args, extra) {
    const e = await emailTarget(db, ctx, args);
    const sent = await command<{ conversationId: string }>(db, ctx, 'message.send', {
      ...(e.conversationId ? { conversationId: e.conversationId } : { personId: e.personId }),
      channel: 'email',
      subject: args['subject'],
      body: args['body'],
      clientId: clientId(extra.toolCallId),
    });
    return {
      outcome: `Emailed ${e.name}`,
      href: paths(ctx.workspaceId).conversation(sent.conversationId),
      command: 'message.send',
    };
  },
};

interface LeadLite {
  id: string;
  title: string;
  stageId: string;
  stageName: string;
  valueCents: number;
  person: { fullName: string } | null;
  company: { name: string } | null;
  assignee: { id: string; fullName: string } | null;
  nextAction: string | null;
}
const leadGet = (db: Db, ctx: ToolContext, leadId: unknown) =>
  query<{ lead: LeadLite; stages: { id: string; name: string; kind: string }[] }>(
    db,
    ctx,
    'lead.get',
    { leadId },
  );
const leadLine = (l: LeadLite) =>
  `${l.title} · ${l.person?.fullName ?? l.company?.name ?? 'No customer'} · ${money(l.valueCents)}`;

const moveLead: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { lead, stages } = await leadGet(db, ctx, args['leadId']);
    const to = stages.find((s) => s.id === args['stageId']);
    if (!to) throw HfosError.validation([], 'That stage isn’t in this lead’s pipeline.');
    if (to.id === lead.stageId)
      throw HfosError.rule('same_stage', 409, `It’s already in ${to.name}.`);
    const reason = str(args['lostReason']);
    const lost = to.kind === 'lost';
    return {
      card: confirmCard(toolCallId, 'move_lead', {
        title: lost
          ? 'Mark this lead as lost?'
          : to.kind === 'won'
            ? 'Mark this lead as won?'
            : 'Move this lead?',
        fields: [
          { label: 'Lead', value: leadLine(lead) },
          ...(lost && reason ? [{ label: 'Reason', value: reason }] : []),
        ],
        body: null,
        stageFrom: lead.stageName,
        stageTo: to.name,
        warnings: [],
        reasons: lost && !reason ? LOST_REASONS : [],
        confirmLabel: lost ? 'Mark as lost' : 'Move lead',
        editable: false,
      }),
      result: {
        lead: lead.title,
        from: lead.stageName,
        to: to.name,
        ...(lost && !reason ? { needsReason: true } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const { stages } = await leadGet(db, ctx, args['leadId']);
    const to = stages.find((s) => s.id === args['stageId']);
    if (!to) throw HfosError.validation([], 'That stage isn’t in this lead’s pipeline.');
    const reason = extra.lostReason ?? str(args['lostReason']);
    if (to.kind === 'lost' && !reason) throw HfosError.validation([], 'Pick a reason first.');
    await command(
      db,
      ctx,
      'lead.move_stage',
      defined({
        leadId: args['leadId'],
        stageId: to.id,
        lostReason: to.kind === 'lost' ? reason : undefined,
      }),
    );
    return {
      outcome: to.kind === 'lost' ? `Marked as lost: ${reason}` : `Moved to ${to.name}`,
      href: paths(ctx.workspaceId).lead(String(args['leadId'])),
      command: 'lead.move_stage',
    };
  },
};

const fullNameOf = (args: Args) =>
  [str(args['firstName']), str(args['lastName'])].filter(Boolean).join(' ');

const createCustomer: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const name = fullNameOf(args);
    if (!name) throw HfosError.validation([], 'Give them a first or last name.');
    const { matches } = await query<{ matches: { name: string; matchedOn: string }[] }>(
      db,
      ctx,
      'crm.find_matches',
      {
        kind: 'person',
        name,
        phone: str(args['phone']) ?? null,
        email: str(args['email']) ?? null,
      },
    );
    return {
      card: confirmCard(toolCallId, 'create_customer', {
        title: `Add ${name} as a new customer?`,
        fields: [
          { label: 'Name', value: name },
          ...(str(args['phone']) ? [{ label: 'Phone', value: String(args['phone']) }] : []),
          ...(str(args['email']) ? [{ label: 'Email', value: String(args['email']) }] : []),
        ],
        body: str(args['notes']) ?? null,
        stageFrom: null,
        stageTo: null,
        warnings: matches.slice(0, 3).map((m) => ({
          kind: 'duplicate',
          text: `${m.name} already has this ${m.matchedOn}. It may be the same person.`,
        })),
        reasons: [],
        confirmLabel: matches.length ? 'Add anyway' : 'Add customer',
        editable: false,
      }),
      result: { name, possibleDuplicates: matches.map((m) => m.name) },
    };
  },
  async commit(db, ctx, args) {
    const { personId } = await command<{ personId: string }>(
      db,
      ctx,
      'person.create',
      defined({
        firstName: str(args['firstName']) ?? '',
        lastName: str(args['lastName']) ?? '',
        phone: str(args['phone']),
        email: str(args['email']),
        notes: str(args['notes']),
        ignoreDuplicates: true,
      }),
    );
    return {
      outcome: `Added ${fullNameOf(args)} to Customers`,
      href: paths(ctx.workspaceId).person(personId),
      command: 'person.create',
    };
  },
};

const updateCustomer: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { person } = await query<{
      person: {
        fullName: string;
        firstName: string;
        lastName: string;
        phone: string | null;
        email: string | null;
      };
    }>(db, ctx, 'person.get', { personId: args['personId'] });
    const nextName = [
      str(args['firstName']) ?? person.firstName,
      str(args['lastName']) ?? person.lastName,
    ]
      .filter(Boolean)
      .join(' ');
    const fields = [
      ...(nextName !== person.fullName
        ? [{ label: 'Name', value: `${person.fullName} → ${nextName}` }]
        : []),
      ...(str(args['phone']) && str(args['phone']) !== person.phone
        ? [{ label: 'Phone', value: `${person.phone ?? 'none'} → ${String(args['phone'])}` }]
        : []),
      ...(str(args['email']) && str(args['email']) !== person.email
        ? [{ label: 'Email', value: `${person.email ?? 'none'} → ${String(args['email'])}` }]
        : []),
    ];
    if (!fields.length) throw HfosError.validation([], 'Nothing would change.');
    return {
      card: confirmCard(toolCallId, 'update_customer', {
        title: `Change ${firstName(person.fullName)}’s details?`,
        fields,
        body: null,
        stageFrom: null,
        stageTo: null,
        warnings: [],
        reasons: [],
        confirmLabel: 'Save changes',
        editable: false,
      }),
      result: { person: person.fullName, changes: fields.map((f) => f.label) },
    };
  },
  async commit(db, ctx, args) {
    await command(
      db,
      ctx,
      'person.update',
      defined({
        personId: args['personId'],
        firstName: str(args['firstName']),
        lastName: str(args['lastName']),
        phone: str(args['phone']),
        email: str(args['email']),
      }),
    );
    return {
      outcome: 'Saved the changes',
      href: paths(ctx.workspaceId).person(String(args['personId'])),
      command: 'person.update',
    };
  },
};

const createLead: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const [{ person }, { pipelines }, who] = await Promise.all([
      query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
        personId: args['personId'],
      }),
      query<{
        pipelines: {
          isDefault: boolean;
          archivedAt: string | null;
          stages: { id: string; name: string; kind: string }[];
        }[];
      }>(db, ctx, 'pipeline.list'),
      teammate(db, ctx, args['assigneeUserId']),
    ]);
    const stages = pipelines.filter((p) => !p.archivedAt).flatMap((p) => p.stages);
    const stage =
      stages.find((s) => s.id === args['stageId']) ??
      pipelines.find((p) => p.isDefault && !p.archivedAt)?.stages.find((s) => s.kind === 'open');
    const value = typeof args['value'] === 'number' ? Math.round(args['value'] * 100) : 0;
    return {
      card: confirmCard(toolCallId, 'create_lead', {
        title: `Open a lead for ${firstName(person.fullName)}?`,
        fields: [
          { label: 'Lead', value: String(args['title']) },
          { label: 'Customer', value: person.fullName },
          { label: 'Value', value: money(value) },
          ...(stage ? [{ label: 'Stage', value: stage.name }] : []),
          ...(who ? [{ label: 'Assigned', value: who }] : []),
          ...(str(args['nextAction'])
            ? [{ label: 'Next', value: String(args['nextAction']) }]
            : []),
        ],
        body: null,
        stageFrom: null,
        stageTo: null,
        warnings: [],
        reasons: [],
        confirmLabel: 'Open lead',
        editable: false,
      }),
      result: { title: args['title'], customer: person.fullName },
    };
  },
  async commit(db, ctx, args) {
    const { leadId } = await command<{ leadId: string }>(
      db,
      ctx,
      'lead.create',
      defined({
        title: args['title'],
        personId: args['personId'],
        valueCents: typeof args['value'] === 'number' ? Math.round(args['value'] * 100) : undefined,
        stageId: args['stageId'],
        assigneeUserId: args['assigneeUserId'],
        nextAction: str(args['nextAction']),
      }),
    );
    return {
      outcome: `Opened ${String(args['title'])}`,
      href: paths(ctx.workspaceId).lead(leadId),
      command: 'lead.create',
    };
  },
};

const updateLead: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { lead } = await leadGet(db, ctx, args['leadId']);
    const fields: { label: string; value: string }[] = [];
    if (args['assigneeUserId'] !== undefined) {
      const who =
        args['assigneeUserId'] === null
          ? 'Nobody'
          : ((await teammate(db, ctx, args['assigneeUserId'])) ?? 'Someone else');
      fields.push({ label: 'Assigned', value: `${lead.assignee?.fullName ?? 'Nobody'} → ${who}` });
    }
    if (typeof args['value'] === 'number')
      fields.push({
        label: 'Value',
        value: `${money(lead.valueCents)} → ${money(Math.round(args['value'] * 100))}`,
      });
    if (args['nextAction'] !== undefined)
      fields.push({
        label: 'Next',
        value: `${lead.nextAction ?? 'none'} → ${str(args['nextAction']) ?? 'none'}`,
      });
    if (!fields.length) throw HfosError.validation([], 'Nothing would change.');
    return {
      card: confirmCard(toolCallId, 'update_lead', {
        title: `Change ${lead.title}?`,
        fields: [{ label: 'Lead', value: leadLine(lead) }, ...fields],
        body: null,
        stageFrom: null,
        stageTo: null,
        warnings: [],
        reasons: [],
        confirmLabel: 'Save changes',
        editable: false,
      }),
      result: { lead: lead.title, changes: fields.map((f) => f.label) },
    };
  },
  async commit(db, ctx, args) {
    const leadId = args['leadId'];
    if (args['assigneeUserId'] !== undefined || typeof args['value'] === 'number')
      await command(
        db,
        ctx,
        'lead.update',
        defined({
          leadId,
          assigneeUserId: args['assigneeUserId'],
          valueCents:
            typeof args['value'] === 'number' ? Math.round(args['value'] * 100) : undefined,
        }),
      );
    if (args['nextAction'] !== undefined)
      await command(db, ctx, 'lead.set_next_action', {
        leadId,
        text: str(args['nextAction']) ?? null,
        dueAt: args['nextActionAt'] ?? null,
      });
    return {
      outcome: 'Saved the changes',
      href: paths(ctx.workspaceId).lead(String(leadId)),
      command: 'lead.update',
    };
  },
};

const confirmTools: Record<string, ConfirmTool> = {
  send_text: sendText,
  send_email: sendEmail,
  move_lead: moveLead,
  create_customer: createCustomer,
  update_customer: updateCustomer,
  create_lead: createLead,
  update_lead: updateLead,
  ...calendarConfirmTools,
  ...workflowConfirmTools,
};

/** Every tool the Assistant can call has one of these; worker tests check none is missing. */
export const executorFor = (name: string) =>
  readTools[name] ?? autoWrites[name] ?? workflowAutoTools[name] ?? confirmTools[name];

/** `workflows`: the model drafting workflows talks to (without it, draft_workflow says the AI isn't set up). */
export function createToolExecutor(
  db: Db,
  workflows: WorkflowToolDeps | null = null,
): ToolExecutor {
  return {
    async run(tool: AssistantTool, args: Args, ctx: ToolContext) {
      const run = readTools[tool.name] ?? autoWrites[tool.name];
      if (run) return run(db, ctx, args);
      const flow = workflowAutoTools[tool.name];
      if (!flow) throw new Error(`No executor for ${tool.name}`);
      return flow(db, ctx, args, workflows);
    },
    async prepare(tool, args, ctx, toolCallId) {
      const t = confirmTools[tool.name];
      if (!t) throw new Error(`No confirmation for ${tool.name}`);
      return t.prepare(db, ctx, args, toolCallId);
    },
    async commit(tool, args, ctx, extra) {
      const t = confirmTools[tool.name];
      if (!t) throw new Error(`No confirmation for ${tool.name}`);
      return t.commit(db, ctx, args, extra);
    },
    async undo(tool, record, ctx) {
      switch (tool.name) {
        case 'create_task':
          await command(db, ctx, 'task.delete', { taskId: record['taskId'] });
          return 'Undone. The task is gone.';
        case 'complete_task':
          await command(db, ctx, 'task.reopen', { taskId: record['taskId'] });
          return 'Undone. The task is open again.';
        case 'add_note':
          await command(db, ctx, 'activity.delete', { activityId: record['activityId'] });
          return 'Undone. The note is gone.';
        default:
          throw HfosError.conflict('There is nothing to undo here.', 'nothing_to_undo');
      }
    },
  };
}
