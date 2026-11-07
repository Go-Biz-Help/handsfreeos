/**
 * The Assistant's workflow and knowledge tools. Looking up workflows, their recipes and a template's update,
 * drafting one with the AI builder (a proposal only: nothing changes until it is applied, with
 * do_workflow_proposal_apply once the person agrees, or by them on its page) and searching the knowledge base run on
 * their own. Starting a customer on a workflow, pausing or resuming one, taking someone out, answering an approval,
 * applying a template's update and adding to the knowledge base wait for the person's OK on a card. Each goes
 * through the commands and queries the app uses, as the person, marked as done through the Assistant; publishing,
 * restoring a version and testing are the screen's own commands, drawn on cards of their own at the end.
 */
import {
  APPROVALS_WORDS,
  approvalAsked,
  approvalCustomerOf,
  approvalDecidedLine,
  approvalFieldLabel,
  approvalKind,
  approvalPreviewOf,
  describeOps,
  describeStep,
  describeTrigger,
  diffWorkflows,
  endReasonText,
  executeCommand,
  findStep,
  HfosError,
  isLiveRun,
  KnowledgeWritableContent,
  parseDefinition,
  placeholderChoices,
  planTemplateUpdate,
  RECIPE_CARDS,
  recipeDefinition,
  refName,
  resolvePlaceholders,
  RUN_STATUS,
  runStepTitle,
  sendsReminder,
  suggestMapping,
  WORKFLOW_RECIPES,
  workflowAvailability,
  workflowPublish,
  workflowRestoreVersion,
  workflowTemplateApplyUpdate,
  workflowTest,
  type AssistantCard,
  type RunStatus,
  type CalendarConfig,
  type WorkflowCatalogs,
  type WorkflowDefinition,
} from '@hfos/core/server';
import { asWorker, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { hasPermission } from '../http/common';
import { proposeGap } from '../knowledge/gaps';
import { systemActor, type WorkerServices } from '../services';
import { draftProposal, proposalLines } from '../workflows/builder';
import { previewOf, type TemplateUpdatePreview } from '../workflows/templates-routes';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, query, quoted, when } from './tools-read';

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

/** A workflow as `workflow.list` gives it (core's WorkflowSummaryOut). */
export interface WorkflowItem {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  revision: number;
  /** The draft revision that last passed a test; `tested` when it's the draft as it is now. */
  testedRevision: number | null;
  tested: boolean;
  trigger: { kind: string; summary: string };
  activeVersion: { id: string; version: number } | null;
  runs30d: number;
  activeRuns: number;
  calendarIds: string[];
  /** It starts from every calendar's appointments. */
  allCalendars: boolean;
  /** once, after_exit or always, from the version new runs follow. */
  reentry: string;
  source: {
    kind: 'template' | 'recipe' | 'blank';
    recipeKey: string | null;
    recipeName: string | null;
    template: {
      id: string;
      name: string;
      installedVersion: number | null;
      latestVersion: number | null;
      updateAvailable: boolean;
    } | null;
  };
  lastError: { runId: string; stepKey: string; message: string; at: string } | null;
  lastRun: {
    id: string;
    status: RunStatus;
    startedAt: string;
    endedAt: string | null;
    endReason: string | null;
    person: { id: string; fullName: string } | null;
  } | null;
}
interface WorkflowDetail extends WorkflowItem {
  definition: Record<string, unknown>;
}

/** Where a workflow came from, as its chips say: the agency's template (and an update waiting), a recipe, or Blank. */
export function sourceOut(s: WorkflowItem['source']) {
  if (s.kind === 'template' && s.template)
    return {
      from: `Go Biz Help${s.template.installedVersion ? ` v${s.template.installedVersion}` : ''}: the template “${s.template.name}”`,
      ...(s.template.updateAvailable
        ? {
            updateAvailable: `Version ${s.template.latestVersion} is out: Review update on the Workflows list, or review_template_update, shows what it changes`,
          }
        : {}),
    };
  if (s.kind === 'recipe')
    return { from: `Recipe${s.recipeName ? `: ${s.recipeName}` : ''}`, recipeKey: s.recipeKey };
  return { from: 'Blank' };
}

/**
 * The Workflows list's Last run column: when, the customer and how it ended ("Maria Santos · They replied"), and for a
 * run that failed, the step's error with the run's id (See the run).
 */
export function lastRunOut(w: Pick<WorkflowItem, 'lastRun' | 'lastError'>, timezone: string) {
  const r = w.lastRun;
  if (!r) return { lastRun: 'No runs yet' };
  const how = isLiveRun(r.status)
    ? RUN_STATUS[r.status].label
    : (endReasonText(r.endReason) ?? RUN_STATUS[r.status].label);
  const failed = r.status === 'failed' ? w.lastError : null;
  return {
    lastRun: {
      runId: r.id,
      started: when(r.startedAt, timezone),
      line: `${r.person?.fullName ?? 'No customer'} · ${how}`,
    },
    ...(failed ? { lastRunFailed: { whatWentWrong: failed.message, runId: failed.runId } } : {}),
  };
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

/** The business, once the person is known to manage its workflows: Review update's own check (templates-routes.ts). */
async function managesWorkflows(db: Db, ctx: ToolContext) {
  if (!(await hasPermission({ httpDb: db }, ctx.actor.userId, ctx.workspaceId, 'workflows.manage')))
    throw HfosError.forbidden(
      'Only people who manage workflows here can update one from its template. Ask an owner of this business.',
    );
  return { workspaceId: ctx.workspaceId, organizationId: ctx.organizationId };
}

/**
 * What Review update shows for a copy of an agency template. A business can't read its agency's templates, so the
 * plan is read as the system bound to this business, as the route does; the workflow is read as the person first.
 */
async function templateUpdate(db: Db, ctx: ToolContext, workflowId: unknown) {
  const wf = await workflowGet(db, ctx, workflowId);
  const scope = await managesWorkflows(db, ctx);
  const plan = await asWorker(db, scope, (tx) => planTemplateUpdate(tx, ctx.workspaceId, wf.id));
  return { wf, scope, update: previewOf(plan) };
}

/** The Update available dialog's words (apps/web/src/components/agency/template-update.tsx). */
function templateUpdateWords(p: TemplateUpdatePreview) {
  if (!p.updateAvailable) return { says: 'This copy already has the newest version.' };
  return {
    says: `Go Biz Help updated “${p.templateName}” to version ${p.latestVersion}. You’re on version ${p.installedVersion ?? 1}.`,
    [`whatChangesInVersion${p.latestVersion}`]: p.templateChanges.length
      ? p.templateChanges
      : 'Nothing in the steps; the details only.',
    ...(p.kept.length ? { yourChangesStay: p.kept } : {}),
    ...(p.dropped.length ? { theseChangesOfYoursNoLongerFitSoTheyGo: p.dropped } : {}),
    ...(p.changedSinceInstall && !p.kept.length && !p.dropped.length
      ? {
          note: 'Your copy was edited, but it ends up the same as before, so nothing of yours is lost.',
        }
      : {}),
    ...(p.unmapped.length ? { pickAfterwards: pickAfterwards(p) } : {}),
    applying:
      'Applying makes a draft of your copy. You test it and publish it, like any change. What runs now keeps running until then.',
  };
}

const pickAfterwards = (p: TemplateUpdatePreview) =>
  `Afterwards, pick ${p.unmapped.map((u) => u.label.toLowerCase()).join(', ')} in Checks before you publish.`;

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

/**
 * The workflows of a calendar's Automations that text or email customers before their appointment while the
 * calendar sends its own reminders: the warning that customers could hear from the business twice.
 */
async function remindsTwice(
  db: Db,
  ctx: ToolContext,
  calendarId: string,
  items: readonly WorkflowItem[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const calendar = await query<{ calendar: { config: CalendarConfig } }>(db, ctx, 'calendar.get', {
    calendarId,
  }).catch(() => null);
  const n = calendar?.calendar.config.notifications;
  if (!n?.reminders.length || !(n.reminderChannels.text || n.reminderChannels.email)) return out;
  const defs = await Promise.all(
    items.map((w) =>
      workflowGet(db, ctx, w.id)
        .then((d) => parseDefinition(d.definition))
        .catch(() => null),
    ),
  );
  items.forEach((w, i) => {
    const def = defs[i];
    if (def && sendsReminder(def)) out.add(w.id);
  });
  return out;
}

/** A workflow approval as `workflow.approval_list` gives it (core's ApprovalFacts). */
interface ApprovalItem {
  id: string;
  runId: string;
  workflow: { id: string; name: string };
  status: string;
  approvers: { id: string; fullName: string }[];
  preview: Record<string, unknown>;
  edits: Record<string, unknown> | null;
  reason: string | null;
  decidedBy: { id: string; fullName: string } | null;
  decidedAt: string | null;
  via: string | null;
  expiresAt: string | null;
  createdAt: string;
  person: { id: string; fullName: string } | null;
  canDecide: boolean;
}

/** Past its expiry: the approval step's own path takes over, so nobody can decide it now. */
const approvalExpired = (a: Pick<ApprovalItem, 'expiresAt'>) =>
  !!a.expiresAt && Date.parse(a.expiresAt) <= Date.now();

/**
 * One approval as its card on Workflows → Approvals shows it: the customer, the workflow, what goes out, the step's
 * note, each AI-written text by its key (what the AI wrote, so data), the customer's latest message (theirs), the
 * knowledge used, who was asked, how long it has waited and when it expires; or, decided, the Decided list's line.
 */
function approvalOut(a: ApprovalItem, timezone: string) {
  const p = approvalPreviewOf(a);
  const pending = a.status === 'pending';
  const expired = pending && approvalExpired(a);
  return {
    id: a.id,
    workflow: { id: a.workflow.id, name: a.workflow.name },
    customer: approvalCustomerOf(a, p),
    personId: a.person?.id ?? null,
    runId: a.runId,
    whatGoesOut: approvalKind(p),
    ...(p.note ? { note: p.note } : {}),
    ...(p.fields.length
      ? {
          aiWritten: Object.fromEntries(
            p.fields.map(([key, text]) => [
              key,
              { label: approvalFieldLabel(p, key), ai_wrote: text },
            ]),
          ),
        }
      : {}),
    ...(p.asked ? { theirLatestMessage: quoted(p.asked) } : {}),
    ...(p.items.length ? { knowledgeUsed: p.items.map((i) => i.title) } : {}),
    asked: approvalAsked(a.approvers),
    waitingSince: when(a.createdAt, timezone),
    ...(pending && a.expiresAt
      ? expired
        ? { expired: APPROVALS_WORDS.expiredInfo }
        : { expires: when(a.expiresAt, timezone), ifNobodyDecides: APPROVALS_WORDS.expiryInfo }
      : {}),
    ...(pending
      ? {
          canDecide: a.canDecide && !expired,
          ...(!a.canDecide
            ? { whoDecides: 'Only the people it asks, or owners and admins, can decide it.' }
            : {}),
        }
      : {
          decided: approvalDecidedLine(a),
          ...(a.decidedAt ? { when: when(a.decidedAt, timezone) } : {}),
          ...(a.status === 'approved'
            ? { edited: !!a.edits && Object.keys(a.edits).length > 0 }
            : {}),
        }),
  };
}

export const workflowAutoTools: Record<string, WorkflowAutoTool> = {
  async list_workflow_approvals(db, ctx, args) {
    const status = str(args['status']) ?? 'pending';
    const { items, nextCursor } = await query<{
      items: ApprovalItem[];
      nextCursor: string | null;
    }>(db, ctx, 'workflow.approval_list', {
      status,
      ...(str(args['workflowId']) ? { workflowId: args['workflowId'] } : {}),
      limit: Number(args['limit'] ?? 10),
      ...(str(args['cursor']) ? { cursor: args['cursor'] } : {}),
    });
    const p = workflowPaths(ctx.workspaceId);
    return {
      result: {
        approvals: items.map((a) => approvalOut(a, ctx.timezone)),
        shown: items.length,
        ...(nextCursor ? { more: true, nextCursor } : {}),
        ...(items.length
          ? {}
          : {
              note:
                status === 'pending'
                  ? 'No workflow approval is waiting.'
                  : `No workflow approval was ${status} lately.`,
            }),
      },
      card: items.length
        ? {
            type: 'list',
            title:
              status === 'pending'
                ? `${plural(items.length, 'approval')} waiting`
                : `${plural(items.length, 'approval')} ${status}`,
            items: items.slice(0, 12).map((a) => {
              const pv = approvalPreviewOf(a);
              const late = a.status === 'pending' && approvalExpired(a);
              return {
                title: `${approvalCustomerOf(a, pv)} · ${a.workflow.name}`,
                detail:
                  a.status !== 'pending'
                    ? approvalDecidedLine(a)
                    : late
                      ? 'Expired'
                      : `${approvalKind(pv)}, ${approvalAsked(a.approvers)}`,
                tone: a.status !== 'pending' ? 'muted' : late ? 'danger' : 'warning',
                href: p.approvals(),
              };
            }),
          }
        : null,
    };
  },

  async list_workflows(db, ctx, args) {
    const calendarId = str(args['calendarId']);
    const { items } = await query<{ items: WorkflowItem[] }>(db, ctx, 'workflow.list', {
      ...(str(args['status']) ? { status: [args['status']] } : {}),
      ...(calendarId ? { calendarId } : {}),
    });
    const twice = calendarId ? await remindsTwice(db, ctx, calendarId, items) : new Set<string>();
    const p = workflowPaths(ctx.workspaceId);
    return {
      result: {
        workflows: items.map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          ...(w.description ? { description: w.description } : {}),
          startsWhen: w.trigger.summary,
          ...(w.allCalendars
            ? { calendars: 'every calendar' }
            : w.calendarIds.length
              ? { calendarIds: w.calendarIds }
              : {}),
          // As the calendar's Automations warns: its own reminders are on, so customers could hear twice.
          ...(twice.has(w.id) ? { remindsTwice: true } : {}),
          // start_workflow takes only these.
          canStartForSomeone: w.trigger.kind === 'manual',
          liveVersion: w.activeVersion?.version ?? null,
          runsLast30Days: w.runs30d,
          runsGoingNow: w.activeRuns,
          ...lastRunOut(w, ctx.timezone),
          source: sourceOut(w.source),
        })),
        ...(items.length
          ? {}
          : {
              note:
                args['status'] === 'archived'
                  ? 'No workflow is archived.'
                  : calendarId
                    ? 'No workflow starts from this calendar yet.'
                    : args['status'] === 'draft'
                      ? 'No workflow is a draft.'
                      : args['status']
                        ? `No workflow is ${args['status'] === 'active' ? 'on' : 'paused'}.`
                        : 'No workflows yet.',
            }),
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
        note: 'A proposal only: nothing changes until it’s applied. Show it, and once the person agrees, apply it with do_workflow_proposal_apply (or they open it and press Apply). A workflow needs a passing test before it is published.',
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

  /** New workflow's recipes as their cards and previews say them, with Fill in for the business picked as the page does. */
  async list_workflow_recipes(db, ctx) {
    const { catalogs } = await query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs');
    return {
      result: {
        recipes: WORKFLOW_RECIPES.map((r) => {
          const mapping = suggestMapping(r.placeholders, catalogs);
          const def = resolvePlaceholders(recipeDefinition(r.key), mapping);
          const card = RECIPE_CARDS[r.key];
          return {
            recipeKey: r.key,
            name: r.name,
            category: card.category,
            short: card.short,
            whatItDoes: r.description,
            note: card.note,
            startsWhen: describeTrigger(def.trigger, catalogs),
            steps: def.steps.map((s) => describeStep(s, catalogs, def)),
            fillIn: r.placeholders.length
              ? r.placeholders.map((ph) => {
                  const picked = mapping[ph.key];
                  const choices = placeholderChoices(ph.kind, catalogs);
                  return {
                    key: ph.key,
                    asks: ph.label,
                    picked: picked
                      ? { id: picked, name: refName(ph.kind, picked, catalogs) }
                      : 'Pick later: nothing here fits yet',
                    ...(choices.length > 1
                      ? { choices: choices.slice(0, 12).map((c) => ({ id: c.id, name: c.name })) }
                      : {}),
                  };
                })
              : 'Nothing to fill in',
            ...(r.placeholders.length ? { mapping } : {}),
          };
        }),
        note: 'Anything left to pick shows in Checks, and blocks publishing until it’s set.',
      },
    };
  },

  /** Review update on a copy of an agency template: what applying would do. Nothing changes. */
  async review_template_update(db, ctx, args) {
    const { wf, update } = await templateUpdate(db, ctx, args['workflowId']);
    return {
      result: {
        workflow: wf.name,
        template: update.templateName,
        installedVersion: update.installedVersion,
        latestVersion: update.latestVersion,
        updateAvailable: update.updateAvailable,
        ...templateUpdateWords(update),
        ...(update.updateAvailable
          ? {
              whatTheDraftBecomes: update.changes,
              baseRevision: update.revision,
              toApply: 'apply_template_update with this baseRevision, once the person agrees',
            }
          : {}),
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

/**
 * Whether the workflow takes this customer now, as "Add to workflow…" says it: their runs of it against its Re-entry
 * setting (once, after they finish, or any time at most so often). The engine skips a start these rule out quietly.
 */
async function notAgain(
  db: Db,
  ctx: ToolContext,
  wf: WorkflowItem,
  def: WorkflowDefinition,
  personId: unknown,
  fullName: string,
): Promise<string | null> {
  const { items } = await query<{ items: { status: RunStatus; startedAt: string }[] }>(
    db,
    ctx,
    'workflow.run_list',
    { workflowId: wf.id, personId, limit: 20 },
  );
  const reentry = def.settings.reentry;
  const { ok, note } = workflowAvailability(
    {
      status: wf.status,
      reentry: reentry.mode,
      cooldown: reentry.mode === 'always' ? reentry.cooldown : null,
    },
    items,
    firstName(fullName),
    ctx.timezone,
  );
  return ok ? null : note;
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
    const blocked =
      notLive(wf, 'active') ??
      notByHand(wf) ??
      (await notAgain(db, ctx, wf, def, args['personId'], person.fullName));
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
    const again = await notAgain(
      db,
      ctx,
      wf,
      (await liveDefinition(db, ctx, wf)).def,
      args['personId'],
      person.fullName,
    );
    if (again) throw HfosError.conflict(again, 'workflow_not_again');
    await command(db, ctx, 'workflow.enrol', {
      workflowId: args['workflowId'],
      personId: args['personId'],
    });
    return {
      outcome: `“${wf.name}” starts for ${person.fullName} in a moment.`,
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

/**
 * The approver's new words, by the key each AI-written text is kept under: `edits` names them, and `message` is the
 * one text of an approval that has a single one (or its first). Only keys the approval has are sent; an unknown one is
 * refused, naming the ones it has. Null when nothing differs from what the AI wrote.
 */
function approvalEdits(
  p: ReturnType<typeof approvalPreviewOf>,
  args: Args,
): Record<string, string> | null {
  if (args['decision'] === 'reject' || !p.fields.length) return null;
  const raw = args['edits'];
  const given =
    raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>).flatMap(([k, v]) => {
          const text = str(v);
          return text ? [[k, text] as const] : [];
        })
      : [];
  const keys = p.fields.map(([k]) => k);
  const unknown = given.filter(([k]) => !keys.includes(k)).map(([k]) => k);
  if (unknown.length)
    throw HfosError.validation(
      [{ path: 'edits', message: 'Use the keys of its AI-written texts.' }],
      `This approval has no AI-written text called ${unknown.join(' or ')}. Its texts are ${keys.join(', ')}: list_workflow_approvals shows each.`,
    );
  const out: Record<string, string> = Object.fromEntries(given);
  const message = str(args['message']);
  const first = keys[0]!;
  if (message && !(first in out)) out[first] = message;
  const changed = Object.entries(out).filter(
    ([k, v]) => p.fields.find(([f]) => f === k)?.[1] !== v,
  );
  return changed.length ? Object.fromEntries(changed) : null;
}

const answerApproval: WorkflowConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const a = await pendingApproval(db, ctx, args['approvalId']);
    const p = approvalPreviewOf(a);
    const approve = args['decision'] !== 'reject';
    const what = approvalKind(p);
    const who = approvalCustomerOf(a, p);
    const edits = approve ? approvalEdits(p, args) : null;
    // What goes out: each AI-written text, with the approver's words where they changed it.
    const texts = p.fields.map(([key, text]) => [key, edits?.[key] ?? text] as const);
    // Past its expiry the approval step's own path has taken over, and the command refuses a decision.
    const blocked = approvalExpired(a)
      ? APPROVALS_WORDS.expiredInfo
      : a.canDecide
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
          // An approval with more than one AI-written text shows each one, by what it is.
          ...(texts.length > 1
            ? texts.map(([key, text]) => ({ label: approvalFieldLabel(p, key), value: text }))
            : []),
          ...(edits ? [{ label: 'Edited', value: 'Your words go instead of the AI’s' }] : []),
          ...(!approve && str(args['reason'])
            ? [{ label: 'Reason', value: String(args['reason']) }]
            : []),
        ],
        body: texts.length === 1 ? texts[0]![1] : null,
        warnings: blocked
          ? [{ kind: 'blocked', text: blocked }]
          : approve && what !== 'the next step'
            ? // It reaches the customer: the card says so before anyone confirms.
              [
                {
                  kind: 'caution',
                  text: `${what === 'a text' ? 'The text' : 'The email'} goes to ${who} once you confirm.`,
                },
              ]
            : [],
        confirmLabel: blocked
          ? ''
          : approve
            ? texts.length
              ? 'Approve and send'
              : 'Approve'
            : 'Reject',
      }),
      result: {
        workflow: a.workflow.name,
        customer: who,
        decision: approve ? 'approve' : 'reject',
        whatGoesOut: what,
        // The words that go once it's approved: the AI's, with any edit in place.
        ...(texts.length
          ? { text: Object.fromEntries(texts.map(([k, t]) => [k, { ai_wrote: t }])) }
          : {}),
        ...(edits ? { edited: Object.keys(edits) } : {}),
        ...(blocked ? { cannotDecide: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const a = await pendingApproval(db, ctx, args['approvalId']);
    const p = approvalPreviewOf(a);
    const approve = args['decision'] !== 'reject';
    const edits = approve ? approvalEdits(p, args) : null;
    await command(db, ctx, 'workflow.decide_approval', {
      approvalId: a.id,
      decision: approve ? 'approve' : 'reject',
      ...(edits ? { edits } : {}),
      ...(!approve && str(args['reason']) ? { reason: String(args['reason']) } : {}),
    });
    const who = approvalCustomerOf(a, p);
    const what = approvalKind(p);
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

/** What the person asked to add, checked against the knowledge base's own limits so the card never shows what can't be saved. */
function newItemOf(args: Record<string, unknown>) {
  const kind = kindOf(args['kind']);
  const title = String(args['title'] ?? '').trim();
  const body = String(args['body'] ?? '').trim();
  const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : [];
  const parsed = KnowledgeWritableContent.safeParse(
    kind === 'faq' ? { kind, question: title, answer: body, tags } : { kind, title, body, tags },
  );
  if (!parsed.success)
    throw HfosError.validation(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      parsed.error.issues[0]?.message ??
        'That can’t be saved as it is. Check the title, text and tags, then try again.',
    );
  return { kind, title, body, tags, content: parsed.data };
}

const addKnowledgeItem: WorkflowConfirmTool = {
  async prepare(_db, _ctx, args, toolCallId) {
    const { kind, title, body, tags } = newItemOf(args);
    const publish = args['publish'] === true;
    return {
      card: confirmCard(toolCallId, 'add_knowledge_item', {
        title: `Add this ${KIND_WORD[kind]} to your knowledge base?`,
        fields: [
          { label: kind === 'faq' ? 'Question' : 'Title', value: title },
          ...(tags.length ? [{ label: 'Tags', value: tags.join(', ') }] : []),
          {
            label: 'Saved as',
            value: publish
              ? 'Published: AI steps and the Assistant use it'
              : 'A draft: nothing uses it until it’s published',
          },
        ],
        body,
        warnings: [],
        confirmLabel: publish ? 'Publish' : 'Save draft',
      }),
      result: { kind, title, status: publish ? 'published' : 'draft' },
    };
  },
  async commit(db, ctx, args) {
    const { title, content } = newItemOf(args);
    const publish = args['publish'] === true;
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

/** Apply the update: the agency template's newest version as a draft revision of the copy, never straight to live. */
const applyTemplateUpdate: WorkflowConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { wf, update: p } = await templateUpdate(db, ctx, args['workflowId']);
    const blocked =
      wf.status === 'archived'
        ? `“${wf.name}” is archived, so it can’t be updated.`
        : !p.updateAvailable
          ? 'This copy already has the newest version.'
          : p.revision !== Number(args['baseRevision'])
            ? 'Your draft changed a moment ago. Ask me to review the update again.'
            : null;
    const warnings: Warning[] = blocked
      ? [{ kind: 'blocked', text: blocked }]
      : [
          ...(p.dropped.length
            ? [
                {
                  kind: 'caution',
                  text: `These changes of yours no longer fit, so they go: ${p.dropped.join('; ')}`,
                },
              ]
            : []),
          ...(p.unmapped.length ? [{ kind: 'caution', text: pickAfterwards(p) }] : []),
          {
            kind: 'note',
            text: 'Applying makes a draft of your copy. You test it and publish it, like any change. What runs now keeps running until then.',
          },
        ];
    return {
      card: confirmCard(toolCallId, 'apply_template_update', {
        title: `Update “${wf.name}” to version ${p.latestVersion} of “${p.templateName}”?`,
        fields: [
          ...(p.templateChanges.length
            ? changeFields(p.templateChanges)
            : [{ label: 'Change', value: 'Nothing in the steps; the details only.' }]),
          ...(p.kept.length ? [{ label: 'Your changes stay', value: p.kept.join('; ') }] : []),
        ],
        body: null,
        warnings,
        confirmLabel: blocked ? '' : 'Apply the update',
      }),
      result: {
        workflow: wf.name,
        ...templateUpdateWords(p),
        ...(blocked ? { cannotApply: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    const scope = await managesWorkflows(db, ctx);
    const { output } = await executeCommand(
      db,
      workflowTemplateApplyUpdate,
      { workspaceId: ctx.workspaceId, workflowId: wf.id, baseRevision: args['baseRevision'] },
      systemActor(scope, ctx.actor.userId),
      { correlationId: ctx.correlationId, channel: 'assistant' },
    );
    return {
      outcome: `Updated “${wf.name}” to version ${output.version}. Test it, then publish it.`,
      href: workflowPaths(ctx.workspaceId).workflow(wf.id),
      command: workflowTemplateApplyUpdate.name,
      answer: {
        draftRevision: output.revision,
        changes: output.changes,
        kept: output.kept,
        dropped: output.dropped,
        ...(output.unmapped.length ? { stillToPick: output.unmapped } : {}),
      },
    };
  },
};

export const workflowConfirmTools: Record<string, WorkflowConfirmTool> = {
  apply_template_update: applyTemplateUpdate,
  start_workflow: startWorkflow,
  pause_workflow: pauseWorkflow,
  resume_workflow: resumeWorkflow,
  remove_contact_from_workflow: removeContact,
  answer_workflow_approval: answerApproval,
  add_knowledge_item: addKnowledgeItem,
};

// ---------- the editor's own commands, on cards of their own ----------

/**
 * A screen command drawn on a card of its own (tools-screen-actions.ts), as the editor's dialog says it, keyed by the
 * command's name so it stays a screen action: the rehearsal has passed when `prepare` runs, and `done` says what
 * happened once the command ran.
 */
export interface ScreenActionCard {
  prepare(
    db: Db,
    ctx: ToolContext,
    args: Args,
    tool: { readonly name: string; readonly toolCallId: string },
  ): Promise<PreparedAction>;
  done(
    db: Db,
    ctx: ToolContext,
    args: Args,
    output: Record<string, unknown>,
  ): Promise<{ outcome: string; href: string | null; answer?: Record<string, unknown> }>;
}

/** A workflow with its published versions, newest first, as History lists them. */
async function withVersions(db: Db, ctx: ToolContext, workflowId: unknown) {
  return query<{
    workflow: WorkflowDetail;
    versions: { id: string; version: number; diff: string[] }[];
  }>(db, ctx, 'workflow.get', { workflowId });
}

/** Change lines as a card's fields: Change, then Then, eight at most. */
function changeFields(lines: readonly string[]) {
  const shown =
    lines.length > 8
      ? [...lines.slice(0, 7), `And ${plural(lines.length - 7, 'more change')}`]
      : lines;
  return shown.map((value, i) => ({ label: i === 0 ? 'Change' : 'Then', value }));
}

/** Publish version N?: what changes from the live version, that runs going finish on it, and staying paused. */
const publishCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const [{ workflow: wf, versions }, { catalogs }] = await Promise.all([
      withVersions(db, ctx, args['workflowId']),
      query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs'),
    ]);
    const draft = parseDefinition(wf.definition);
    const next = (versions[0]?.version ?? 0) + 1;
    const live = wf.activeVersion;
    const liveDef = live ? (await liveDefinition(db, ctx, wf)).def : null;
    const changes = liveDef ? describeOps(diffWorkflows(liveDef, draft), liveDef, catalogs) : [];
    const same = !!live && live.id === versions[0]?.id && !changes.length;
    const blocked = same
      ? `Nothing changed since version ${live.version}, so there’s nothing to publish.`
      : null;
    const warnings: Warning[] = blocked
      ? [{ kind: 'blocked', text: blocked }]
      : [
          wf.status === 'paused'
            ? { kind: 'note', text: 'It stays paused until you resume it.' }
            : {
                kind: 'caution',
                text: 'New runs start on it as soon as it’s published, and reach customers.',
              },
          ...(live
            ? [
                {
                  kind: 'note',
                  text: `Runs already in progress finish on version ${live.version}.`,
                },
              ]
            : []),
        ];
    return {
      card: confirmCard(tool.toolCallId, tool.name, {
        title: `Publish version ${next} of “${wf.name}”?`,
        fields: live
          ? changeFields(changes)
          : [
              {
                label: 'First version',
                value:
                  'Published versions never change: each change after this is tested and published as a new version.',
              },
            ],
        body: null,
        warnings,
        confirmLabel: blocked ? '' : `Publish version ${next}`,
      }),
      result: {
        workflow: wf.name,
        version: next,
        ...(live ? { changesFromVersion: { [live.version]: changes } } : { firstVersion: true }),
        ...(blocked ? { cannotPublish: blocked } : {}),
      },
    };
  },
  async done(db, ctx, args, output) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    const version = Number(output['version']);
    return {
      outcome:
        output['status'] === 'paused'
          ? `Version ${version} of “${wf.name}” is published. It stays paused until you resume it.`
          : `Version ${version} of “${wf.name}” is live.`,
      href: workflowPaths(ctx.workspaceId).workflow(wf.id),
    };
  },
};

/** Restore version N?: what changes in the draft, and that it needs a new test. */
const restoreCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const version = Number(args['version']);
    const [wf, { catalogs }, { version: v }] = await Promise.all([
      workflowGet(db, ctx, args['workflowId']),
      query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs'),
      query<{ version: { definition: unknown } }>(db, ctx, 'workflow.version_get', {
        workflowId: args['workflowId'],
        version,
      }),
    ]);
    const draft = parseDefinition(wf.definition);
    const changes = describeOps(
      diffWorkflows(draft, parseDefinition(v.definition)),
      draft,
      catalogs,
    );
    const blocked = changes.length ? null : 'The draft already matches this version.';
    return {
      card: confirmCard(tool.toolCallId, tool.name, {
        title: `Bring version ${version} of “${wf.name}” back into the draft?`,
        fields: changeFields(changes),
        body: null,
        warnings: blocked
          ? [{ kind: 'blocked', text: blocked }]
          : [
              {
                kind: 'note',
                text: 'Only the draft changes. It needs a new test before it can be published.',
              },
            ],
        confirmLabel: blocked ? '' : 'Restore',
      }),
      result: {
        workflow: wf.name,
        version,
        whatChangesInTheDraft: changes,
        ...(blocked ? { nothingToDo: blocked } : {}),
      },
    };
  },
  async done(db, ctx, args) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    return {
      outcome: `Version ${Number(args['version'])} of “${wf.name}” is back in the draft. Test it again before you publish.`,
      href: workflowPaths(ctx.workspaceId).workflow(wf.id),
    };
  },
};

/** What a test takes as given (do_workflow_test's assume), in the Test tab's words. */
function assumedLines(assume: unknown, def: WorkflowDefinition, names: WorkflowCatalogs): string[] {
  if (!assume || typeof assume !== 'object') return [];
  return Object.entries(assume as Record<string, unknown>).map(([key, value]) => {
    if (key === 'wait.timed_out')
      return value === false
        ? 'When it waits: the reply or booking comes'
        : 'When it waits: it times out';
    if (key.startsWith('branch.')) {
      const step = findStep(def, key.slice('branch.'.length))?.step;
      const path = step?.type === 'branch' ? step.branches.find((b) => b.id === value) : undefined;
      return step
        ? `Path at “${runStepTitle(step, names, def)}”: ${path?.name ?? 'as the conditions decide'}`
        : `${key}: ${String(value)}`;
    }
    if (key.startsWith('ai.')) return `The AI sorts it as ${String(value)}`;
    return `${key}: ${String(value)}`;
  });
}

/** Run test: Simulate or Send to me, the test contact, what it takes as given; then how to see how it went. */
const testCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const [wf, { catalogs }, person] = await Promise.all([
      workflowGet(db, ctx, args['workflowId']),
      query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs'),
      str(args['personId'])
        ? query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
            personId: args['personId'],
          }).then((p) => p.person)
        : Promise.resolve(null),
    ]);
    const draft = parseDefinition(wf.definition);
    const send = args['mode'] === 'send_to_me';
    const given = assumedLines(args['assume'], draft, catalogs);
    return {
      card: confirmCard(tool.toolCallId, tool.name, {
        title: `Test “${wf.name}”?`,
        fields: [
          {
            label: send ? 'Send to me' : 'Simulate',
            value: send
              ? 'Sends only to you, with 5-second waits'
              : 'Sends nothing and skips the waits. AI steps run for real.',
          },
          { label: 'Draft', value: `Revision ${wf.revision}` },
          {
            label: 'Test contact',
            value: person
              ? `${person.fullName}: their details fill in the messages${send ? ', but everything goes to you' : '. They aren’t contacted'}`
              : 'Sample details',
          },
          ...(given.length ? [{ label: 'Takes as given', value: given.join('; ') }] : []),
        ],
        body: null,
        warnings: [
          { kind: 'note', text: 'Tests never reach your customers or count in the stats.' },
        ],
        confirmLabel: 'Run test',
      }),
      result: {
        workflow: wf.name,
        mode: send ? 'Send to me' : 'Simulate',
        draftRevision: wf.revision,
        ...(given.length ? { takesAsGiven: given } : {}),
      },
    };
  },
  async done(db, ctx, args, output) {
    const wf = await workflowGet(db, ctx, args['workflowId']);
    // The engine starts the test run from the request's event, usually a moment later.
    const { items } = await query<{ items: { id: string }[] }>(db, ctx, 'workflow.run_list', {
      workflowId: wf.id,
      onlyTests: true,
      ...(str(output['eventId']) ? { triggerEventId: output['eventId'] } : {}),
      limit: 1,
    }).catch(() => ({ items: [] as { id: string }[] }));
    const runId = str(output['eventId']) ? (items[0]?.id ?? null) : null;
    return {
      outcome: `The test of “${wf.name}” is running. Ask me how it went, or watch it on its Test tab.`,
      href: workflowPaths(ctx.workspaceId).workflow(wf.id),
      answer: {
        ...output,
        ...(runId ? { runId } : {}),
        howItWent:
          'get_workflow’s latestTest says how it came out; get_workflow_run reads it step by step.',
      },
    };
  },
};

export const workflowScreenCards: Readonly<Record<string, ScreenActionCard>> = {
  // By the commands' own names: they stay screen actions (coverage.ts), drawn here as their dialogs say them.
  [workflowPublish.name]: publishCard,
  [workflowRestoreVersion.name]: restoreCard,
  [workflowTest.name]: testCard,
};
