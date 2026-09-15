/**
 * The AI teammate (M7): creating it from a preset, saving its settings (checked against the revision the draft
 * started from, with a revision row and a summary of what changed), restoring an old revision (the training
 * counts never move), turning it off, into training or automatic, and deciding its drafts once.
 *
 * Deciding a draft runs as the person (their OK is what counts), and an approved draft goes out as the
 * teammate: `ai_teammate.draft_decided` tells the worker, which runs `ai_teammate.send_draft` in its own
 * transaction. The database lets only the worker record the teammate's events and messages, so the two can't
 * share the person's transaction.
 */
import { and, asc, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { rows, sql } from '@hfos/db/client';
import {
  aiTeammateDrafts,
  aiTeammateRevisions,
  aiTeammates,
  calendars,
  chatWidgets,
  messages,
  workspaces,
} from '@hfos/db/schema';
import {
  parseTeammateConfig,
  TeammateConfigVersionError,
  type TeammateConfig,
} from '../ai-team/config';
import { diffTeammateConfigs } from '../ai-team/diff';
import { inferTeammateLabels } from '../ai-team/labels';
import {
  loadTeammate,
  loadTeammateCatalogs,
  requireTeammate,
  teammateConfigOf,
  teammateProgressOf,
  teammateUserIds,
} from '../ai-team/load';
import { TEAMMATE_PRESETS, teammateConfigFromPreset } from '../ai-team/presets';
import { hasBlockingTeammateIssues, validateTeammate } from '../ai-team/rules';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandIn } from '../kernel/execute';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { AiEmployeeActor, CommandContext } from '../kernel/types';
import { workspaceAddresses } from '../messaging/email';
import { hasWorkspacePermission } from '../permissions';
import {
  AiTeammateCreateInput,
  AiTeammateCreateOutput,
  AiTeammateDecideDraftInput,
  AiTeammateDecideDraftOutput,
  AiTeammateRestoreInput,
  AiTeammateSaveConfigInput,
  AiTeammateSaveOutput,
  AiTeammateSendDraftInput,
  AiTeammateSendDraftOutput,
  AiTeammateSetStatusInput,
  AiTeammateSetStatusOutput,
  TeammateDraftEdits,
  TeammateDraftPreview,
} from '../schemas/ai-team';
import {
  appointmentBookForCustomer,
  attendeeCancelForCustomer,
  attendeeRescheduleForCustomer,
} from './appointment-ai';
import { messageSend } from './message';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** A settings document as the database stores it. */
const stored = (config: TeammateConfig) => config as unknown as Record<string, unknown>;

/** A settings document that doesn't parse, as field errors under `config`. */
function configError(e: unknown): unknown {
  if (e instanceof ZodError)
    return HfosError.validation(
      e.issues.map((i) => ({ path: ['config', ...i.path].join('.'), message: i.message })),
    );
  if (e instanceof TeammateConfigVersionError)
    return HfosError.validation([{ path: 'config.version', message: e.message }]);
  return e;
}

function parseConfig(raw: unknown): TeammateConfig {
  try {
    return parseTeammateConfig(raw);
  } catch (e) {
    throw configError(e);
  }
}

/**
 * The save path (save and restore): refuses a stale draft, writes the settings, labels and name, and a
 * revision row with what changed. Settings conflicts never block a save (they block turning it on). The
 * training counts are no part of it.
 */
async function saveTeammate(
  ctx: CommandContext,
  args: {
    readonly teammateId: string;
    readonly baseRevision: number;
    readonly next: TeammateConfig;
    readonly restoredFrom?: number;
  },
) {
  const me = requireHuman(ctx).userId;
  const ws = ctx.scope.workspaceId!;
  const current = await requireTeammate(ctx.tx, ws, args.teammateId, { forUpdate: true });
  if (current.revision !== args.baseRevision)
    throw new HfosError(
      'conflict',
      409,
      'Someone saved these settings in the meantime. Reload to see their changes.',
      { revision: current.revision },
      'revision_conflict',
    );
  const prev = teammateConfigOf(current);
  const { next } = args;
  const unchanged = JSON.stringify(prev) === JSON.stringify(next);
  if (unchanged && current.name === next.identity.name && !args.restoredFrom)
    return {
      teammateId: current.id,
      revision: current.revision,
      labels: current.labels,
      changes: [],
    };
  const catalogs = await loadTeammateCatalogs(ctx.tx, ws, {
    extraUserIds: [...teammateUserIds(prev), ...teammateUserIds(next)],
  });
  const diff = diffTeammateConfigs(prev, next, catalogs);
  const changes = [
    ...(args.restoredFrom ? [`Restored revision ${args.restoredFrom}`] : []),
    ...(diff.length || unchanged ? diff : ['Settings changed']),
  ];
  const labels = [...inferTeammateLabels(next).tags];
  const revision = current.revision + 1;
  await ctx.tx
    .update(aiTeammates)
    .set({
      name: next.identity.name,
      config: stored(next),
      configVersion: next.version,
      revision,
      labels,
    })
    .where(eq(aiTeammates.id, current.id));
  await ctx.tx.insert(aiTeammateRevisions).values({
    workspaceId: ws,
    teammateId: current.id,
    revision,
    config: stored(next),
    configVersion: next.version,
    labels,
    diffSummary: changes as unknown as Record<string, unknown>[],
    changedBy: me,
  });
  await ctx.emit({
    type: 'ai_teammate.config_saved',
    entityType: 'ai_teammate',
    entityId: current.id,
    payload: {
      teammateId: current.id,
      revision,
      changes: changes.slice(0, 50),
      ...(args.restoredFrom ? { restoredFrom: args.restoredFrom } : {}),
    },
    before: { revision: current.revision },
    after: { name: next.identity.name, revision, changes: changes.slice(0, 20) },
  });
  return { teammateId: current.id, revision, labels, changes };
}

export const aiTeammateCreate = defineCommand({
  name: 'ai_teammate.create',
  description:
    'Set up the business’s AI teammate from a preset (or blank), with its name and how it says it’s AI. It starts off; turn it on when its settings are ready.',
  risk: 2,
  input: AiTeammateCreateInput,
  output: AiTeammateCreateOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['ai_teammate.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const exists = () =>
      HfosError.conflict('This business already has an AI teammate.', 'teammate_exists');
    if (await loadTeammate(ctx.tx, ws)) throw exists();
    const [workspace] = await ctx.tx
      .select({ industry: workspaces.industry })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    // The default address first, the oldest widget, and the calendars customers can book online.
    const address = (await workspaceAddresses(ctx.tx, ws)).find((a) => a.usable) ?? null;
    const [widget] = await ctx.tx
      .select({ id: chatWidgets.id })
      .from(chatWidgets)
      .where(and(eq(chatWidgets.workspaceId, ws), isNull(chatWidgets.pausedAt)))
      .orderBy(asc(chatWidgets.createdAt))
      .limit(1);
    const open = await ctx.tx
      .select({ id: calendars.id })
      .from(calendars)
      .where(
        and(
          eq(calendars.workspaceId, ws),
          eq(calendars.public, true),
          eq(calendars.status, 'active'),
        ),
      )
      .orderBy(asc(calendars.name));
    const config = teammateConfigFromPreset(input.preset, {
      name: input.name,
      disclosure: input.disclosure,
      industry: workspace?.industry ?? null,
      emailAddressId: address?.id ?? null,
      widgetId: widget?.id ?? null,
      calendarIds: open.map((c) => c.id),
    });
    const labels = [...inferTeammateLabels(config).tags];
    const preset = TEAMMATE_PRESETS.find((p) => p.key === input.preset)!;
    let teammateId: string;
    try {
      const [row] = await ctx.tx
        .insert(aiTeammates)
        .values({
          workspaceId: ws,
          name: config.identity.name,
          status: 'off',
          config: stored(config),
          configVersion: config.version,
          revision: 1,
          labels,
          createdBy: me,
        })
        .returning({ id: aiTeammates.id });
      teammateId = row!.id;
    } catch (e) {
      if (isUniqueViolation(e, 'ai_teammates_one_live')) throw exists();
      throw e;
    }
    await ctx.tx.insert(aiTeammateRevisions).values({
      workspaceId: ws,
      teammateId,
      revision: 1,
      config: stored(config),
      configVersion: config.version,
      labels,
      diffSummary: [
        preset.key === 'blank' ? 'Created from scratch' : `Created as a ${preset.name}`,
      ] as unknown as Record<string, unknown>[],
      changedBy: me,
    });
    await ctx.emit({
      type: 'ai_teammate.created',
      entityType: 'ai_teammate',
      entityId: teammateId,
      payload: { teammateId, preset: input.preset, name: config.identity.name },
      after: { name: config.identity.name, preset: preset.name, labels },
    });
    return { teammateId, revision: 1 };
  },
});

export const aiTeammateSaveConfig = defineCommand({
  name: 'ai_teammate.save_config',
  description:
    'Save the AI teammate’s settings as a new revision. Refuses a stale draft (revision_conflict); settings conflicts never block a save, only turning it on.',
  risk: 2,
  input: AiTeammateSaveConfigInput,
  output: AiTeammateSaveOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['ai_teammate.config_saved'],
  async handler(ctx, input) {
    return saveTeammate(ctx, {
      teammateId: input.teammateId,
      baseRevision: input.baseRevision,
      next: parseConfig(input.config),
    });
  },
});

export const aiTeammateRestore = defineCommand({
  name: 'ai_teammate.restore',
  description:
    'Bring back an earlier revision of the AI teammate’s settings. It’s saved again as a new revision; its training progress stays as it is.',
  risk: 2,
  input: AiTeammateRestoreInput,
  output: AiTeammateSaveOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['ai_teammate.config_saved'],
  async handler(ctx, input) {
    const [rev] = await ctx.tx
      .select({ config: aiTeammateRevisions.config })
      .from(aiTeammateRevisions)
      .where(
        and(
          eq(aiTeammateRevisions.workspaceId, ctx.scope.workspaceId!),
          eq(aiTeammateRevisions.teammateId, input.teammateId),
          eq(aiTeammateRevisions.revision, input.revision),
        ),
      );
    if (!rev) throw HfosError.notFound('That version wasn’t found.');
    return saveTeammate(ctx, {
      teammateId: input.teammateId,
      baseRevision: input.baseRevision,
      next: parseConfig(rev.config),
      restoredFrom: input.revision,
    });
  },
});

export const aiTeammateSetStatus = defineCommand({
  name: 'ai_teammate.set_status',
  description:
    'Turn the AI teammate off, put it in training (every message waits for a person’s OK), or make it automatic (“Switch to automatic now”). Turning it on is refused while its settings conflict; “Back to training” starts the count again.',
  risk: 2,
  input: AiTeammateSetStatusInput,
  output: AiTeammateSetStatusOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['ai_teammate.status_changed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const current = await requireTeammate(ctx.tx, ws, input.teammateId, { forUpdate: true });
    if (current.status === input.status)
      return { teammateId: current.id, progress: teammateProgressOf(current) };
    if (current.status === 'off') {
      const config = teammateConfigOf(current);
      const catalogs = await loadTeammateCatalogs(ctx.tx, ws, {
        extraUserIds: teammateUserIds(config),
      });
      const issues = validateTeammate(config, catalogs, Date.now());
      if (hasBlockingTeammateIssues(issues))
        throw new HfosError(
          'rule_violation',
          422,
          `Fix ${current.name}’s settings before turning it on.`,
          { issues },
          'teammate_issues',
        );
    }
    // The guard trigger does what each move means for the counts (automatic → training starts them again).
    const [row] = await ctx.tx
      .update(aiTeammates)
      .set({ status: input.status })
      .where(eq(aiTeammates.id, current.id))
      .returning();
    await ctx.emit({
      type: 'ai_teammate.status_changed',
      entityType: 'ai_teammate',
      entityId: current.id,
      payload: {
        teammateId: current.id,
        from: current.status,
        to: row!.status,
        via: row!.automaticVia ?? null,
      },
      before: { status: current.status },
      after: {
        name: current.name,
        status: row!.status,
        ...(row!.automaticVia ? { via: row!.automaticVia } : {}),
      },
    });
    return { teammateId: current.id, progress: teammateProgressOf(row!) };
  },
});

type Decision = {
  status: 'off' | 'training' | 'automatic';
  approved_count: number;
  edited_count: number;
  rejected_count: number;
  approvals_needed: number;
  became_automatic: boolean;
};

export const aiTeammateDecideDraft = defineCommand({
  name: 'ai_teammate.decide_draft',
  description:
    'Approve (optionally editing the message) or reject one of the AI teammate’s drafts, once. A reply draft counts toward training; an approved draft then goes out as the teammate with your name on it.',
  risk: 2,
  input: AiTeammateDecideDraftInput,
  output: AiTeammateDecideDraftOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['ai_teammate.draft_decided', 'ai_teammate.status_changed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [d] = await ctx.tx
      .select()
      .from(aiTeammateDrafts)
      .where(and(eq(aiTeammateDrafts.id, input.draftId), eq(aiTeammateDrafts.workspaceId, ws)));
    if (!d) throw HfosError.notFound('Draft not found.');
    // Reply drafts are the inbox's; what the teammate asks approval for (a discount) is a manager's.
    if (d.kind === 'approval' && !hasWorkspacePermission(ctx.scope.workspaceRole, 'ai_team.manage'))
      throw HfosError.forbidden(
        'Only owners and admins decide what the AI teammate asks approval for.',
        'not_an_approver',
      );
    const decided = () => HfosError.conflict('This was already decided.', 'draft_decided');
    if (d.status !== 'pending') throw decided();
    if (d.expiresAt && d.expiresAt.getTime() <= Date.now())
      throw HfosError.conflict('This draft expired.', 'draft_expired');
    // A draft answers what the customer had said when it was written; once they've written again it may
    // not fit. The teammate writes a new one for the new message.
    if (d.conversationId) {
      const [newer] = await ctx.tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, d.conversationId),
            eq(messages.direction, 'inbound'),
            gt(messages.createdAt, d.createdAt),
          ),
        )
        .limit(1);
      if (newer)
        throw HfosError.rule(
          'customer_wrote_again',
          409,
          'The customer wrote again after this draft, so it may not fit anymore. A new draft will answer them.',
        );
    }
    const status = input.decision === 'approve' ? ('approved' as const) : ('rejected' as const);
    const edits =
      status === 'approved' && input.edits && Object.keys(input.edits).length ? input.edits : null;
    // Claimed once: a second click (or a race) matches no pending row.
    const [claimed] = await ctx.tx
      .update(aiTeammateDrafts)
      .set({
        status,
        edits,
        reason: input.reason ?? null,
        decidedBy: me,
        decidedAt: dsql`now()`,
        via: ctx.meta.channel === 'assistant' ? 'assistant' : 'web',
      })
      .where(and(eq(aiTeammateDrafts.id, d.id), eq(aiTeammateDrafts.status, 'pending')))
      .returning({ id: aiTeammateDrafts.id });
    if (!claimed) throw decided();
    // Reply drafts are training: each decision counts, and the count can turn the teammate automatic.
    let becameAutomatic = false;
    if (d.kind === 'reply') {
      const [r] = await rows<Decision>(
        ctx.tx,
        sql`select * from private.record_teammate_decision(${d.teammateId}::uuid, ${status}, ${edits !== null})`,
      );
      becameAutomatic = r?.became_automatic ?? false;
    }
    const teammate = await requireTeammate(ctx.tx, ws, d.teammateId);
    await ctx.emit({
      type: 'ai_teammate.draft_decided',
      entityType: 'ai_teammate_draft',
      entityId: d.id,
      payload: {
        draftId: d.id,
        teammateId: d.teammateId,
        conversationId: d.conversationId,
        personId: d.personId,
        kind: d.kind,
        decision: status,
        edited: edits !== null,
        reason: input.reason ?? null,
        becameAutomatic,
      },
      before: { status: 'pending' },
      after: {
        teammate: teammate.name,
        decision: status === 'approved' ? 'Approved' : 'Rejected',
        ...(edits ? { edited: true } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    if (becameAutomatic)
      await ctx.emit({
        type: 'ai_teammate.status_changed',
        entityType: 'ai_teammate',
        entityId: d.teammateId,
        payload: { teammateId: d.teammateId, from: 'training', to: 'automatic', via: 'threshold' },
        before: { status: 'training' },
        after: { name: teammate.name, status: 'automatic', via: 'threshold' },
      });
    return {
      draftId: d.id,
      status,
      progress: { ...teammateProgressOf(teammate), becameAutomatic },
    };
  },
});

export const aiTeammateSendDraft = defineCommand({
  name: 'ai_teammate.send_draft',
  description:
    'Worker: carry out an approved draft as the AI teammate, with the approver’s name on it: its held-back bookings, moves and cancellations in order, then its message. All or nothing, and once: a retry finds it sent.',
  risk: 2,
  input: AiTeammateSendDraftInput,
  output: AiTeammateSendDraftOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['ai_teammate.draft_sent'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // Locked, so a second delivery of the approval waits here and then finds it sent.
    const [d] = await ctx.tx
      .select()
      .from(aiTeammateDrafts)
      .where(and(eq(aiTeammateDrafts.id, input.draftId), eq(aiTeammateDrafts.workspaceId, ws)))
      .for('update');
    if (!d) throw HfosError.notFound('Draft not found.');
    if (d.status !== 'approved')
      throw HfosError.rule('draft_not_approved', 409, 'Only an approved draft goes out.');
    const [sent] = await ctx.tx
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(and(eq(messages.workspaceId, ws), eq(messages.aiDraftId, d.id)))
      .limit(1);
    // Once: sent_at is set with its actions and message, so a draft with only a reschedule or a
    // cancellation (no message to find) goes out once too.
    if (d.sentAt || sent)
      return {
        draftId: d.id,
        conversationId: sent?.conversationId ?? d.conversationId,
        messageId: sent?.id ?? null,
        actions: [],
        duplicate: true,
      };
    const teammate = await requireTeammate(ctx.tx, ws, d.teammateId);
    const config = teammateConfigOf(teammate);
    const preview = TeammateDraftPreview.parse(d.preview);
    const edits = TeammateDraftEdits.safeParse(d.edits ?? {});
    const edit = edits.success ? edits.data : {};
    const ai: AiEmployeeActor = {
      type: 'ai_employee',
      workspaceId: ws,
      organizationId: ctx.scope.organizationId!,
      teammateId: teammate.id,
      teammateName: teammate.name,
      runId: d.runId,
      conversationId: d.conversationId,
      approvedBy: d.decidedBy,
      origin: null,
      test: false,
    };
    const meta = { ...ctx.meta, channel: 'ai_employee' as const };
    const actions: { kind: 'book' | 'reschedule' | 'cancel'; appointmentId: string }[] = [];
    for (const [i, a] of preview.actions.entries()) {
      if (a.kind === 'book') {
        const r = await executeCommandIn(
          ctx.tx,
          appointmentBookForCustomer,
          {
            workspaceId: ws,
            calendarId: a.calendarId,
            startsAt: a.startsAt,
            serviceId: a.serviceId,
            ...(a.durationMinutes ? { durationMinutes: a.durationMinutes } : {}),
            sessionId: a.sessionId,
            notes: a.notes,
            // Fixed per draft and action, so a retry books once.
            clientId: `${d.id}:${i}`,
          },
          ai,
          meta,
        );
        actions.push({ kind: 'book', appointmentId: r.output.appointmentId });
      } else if (a.kind === 'reschedule') {
        const r = await executeCommandIn(
          ctx.tx,
          attendeeRescheduleForCustomer,
          {
            workspaceId: ws,
            appointmentId: a.appointmentId,
            startsAt: a.startsAt,
            sessionId: a.sessionId,
          },
          ai,
          meta,
        );
        actions.push({ kind: 'reschedule', appointmentId: r.output.appointmentId });
      } else {
        const r = await executeCommandIn(
          ctx.tx,
          attendeeCancelForCustomer,
          { workspaceId: ws, appointmentId: a.appointmentId, reason: a.reason },
          ai,
          meta,
        );
        actions.push({ kind: 'cancel', appointmentId: r.output.appointmentId });
      }
    }
    let messageId: string | null = null;
    let conversationId = d.conversationId;
    if (preview.message) {
      const m = preview.message;
      const r = await executeCommandIn(
        ctx.tx,
        messageSend,
        {
          workspaceId: ws,
          ...(d.conversationId ? { conversationId: d.conversationId } : { personId: d.personId }),
          channel: m.channel,
          body: edit.body ?? m.body,
          ...(m.channel === 'email'
            ? {
                subject: edit.subject ?? m.subject ?? undefined,
                ...(config.channels.emailAddressId
                  ? { emailAddressId: config.channels.emailAddressId }
                  : {}),
              }
            : {}),
          ...(m.inReplyToMessageId ? { inReplyToMessageId: m.inReplyToMessageId } : {}),
          clientId: d.clientId,
        },
        ai,
        meta,
      );
      messageId = r.output.messageId;
      conversationId = r.output.conversationId;
      await ctx.tx.update(messages).set({ aiDraftId: d.id }).where(eq(messages.id, messageId));
    }
    await ctx.tx
      .update(aiTeammateDrafts)
      .set({ sentAt: dsql`now()` })
      .where(eq(aiTeammateDrafts.id, d.id));
    await ctx.emit({
      type: 'ai_teammate.draft_sent',
      entityType: 'ai_teammate_draft',
      entityId: d.id,
      payload: {
        draftId: d.id,
        teammateId: teammate.id,
        conversationId,
        messageId,
        approvedBy: d.decidedBy,
        actions: actions.map((a) => a.kind),
      },
      after: { teammate: teammate.name, actions: actions.length, sent: messageId !== null },
    });
    return { draftId: d.id, conversationId, messageId, actions, duplicate: false };
  },
});
