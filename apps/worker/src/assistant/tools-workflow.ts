/**
 * The Assistant's workflow and knowledge tools. Looking up workflows, drafting one with the AI builder (a
 * proposal only: nothing changes until the person opens it and applies it) and searching the knowledge base
 * run on their own. Starting a customer on a workflow, pausing or resuming one, taking someone out, answering
 * an approval and adding to the knowledge base wait for the person's OK on a card. Each goes through the
 * commands and queries the app uses, as the person, marked as done through the Assistant.
 */
import {
  describeStep,
  describeTrigger,
  HfosError,
  parseDefinition,
  type AssistantCard,
  type WorkflowCatalogs,
  type WorkflowDefinition,
} from '@hfos/core/server';
import { asWorker, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { proposeGap } from '../knowledge/gaps';
import { systemActor, type WorkerServices } from '../services';
import { draftProposal, proposalLines } from '../workflows/builder';
import { approvalPreview, approvalWhat } from './approval-words';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, query } from './tools-read';

type Args = Record<string, unknown>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type Warning = { kind: string; text: string };

/** What drafting needs besides the database: the model the builder talks to. */
export interface WorkflowToolDeps {
  readonly ai: WorkerServices['ai'];
  readonly log: Logger;
  readonly wallet: WorkerServices['wallet'];
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const firstName = (full: string) => full.split(' ')[0] || full;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A name for an address: words joined by underscores, letters, digits and hyphens only. */
const slug = (name: string) =>
  name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 80);

/** Workflow and knowledge pages the cards link to. */
export const workflowPaths = (ws: string) => ({
  workflow: (id: string) => `/app/w/${ws}/workflows/${id}`,
  describe: (id: string, proposalId: string) =>
    `/app/w/${ws}/workflows/${id}?mode=describe&proposal=${proposalId}`,
  fresh: (proposalId: string, name: string | null) =>
    `/app/w/${ws}/workflows/new?proposal=${proposalId}${name && slug(name) ? `&name=${slug(name)}` : ''}`,
  runs: (id: string) => `/app/w/${ws}/workflows/runs?workflow=${id}`,
  run: (id: string) => `/app/w/${ws}/workflows/runs/${id}`,
  approvals: () => `/app/w/${ws}/workflows/approvals`,
  knowledge: () => `/app/w/${ws}/knowledge`,
  item: (id: string) => `/app/w/${ws}/knowledge/items/${id}`,
});

const STATUS_WORD: Record<string, string> = {
  draft: 'Draft',
  active: 'On',
  paused: 'Paused',
  archived: 'Archived',
};

interface WorkflowItem {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  revision: number;
  trigger: { kind: string; summary: string };
  activeVersion: { id: string; version: number } | null;
  runs30d: number;
  activeRuns: number;
}
interface WorkflowDetail extends WorkflowItem {
  definition: Record<string, unknown>;
}

const workflowGet = async (db: Db, ctx: ToolContext, workflowId: unknown) =>
  (await query<{ workflow: WorkflowDetail }>(db, ctx, 'workflow.get', { workflowId })).workflow;

/** The definition new runs follow: the live version's, else the draft's. With names for its ids. */
async function liveDefinition(
  db: Db,
  ctx: ToolContext,
  wf: WorkflowDetail,
): Promise<{ def: WorkflowDefinition; names: WorkflowCatalogs }> {
  const [{ catalogs }, version] = await Promise.all([
    query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs'),
    wf.activeVersion
      ? query<{ version: { definition: unknown } }>(db, ctx, 'workflow.version_get', {
          workflowId: wf.id,
          version: wf.activeVersion.version,
        })
      : Promise.resolve(null),
  ]);
  return { def: parseDefinition(version?.version.definition ?? wf.definition), names: catalogs };
}

function confirmCard(
  toolCallId: string,
  tool: string,
  card: Pick<ConfirmCard, 'title' | 'fields' | 'body' | 'warnings' | 'confirmLabel'> &
    Partial<Pick<ConfirmCard, 'personId'>>,
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: null,
    conversationId: null,
    stageFrom: null,
    stageTo: null,
    reasons: [],
    editable: false,
    ...card,
  };
}

// ---------- on their own ----------

export type WorkflowAutoTool = (
  db: Db,
  ctx: ToolContext,
  args: Args,
  deps: WorkflowToolDeps | null,
) => Promise<ToolOutcome>;

interface KnowledgeHit {
  id: string;
  kind: 'faq' | 'article' | 'fact' | 'document';
  title: string;
  body: string;
  snippet: string;
  sourceUrl: string | null;
}

export const workflowAutoTools: Record<string, WorkflowAutoTool> = {
  async list_workflows(db, ctx, args) {
    const { items } = await query<{ items: WorkflowItem[] }>(
      db,
      ctx,
      'workflow.list',
      str(args['status']) ? { status: [args['status']] } : {},
    );
    const p = workflowPaths(ctx.workspaceId);
    return {
      result: {
        workflows: items.map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          startsWhen: w.trigger.summary,
          // start_workflow takes only these.
          canStartForSomeone: w.trigger.kind === 'manual',
          liveVersion: w.activeVersion?.version ?? null,
          runsLast30Days: w.runs30d,
          runsGoingNow: w.activeRuns,
        })),
      },
      card: items.length
        ? {
            type: 'list',
            title: plural(items.length, 'workflow'),
            items: items.slice(0, 12).map((w) => ({
              title: w.name,
              detail: `${STATUS_WORD[w.status] ?? w.status} · ${w.trigger.summary}`,
              tone: w.status === 'active' ? 'accent' : w.status === 'paused' ? 'warning' : 'muted',
              href: p.workflow(w.id),
            })),
          }
        : null,
    };
  },

  async draft_workflow(db, ctx, args, deps) {
    if (!deps?.ai.provider)
      throw HfosError.rule(
        'ai_not_configured',
        503,
        'The AI isn’t set up for HandsFreeOS yet, so it can’t draft a workflow. Build one by hand from New workflow in Workflows instead.',
      );
    const workflowId = str(args['workflowId']) ?? null;
    const current = workflowId ? await workflowGet(db, ctx, workflowId) : null;
    const { proposal, catalogs } = await draftProposal(
      { db, ai: deps.ai, log: deps.log, wallet: deps.wallet },
      ctx.actor,
      {
        workspaceId: ctx.workspaceId,
        workflowId,
        baseRevision: current?.revision ?? null,
        prompt: String(args['description']),
      },
      'assistant',
    );
    const p = workflowPaths(ctx.workspaceId);
    const name = current?.name ?? str(args['name']) ?? 'New workflow';
    const { lines, more } = proposalLines(proposal.preview, catalogs);
    const errors = proposal.issues.filter((i) => i.severity === 'error');
    const href = workflowId
      ? p.describe(workflowId, proposal.proposalId)
      : p.fresh(proposal.proposalId, str(args['name']) ?? null);
    const card: AssistantCard = {
      type: 'workflow',
      workflowId,
      proposalId: proposal.proposalId,
      name,
      status: 'proposal',
      trigger: describeTrigger(proposal.preview.trigger, catalogs),
      steps: lines,
      more,
      changes: workflowId ? proposal.summary.slice(0, 8) : [],
      issues: errors.length,
      issueNote: errors[0]?.message ?? null,
      unsupported: proposal.unsupported.slice(0, 5),
      href,
    };
    return {
      result: {
        proposalId: proposal.proposalId,
        for: current ? current.name : 'a new workflow',
        said: proposal.reply,
        changes: proposal.summary,
        unsupported: proposal.unsupported,
        checksToFix: errors.map((i) => i.message),
        note: 'A proposal only: nothing changes until the person opens it and applies it, and a workflow needs a passing test before it is published.',
      },
      card,
      command: 'workflow_proposal.create',
      record: {
        proposalId: proposal.proposalId,
        outcome: current ? `Drafted a change to “${current.name}”` : `Drafted “${name}”`,
        href,
      },
    };
  },

  async search_knowledge(db, ctx, args) {
    const question = String(args['query']);
    const { matches } = await query<{ matches: KnowledgeHit[] }>(db, ctx, 'knowledge.search', {
      query: question,
      limit: 5,
    });
    const p = workflowPaths(ctx.workspaceId);
    if (!matches.length) {
      // A question the knowledge base can't answer waits in Suggestions for someone to write the answer.
      const scope = { workspaceId: ctx.workspaceId, organizationId: ctx.organizationId };
      const gap = await asWorker(db, scope, (tx) =>
        proposeGap(tx, systemActor(scope, ctx.actor.userId), {
          question,
          context: { via: 'assistant' },
        }),
      ).catch(() => null);
      return {
        result: {
          items: [],
          note: 'Nothing in the knowledge base answers this. Say so plainly, and don’t guess.',
          ...(gap ? { addedToSuggestions: true } : {}),
        },
      };
    }
    return {
      result: {
        items: matches.map((m) => ({
          id: m.id,
          kind: m.kind,
          title: m.title,
          text: m.body.slice(0, 1500),
          ...(m.sourceUrl ? { source: m.sourceUrl } : {}),
        })),
        note: 'Answer only from these items, and say which one you used.',
      },
      card: {
        type: 'knowledge',
        items: matches.slice(0, 5).map((m) => ({
          id: m.id,
          kind: m.kind,
          title: m.title,
          snippet: (m.snippet || m.body).slice(0, 240),
          href: p.item(m.id),
        })),
        href: p.knowledge(),
      },
    };
  },
};

// ---------- waiting for the person's OK ----------

export interface WorkflowConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    extra: { readonly toolCallId: string },
  ): Promise<CommittedAction>;
}

/** Why a workflow can't take this action now, in words for the card (null when it can). */
function notLive(wf: WorkflowItem, want: 'active' | 'paused'): string | null {
  if (wf.status === want) return null;
  if (wf.status === 'archived') return `“${wf.name}” is archived.`;
  if (wf.status === 'draft') return `“${wf.name}” isn’t published yet, so it isn’t on.`;
  if (want === 'active') return `“${wf.name}” is paused. Resume it first.`;
  return `“${wf.name}” is already on.`;
}

/**
 * Only a workflow that starts by hand can be started for someone, as "Add to workflow…" on a customer's page
 * offers (one that starts on its own event would run without the lead or appointment it expects).
 */
function notByHand(wf: WorkflowItem): string | null {
  return wf.trigger.kind === 'manual'
    ? null
    : `“${wf.name}” starts on its own (${lowerFirst(wf.trigger.summary)}), so it can’t be started for someone by hand.`;
}

const LIVE_STATUSES = ['running', 'waiting', 'awaiting_approval', 'held'];

async function runsOf(
  db: Db,
  ctx: ToolContext,
  input: { workflowId: string; personId?: string; status: string[] },
): Promise<number> {
  const { items } = await query<{ items: unknown[] }>(db, ctx, 'workflow.run_list', {
    ...input,
    limit: 100,
  });
  return items.length;
}

const startWorkflow: WorkflowConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const [wf, { person }] = await Promise.all([
      workflowGet(db, ctx, args['workflowId']),
      query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
        personId: args['personId'],
      }),
    ]);
    const { def, names } = await liveDefinition(db, ctx, wf);
    const blocked = notLive(wf, 'active') ?? notByHand(wf);
    const [first, second] = def.steps;
    return {
      card: confirmCard(toolCallId, 'start_workflow', {
        personId: String(args['personId']),
        title: `Start “${wf.name}” for ${person.fullName}?`,
        fields: [
          {
            label: 'Starts with',
            value: first
              ? `Step 1, ${lowerFirst(describeStep(first, names, def))}`
              : 'Nothing: it has no steps',
          },
          ...(second ? [{ label: 'Then', value: describeStep(second, names, def) }] : []),
          ...(def.settings.stopOn.length || def.steps.length > 2
            ? [{ label: 'Steps', value: plural(def.steps.length, 'step') }]
            : []),
        ],
        body: null,
        warnings: blocked ? [{ kind: 'blocked', text: blocked }] : [],
        confirmLabel: blocked ? '' : 'Start',
      }),
      result: {
        workflow: wf.name,
        customer: person.fullName,
        ...(blocked ? { cannotStart: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const [wf, { person }] = await Promise.all([
      workflowGet(db, ctx, args['workflowId']),
      query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
        personId: args['personId'],
      }),
    ]);
    const byHand = notByHand(wf);
    if (byHand) throw HfosError.conflict(byHand, 'workflow_not_manual');
    await command(db, ctx, 'workflow.enrol', {
      workflowId: args['workflowId'],
      personId: args['personId'],
    });
    return {
      outcome: `Started “${wf.name}” for ${person.fullName}.`,
      href: workflowPaths(ctx.workspaceId).runs(wf.id),
      command: 'workflow.enrol',
    };
  },
};

const pauseWorkflow: WorkflowConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    const blocked = notLive(wf, 'active');
    const starts = wf.trigger.kind === 'manual' ? null : lowerFirst(wf.trigger.summary);
    const warnings: Warning[] = blocked
      ? [{ kind: 'blocked', text: blocked }]
      : starts
        ? [
            {
              kind: 'paused_triggers',
              text: `While it’s paused, nothing starts it (${starts}), and those don’t start it later.`,
            },
          ]
        : [];
    return {
      card: confirmCard(toolCallId, 'pause_workflow', {
        title: `Pause “${wf.name}”?`,
        fields: [
          { label: 'New starts', value: 'Ignored while it’s paused, not saved for later' },
          {
            label: 'Runs now',
            value:
              wf.activeRuns === 0
                ? 'None going'
                : wf.activeRuns === 1
                  ? '1 run holds at its next step'
                  : `${wf.activeRuns} runs hold at their next step`,
          },
          { label: 'Resume', value: 'Any time from Workflows, or ask me' },
        ],
        body: null,
        warnings,
        confirmLabel: blocked ? '' : 'Pause',
      }),
      result: {
        workflow: wf.name,
        runsGoing: wf.activeRuns,
        ...(blocked ? { cannotPause: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    await command(db, ctx, 'workflow.pause', { workflowId: wf.id });
    return {
      outcome: `Paused “${wf.name}”.${wf.activeRuns ? ` ${plural(wf.activeRuns, 'run is', 'runs are')} holding.` : ''}`,
      href: workflowPaths(ctx.workspaceId).workflow(wf.id),
      command: 'workflow.pause',
    };
  },
};

const resumeWorkflow: WorkflowConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    const blocked = notLive(wf, 'paused');
    const held = blocked
      ? 0
      : await runsOf(db, ctx, { workflowId: wf.id, status: ['held'] }).catch(() => 0);
    return {
      card: confirmCard(toolCallId, 'resume_workflow', {
        title: `Resume “${wf.name}”?`,
        fields: [
          { label: 'Starts', value: wf.trigger.summary },
          {
            label: 'Held runs',
            value: held ? `${plural(held, 'run')} carry on, a batch at a time` : 'None waiting',
          },
        ],
        body: null,
        warnings: blocked ? [{ kind: 'blocked', text: blocked }] : [],
        confirmLabel: blocked ? '' : 'Resume',
      }),
      result: { workflow: wf.name, heldRuns: held, ...(blocked ? { cannotResume: blocked } : {}) },
    };
  },
  async commit(db, ctx, args) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    await command(db, ctx, 'workflow.resume', { workflowId: wf.id });
    return {
      outcome: `Resumed “${wf.name}”. It starts again for anything new.`,
      href: workflowPaths(ctx.workspaceId).workflow(wf.id),
      command: 'workflow.resume',
    };
  },
};

const removeContact: WorkflowConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const [wf, { person }] = await Promise.all([
      workflowGet(db, ctx, args['workflowId']),
      query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
        personId: args['personId'],
      }),
    ]);
    const going = await runsOf(db, ctx, {
      workflowId: wf.id,
      personId: String(args['personId']),
      status: LIVE_STATUSES,
    });
    const blocked = going
      ? null
      : `${firstName(person.fullName)} isn’t in “${wf.name}” right now, so nothing would change.`;
    return {
      card: confirmCard(toolCallId, 'remove_contact_from_workflow', {
        personId: String(args['personId']),
        title: `Take ${person.fullName} out of “${wf.name}”?`,
        fields: [
          { label: 'Customer', value: person.fullName },
          { label: 'Runs going', value: going ? `${plural(going, 'run')} stop now` : 'None' },
        ],
        body: null,
        warnings: blocked ? [{ kind: 'blocked', text: blocked }] : [],
        confirmLabel: blocked ? '' : 'Take them out',
      }),
      result: {
        workflow: wf.name,
        customer: person.fullName,
        runsGoing: going,
        ...(blocked ? { nothingToDo: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const [wf, { person }] = await Promise.all([
      workflowGet(db, ctx, args['workflowId']),
      query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
        personId: args['personId'],
      }),
    ]);
    const out = await command<{ pending: boolean }>(db, ctx, 'workflow.remove_contact', {
      workflowId: wf.id,
      personId: args['personId'],
    });
    return {
      outcome: out.pending
        ? `${person.fullName} comes out of “${wf.name}” in a moment.`
        : `Took ${person.fullName} out of “${wf.name}”.`,
      href: workflowPaths(ctx.workspaceId).runs(wf.id),
      command: 'workflow.remove_contact',
    };
  },
};

interface ApprovalItem {
  id: string;
  runId: string;
  workflow: { id: string; name: string };
  status: string;
  preview: Record<string, unknown>;
  person: { id: string; fullName: string } | null;
  canDecide: boolean;
}

async function pendingApproval(db: Db, ctx: ToolContext, id: unknown): Promise<ApprovalItem> {
  const { items } = await query<{ items: ApprovalItem[] }>(db, ctx, 'workflow.approval_list', {
    status: 'pending',
    limit: 100,
  });
  const a = items.find((x) => x.id === id);
  if (!a)
    throw HfosError.notFound(
      'That approval isn’t waiting anymore. Someone may have answered it already, or its run ended.',
    );
  return a;
}

const answerApproval: WorkflowConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const a = await pendingApproval(db, ctx, args['approvalId']);
    const p = approvalPreview(a.preview);
    const approve = args['decision'] !== 'reject';
    const what = approvalWhat(a.preview);
    const who = a.person?.fullName ?? p.customer ?? 'the customer';
    const edited = approve && p.fields.length ? str(args['message']) : undefined;
    const text = edited ?? p.fields[0]?.[1] ?? null;
    const blocked = a.canDecide
      ? null
      : 'Only the people this approval names, or owners and admins, can decide it.';
    const title =
      what === 'the next step'
        ? `${approve ? 'Approve' : 'Reject'} the next step of “${a.workflow.name}” for ${who}?`
        : `${approve ? 'Approve' : 'Reject'} ${what === 'a text' ? 'the text' : 'the email'} to ${who}?`;
    return {
      card: confirmCard(toolCallId, 'answer_workflow_approval', {
        personId: a.person?.id ?? null,
        title,
        fields: [
          { label: 'Workflow', value: a.workflow.name },
          ...(p.note ? [{ label: 'Asks', value: p.note }] : []),
          ...(edited ? [{ label: 'Edited', value: 'Your words go instead of the AI’s' }] : []),
          ...(!approve && str(args['reason'])
            ? [{ label: 'Reason', value: String(args['reason']) }]
            : []),
        ],
        body: text,
        warnings: blocked ? [{ kind: 'blocked', text: blocked }] : [],
        confirmLabel: blocked ? '' : approve ? (text ? 'Approve and send' : 'Approve') : 'Reject',
      }),
      result: {
        workflow: a.workflow.name,
        customer: who,
        decision: approve ? 'approve' : 'reject',
        whatGoesOut: what,
        ...(blocked ? { cannotDecide: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const a = await pendingApproval(db, ctx, args['approvalId']);
    const p = approvalPreview(a.preview);
    const approve = args['decision'] !== 'reject';
    const message = approve && p.fields.length ? str(args['message']) : undefined;
    await command(db, ctx, 'workflow.decide_approval', {
      approvalId: a.id,
      decision: approve ? 'approve' : 'reject',
      ...(message ? { edits: { [p.fields[0]![0]]: message } } : {}),
      ...(!approve && str(args['reason']) ? { reason: String(args['reason']) } : {}),
    });
    const who = a.person?.fullName ?? p.customer ?? 'the customer';
    const what = approvalWhat(a.preview);
    return {
      outcome: approve
        ? what === 'the next step'
          ? `Approved. “${a.workflow.name}” carries on for ${who}.`
          : `Approved. ${what === 'a text' ? 'The text' : 'The email'} goes to ${who}.`
        : `Rejected. “${a.workflow.name}” takes its rejected path for ${who}.`,
      href: workflowPaths(ctx.workspaceId).run(a.runId),
      command: 'workflow.decide_approval',
    };
  },
};

const KIND_WORD = { faq: 'FAQ', fact: 'fact', article: 'article' } as const;
type WritableKind = keyof typeof KIND_WORD;
const kindOf = (v: unknown): WritableKind => (v === 'fact' || v === 'article' ? v : 'faq');

const addKnowledgeItem: WorkflowConfirmTool = {
  async prepare(_db, _ctx, args, toolCallId) {
    const kind = kindOf(args['kind']);
    const publish = args['publish'] === true;
    return {
      card: confirmCard(toolCallId, 'add_knowledge_item', {
        title: `Add this ${KIND_WORD[kind]} to your knowledge base?`,
        fields: [
          { label: kind === 'faq' ? 'Question' : 'Title', value: String(args['title']) },
          {
            label: 'Saved as',
            value: publish
              ? 'Published: AI steps and the Assistant use it'
              : 'A draft: nothing uses it until it’s published',
          },
        ],
        body: String(args['body']),
        warnings: [],
        confirmLabel: publish ? 'Publish' : 'Save draft',
      }),
      result: { kind, title: args['title'], status: publish ? 'published' : 'draft' },
    };
  },
  async commit(db, ctx, args) {
    const kind = kindOf(args['kind']);
    const publish = args['publish'] === true;
    const title = String(args['title']);
    const body = String(args['body']);
    const content =
      kind === 'faq'
        ? { kind, question: title, answer: body, tags: [] }
        : { kind, title, body, tags: [] };
    const { itemId } = await command<{ itemId: string }>(db, ctx, 'knowledge_item.create', {
      content,
      status: publish ? 'published' : 'draft',
    });
    return {
      outcome: publish ? `Published “${title}”.` : `Added “${title}” as a draft.`,
      href: workflowPaths(ctx.workspaceId).item(itemId),
      command: 'knowledge_item.create',
    };
  },
};

export const workflowConfirmTools: Record<string, WorkflowConfirmTool> = {
  start_workflow: startWorkflow,
  pause_workflow: pauseWorkflow,
  resume_workflow: resumeWorkflow,
  remove_contact_from_workflow: removeContact,
  answer_workflow_approval: answerApproval,
  add_knowledge_item: addKnowledgeItem,
};
