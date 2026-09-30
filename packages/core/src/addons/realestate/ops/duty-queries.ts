/**
 * Reading duties and documents (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Screens"): one duty whole (what
 * finishes it and what's missing, its proof and its history), the duties someone answers for across their deals
 * (My duties), and a deal's documents. Row security keeps each to the deals the person sees.
 */
import { desc, eq, type SQL } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { defineAddonQuery } from '../../server';
import type { ProofRule, ResolvedDuty } from '../catalog/types';
import { DOCUMENT_KINDS, type DocumentKind } from '../catalog/types';
import { realestateAddon } from '../manifest';
import { gapWords, proofGaps, proofItemWords } from '../proof';
import {
  DocumentListInput,
  DocumentListOutput,
  DutyGetInput,
  DutyGetOutput,
  DutyListInput,
  DutyListOutput,
} from '../schemas';
import { isDoneDuty, isOverdue, OPEN_DUTY_STATUSES, type DutyStatus } from '../states';
import { dutyLog } from '../tables';
import { inWorkspace, loadDeal, userNames } from './common';
import { dealProofFactsOf, evidenceFactsOf, loadDuty } from './duties';

const isoOf = (v: Date | string) => new Date(v).toISOString();
const OPEN = sql.raw(`(${OPEN_DUTY_STATUSES.map((s) => `'${s}'`).join(', ')})`);

export const dutyGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.duty.get',
  description:
    'One duty whole: what it is and why, who answers for it, when it’s due and how that was worked out, what finishes it and what’s still missing, its proof, and everything that happened to it.',
  input: DutyGetInput,
  output: DutyGetOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const { duty, deal } = await loadDuty(ctx, input.dutyId);
    const def = duty.definition as unknown as ResolvedDuty;
    const rule = def.proof as ProofRule | null;
    const evidence = await rows<{
      id: string;
      kind: string;
      document_id: string | null;
      file_id: string | null;
      appointment_id: string | null;
      message_id: string | null;
      body: string | null;
      added_by: string | null;
      added_at: string;
      withdrawn_at: string | null;
      withdrawn_reason: string | null;
      label: string | null;
    }>(
      ctx.tx,
      sql`select e.id, e.kind, e.document_id, e.file_id, e.appointment_id, e.message_id, e.body, e.added_by,
            e.added_at, e.withdrawn_at, e.withdrawn_reason,
            coalesce(d.title, f.name, a.title) as label
          from addon_realestate.duty_evidence e
          left join addon_realestate.documents d on d.id = e.document_id
          left join app.files f on f.id = e.file_id
          left join app.appointments a on a.id = e.appointment_id
          where e.duty_id = ${duty.id}
          order by e.added_at`,
    );
    const log = await ctx.tx
      .select()
      .from(dutyLog)
      .where(eq(dutyLog.dutyId, duty.id))
      .orderBy(desc(dutyLog.at));
    const names = await userNames(ctx, [
      duty.accountableUserId,
      ...evidence.map((e) => e.added_by),
      ...log.map((l) => l.actorUserId),
    ]);
    const who = (id: string | null) =>
      id ? { userId: id, name: names.get(id) ?? 'Former member' } : null;
    const gaps = isDoneDuty(duty.status as DutyStatus)
      ? []
      : proofGaps(rule, await evidenceFactsOf(ctx, duty.id), await dealProofFactsOf(ctx, deal));
    return {
      duty: {
        dutyId: duty.id,
        dealId: deal.recordId,
        dealName: deal.name,
        key: duty.dutyKey,
        pass: duty.pass,
        title: duty.title,
        behavior: def.behavior ?? '',
        phase: def.phase ?? '',
        tracker: duty.tracker,
        status: duty.status as DutyStatus,
        overdue: isOverdue(
          { status: duty.status as DutyStatus, dueAt: duty.dueAt?.toISOString() ?? null },
          Date.now(),
        ),
        materiality: duty.materiality,
        automation: duty.automation,
        accountableRole: duty.accountableRole,
        accountable: who(duty.accountableUserId),
        performers: duty.performers,
        startedBy: duty.startedBy,
        startedAt: duty.startedAt.toISOString(),
        dueState: duty.dueState as 'due' | 'none' | 'waiting',
        dueAt: duty.dueAt?.toISOString() ?? null,
        dueDate: duty.dueDate,
        dueTime: duty.dueTime,
        dueTrace: duty.dueTrace,
        warnings: duty.dueWarnings,
        needsDates: duty.needsDates,
        dueSetByHand: duty.dueOverrideAt
          ? { at: duty.dueOverrideAt.toISOString(), reason: duty.dueOverrideReason ?? '' }
          : null,
        blocker: duty.blocker
          ? {
              what: duty.blocker,
              owner: duty.blockerOwner ?? '',
              impact: duty.blockerImpact,
              reviewAt: duty.blockerReviewAt?.toISOString() ?? null,
            }
          : null,
        waitingOn: duty.waitingOn,
        finishedAt: duty.finishedAt?.toISOString() ?? null,
        finishReason: duty.finishReason,
        exception: duty.exception,
        acknowledgedAt: duty.acknowledgedAt?.toISOString() ?? null,
      },
      proof: {
        needs: rule?.items.length ? gapWords(rule, rule.items) : '',
        missing: gaps.length ? gapWords(rule, gaps) : '',
        attestations: (rule?.items ?? []).flatMap((i) =>
          i.kind === 'attestation' ? [i.words] : [],
        ),
      },
      evidence: evidence.map((e) => ({
        evidenceId: e.id,
        kind: e.kind,
        documentId: e.document_id,
        fileId: e.file_id,
        appointmentId: e.appointment_id,
        messageId: e.message_id,
        body: e.body,
        label:
          e.label ??
          (e.kind === 'note'
            ? 'Note'
            : e.kind === 'attestation'
              ? 'Their word'
              : e.kind === 'message'
                ? 'Message'
                : proofItemWords({ kind: 'file' })),
        addedBy: who(e.added_by),
        addedAt: isoOf(e.added_at),
        withdrawnAt: e.withdrawn_at ? isoOf(e.withdrawn_at) : null,
        withdrawnReason: e.withdrawn_reason,
      })),
      log: log.map((l) => ({
        at: l.at.toISOString(),
        what: l.what,
        actorType: l.actorType,
        actor: who(l.actorUserId),
        before: l.before,
        after: l.after,
        note: l.note,
      })),
      can: { except: scopeCan(ctx.scope, 'realestate.except' as Permission) },
    };
  },
});

export const dutyList = defineAddonQuery(realestateAddon, {
  name: 'realestate.duty.list',
  description:
    'Duties across the deals the person sees, soonest due first: theirs or everyone’s, open, overdue, drafts or all, on one deal or every one.',
  input: DutyListInput,
  output: DutyListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const parts: SQL[] = [sql`r.archived_at is null`];
    if (input.mine) parts.push(me ? sql`t.accountable_user_id = ${me}` : sql`false`);
    if (input.status === 'open') parts.push(sql`t.status in ${OPEN}`);
    if (input.status === 'overdue') parts.push(sql`t.status in ${OPEN} and t.due_at <= now()`);
    if (input.status === 'drafts') parts.push(sql`t.status = 'draft'`);
    if (input.dealId) parts.push(sql`t.deal_record_id = ${input.dealId}`);
    const list = await rows<{
      id: string;
      deal_record_id: string;
      deal_name: string;
      duty_key: string;
      title: string;
      status: DutyStatus;
      materiality: string;
      accountable_user_id: string | null;
      due_at: string | null;
      due_state: 'due' | 'none' | 'waiting';
    }>(
      ctx.tx,
      sql`select t.id, t.deal_record_id, r.name as deal_name, t.duty_key, t.title, t.status, t.materiality,
            t.accountable_user_id, t.due_at, t.due_state
          from addon_realestate.duties t
          join app.custom_records r on r.id = t.deal_record_id
          where t.workspace_id = ${ctx.scope.workspaceId!} and ${sql.join(parts, sql` and `)}
          order by t.due_at asc nulls last, t.created_at
          limit ${input.limit}`,
    );
    const names = await userNames(
      ctx,
      list.map((t) => t.accountable_user_id),
    );
    const now = Date.now();
    return {
      duties: list.map((t) => {
        const dueAt = t.due_at ? isoOf(t.due_at) : null;
        return {
          dutyId: t.id,
          dealId: t.deal_record_id,
          dealName: t.deal_name,
          key: t.duty_key,
          title: t.title,
          status: t.status,
          overdue: isOverdue({ status: t.status, dueAt }, now),
          materiality: t.materiality,
          accountable: t.accountable_user_id
            ? {
                userId: t.accountable_user_id,
                name: names.get(t.accountable_user_id) ?? 'Former member',
              }
            : null,
          dueAt,
          dueState: t.due_state,
        };
      }),
    };
  },
});

export const documentList = defineAddonQuery(realestateAddon, {
  name: 'realestate.document.list',
  description:
    'A deal’s documents, each with its kind, version, status, whether it’s the one that counts and whether its file is locked.',
  input: DocumentListInput,
  output: DocumentListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await rows<{
      id: string;
      file_id: string;
      file_name: string;
      kind: string;
      title: string;
      lineage_id: string;
      version: number;
      status: 'draft' | 'sent' | 'signed' | 'superseded' | 'void';
      controlling: boolean;
      locked: boolean;
      signed_at: string | null;
      voided_at: string | null;
      void_reason: string | null;
      created_at: string;
    }>(
      ctx.tx,
      sql`select d.id, d.file_id, f.name as file_name, d.kind, d.title, d.lineage_id, d.version, d.status,
            d.controlling, f.locked_at is not null as locked, d.signed_at, d.voided_at, d.void_reason,
            d.created_at
          from addon_realestate.documents d
          join app.files f on f.id = d.file_id
          where d.deal_record_id = ${deal.recordId}
          order by d.kind, d.lineage_id, d.version desc`,
    );
    return {
      documents: list.map((d) => ({
        documentId: d.id,
        fileId: d.file_id,
        fileName: d.file_name,
        kind: d.kind,
        kindLabel: DOCUMENT_KINDS[d.kind as DocumentKind] ?? d.kind,
        title: d.title,
        lineageId: d.lineage_id,
        version: d.version,
        status: d.status,
        controlling: d.controlling,
        locked: d.locked,
        signedAt: d.signed_at ? isoOf(d.signed_at) : null,
        voidedAt: d.voided_at ? isoOf(d.voided_at) : null,
        voidReason: d.void_reason,
        createdAt: isoOf(d.created_at),
      })),
    };
  },
});

export const dutyQueries = [dutyGet, dutyList, documentList];
