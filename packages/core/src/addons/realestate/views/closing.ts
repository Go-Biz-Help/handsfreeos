/**
 * The closing side of a deal from a phone's copy (Real Estate round six): its financing, inspections and repairs,
 * the client's tasks, its contingencies and the readings of its contracts, as `realestate.financing`,
 * `realestate.inspections`, `realestate.client_tasks`, `realestate.contingencies` and `realestate.contract.reads`
 * answer them (ops/financing.ts, ops/inspections.ts, ops/client-tasks.ts, ops/contingencies.ts, ops/contract.ts),
 * worked out from the rows the phone keeps. `packages/core/test/addons/realestate-phone-closing.test.ts` holds each to
 * the server's answer.
 *
 * A deal kept as its summary (someone who sees every deal, not on this one) has its dates, clients and their portal
 * on the phone, not its loan, inspections, tasks, contingencies or readings: `full` is false, and those lists are
 * empty until signal.
 *
 * What the phone takes from elsewhere, or leaves to the server:
 * - A financing step proved by a message: the message is the Inbox's, not the deal's. The phone names it from its
 *   Inbox copy (`messages`); one it doesn't keep (older than a year, private, or no Inbox on this phone) says
 *   "Message" until signal.
 * - A file deleted from the deal since it proved a step or a client's task: the phone doesn't keep it, so it says
 *   "Removed since" (a step) or "File" (a task) where the server still gives its name.
 * - The client's tasks name each client by first name, with their email (`copy.personParts`).
 * - Contingencies: whether the person may record one without its form (`can.except`) is a permission, the server's.
 *   Today, and the day each was recorded, are the business's: its time zone comes in (`timeZone`, the workspace's).
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { localDateOf } from '../../../calendar/engine/zoned';
import {
  cdDeadline,
  FINANCING_STEP_KEYS,
  FINANCING_STEPS,
  findingFacts,
  INSPECTION_KINDS,
  messageProofLabel,
  PROOF_REMOVED,
  repairDraft,
  stepWords,
  type ClientPriority,
  type FindingAsk,
  type InspectionKind,
  type StepStatus,
} from '../closing';
import { waitingWords, type ClientTaskKind } from '../client-words';
import {
  contingencyClock,
  contingencyEnd,
  contingencyLabel,
  contingencyStateWords,
  type ContingencyKind,
  type ContingencyState,
} from '../contingencies';
import { calendarOf } from '../dates/business-days';
import type {
  ClientTasksOutput,
  ContingenciesOutput,
  ContractReadsOutput,
  FinancingOutput,
  InspectionsOutput,
} from '../schemas';
import { keyDatesOf, moneyOf, termsNow } from '../terms';
import { byTimeAsc, num, str } from './columns';
import { holdsWhole, isoOr, termEntriesOfCopy } from './deal-facts';
import { byText, iso, ms, text, type RealestateCopy } from './synced';

export type FinancingView = z.infer<typeof FinancingOutput> & { readonly full: boolean };
export type InspectionsView = z.infer<typeof InspectionsOutput> & { readonly full: boolean };
export type ClientTasksView = z.infer<typeof ClientTasksOutput> & { readonly full: boolean };
export type ContingenciesView = Omit<z.infer<typeof ContingenciesOutput>, 'can'> & {
  readonly full: boolean;
};
export type ContractReadsView = z.infer<typeof ContractReadsOutput> & { readonly full: boolean };

/** A message in the phone's Inbox copy: its subject and its conversation's counterpart. */
export type MessageLookup = (
  id: string,
) => { readonly subject: string | null; readonly counterpart: string } | null;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Oldest first by a time, then by id: the server's `order by <time>, id`. */
const byTime =
  (key: string) => (a: { id: string; data: Readonly<Record<string, unknown>> }, b: typeof a) =>
    byTimeAsc(a.data[key], b.data[key]) || byText(a.id, b.id);
const memberName = (copy: RealestateCopy, id: string) => copy.user(id) ?? 'Former member';
const documentTitles = (copy: RealestateCopy, dealId: string) =>
  new Map(copy.rows('documents', dealId).map((r) => [r.id, str(r.data.title) ?? '']));

// ---------- financing ----------

/** The deal's financing, or null when the phone doesn't hold the deal. */
export function financingOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null; readonly messages?: MessageLookup },
): FinancingView | null {
  if (!copy.deals.has(dealId)) return null;
  const full = holdsWhole(copy, dealId, ctx.userId);
  const terms = termsNow(termEntriesOfCopy(copy, dealId));
  const closing = terms.get('closing')?.current?.valueDate ?? null;
  const priceCents = moneyOf(terms, 'price');
  const lender = full ? (copy.rows('financing', dealId)[0]?.data ?? {}) : {};
  const rows = full ? copy.rows('financing_steps', dealId) : [];
  const documents = documentTitles(copy, dealId);
  const proofLabel = (kind: string, id: string): string => {
    if (kind === 'document') return documents.get(id) ?? PROOF_REMOVED;
    if (kind === 'file') return copy.file(id) ?? PROOF_REMOVED;
    const m = ctx.messages?.(id);
    return m ? messageProofLabel(m) : 'Message';
  };
  return {
    full,
    lender: {
      lenderName: str(lender.lender_name),
      officerName: str(lender.officer_name),
      officerEmail: str(lender.officer_email),
      officerPhone: str(lender.officer_phone),
      loanType: text(lender.loan_type) as FinancingView['lender']['loanType'],
      loanAmountCents: num(lender.loan_amount_cents),
    },
    closing,
    cdDeadline: closing ? cdDeadline(closing) : null,
    // Every step from preapproval to funding, on a deal held whole; none until signal on a summary.
    steps: !full
      ? []
      : FINANCING_STEP_KEYS.map((step) => {
          const s = rows.find((r) => text(r.data.step) === step)?.data;
          const facts = {
            step,
            status: (text(s?.status) ?? 'not_started') as StepStatus,
            startedOn: text(s?.started_on),
            expectedOn: text(s?.expected_on),
            doneOn: text(s?.done_on),
            amountCents: num(s?.amount_cents),
            rate: num(s?.rate),
            expiresOn: text(s?.expires_on),
          };
          const words = stepWords(facts, { closing, priceCents });
          const proofKind = text(s?.proof_kind) as 'document' | 'file' | 'message' | null;
          const proofId = text(s?.proof_id);
          const doneBy = text(s?.done_by);
          return {
            ...facts,
            label: FINANCING_STEPS[step].label,
            note: str(s?.note),
            proof:
              proofKind && proofId
                ? { kind: proofKind, id: proofId, label: proofLabel(proofKind, proofId) }
                : null,
            doneBy: doneBy ? { id: doneBy, fullName: memberName(copy, doneBy) } : null,
            line: words.line,
            warning: words.warning,
          };
        }),
  };
}

// ---------- inspections and repairs ----------

type InspectionLine = InspectionsView['inspections'][number];
type FindingLine = InspectionLine['findings'][number];

/** The deal's inspections, findings and repair requests, or null when the phone doesn't hold the deal. */
export function inspectionsOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): InspectionsView | null {
  if (!copy.deals.has(dealId)) return null;
  const full = holdsWhole(copy, dealId, ctx.userId);
  const terms = termsNow(termEntriesOfCopy(copy, dealId));
  const documents = documentTitles(copy, dealId);
  const inspections = full ? [...copy.rows('inspections', dealId)].sort(byTime('created_at')) : [];
  // Every finding of the deal's inspections, by position as the server lists them (then by id).
  const findings = (full ? [...copy.rows('inspection_findings', dealId)] : [])
    .sort((a, b) => (num(a.data.position) ?? 0) - (num(b.data.position) ?? 0) || byText(a.id, b.id))
    .map(({ id, data: f }) => ({
      inspectionId: text(f.inspection_id) ?? '',
      line: {
        id,
        title: str(f.title) ?? '',
        location: str(f.location),
        severity: (text(f.severity) ?? 'minor') as FindingLine['severity'],
        estimateCents: num(f.estimate_cents),
        clientPriority: text(f.client_priority) as ClientPriority | null,
        ask: (text(f.ask) ?? 'not_asked') as FindingAsk,
        creditCents: num(f.credit_cents),
        note: str(f.note),
      } satisfies FindingLine,
    }));
  const canceled = new Set(
    inspections.filter((i) => text(i.data.status) === 'canceled').map((i) => i.id),
  );
  const draft = repairDraft(
    findings.filter((f) => !canceled.has(f.inspectionId)).map((f) => findingFacts(f.line)),
  );
  const repairs = full
    ? [...copy.rows('repair_requests', dealId)].sort(
        (a, b) => (num(a.data.number) ?? 0) - (num(b.data.number) ?? 0) || byText(a.id, b.id),
      )
    : [];
  return {
    full,
    periodEnds: terms.get('inspection_end')?.current?.valueDate ?? null,
    inspections: inspections.map(({ id, data: i }): InspectionLine => {
      const kind = text(i.kind) ?? '';
      const reportId = text(i.report_document_id);
      const reportTitle = reportId ? documents.get(reportId) : undefined;
      return {
        id,
        kind: kind as InspectionKind,
        label: INSPECTION_KINDS[kind as InspectionKind] ?? kind,
        inspector: str(i.inspector),
        scheduledAt: isoOr(i.scheduled_at),
        reportExpectedOn: text(i.report_expected_on),
        status: (text(i.status) ?? 'scheduled') as InspectionLine['status'],
        reportDocument:
          reportId && reportTitle !== undefined ? { id: reportId, title: reportTitle } : null,
        reportInOn: text(i.report_in_on),
        pages: num(i.pages),
        note: str(i.note),
        findings: findings.filter((f) => f.inspectionId === id).map((f) => f.line),
      };
    }),
    repairs: repairs.map(({ id, data: r }) => ({
      id,
      number: num(r.number) ?? 0,
      side: (text(r.side) ?? 'us') as 'us' | 'them',
      at: isoOr(r.at) ?? iso(0),
      words: str(r.words) ?? '',
      creditCents: num(r.credit_cents) ?? 0,
      respondBy: isoOr(r.respond_by),
      outcome: text(r.outcome) as InspectionsView['repairs'][number]['outcome'],
      items: list(r.items) as InspectionsView['repairs'][number]['items'],
    })),
    draft: { words: draft.words, creditCents: draft.creditCents, items: draft.items.length },
  };
}

// ---------- the client's tasks ----------

/**
 * What the deal's clients do in their portal, and whether each has it; or null when the phone doesn't hold the deal.
 * On a summary the clients and their portal are there, the tasks with signal.
 */
export function clientTasksOfCopy(
  copy: RealestateCopy,
  dealId: string,
  opts: {
    readonly userId: string | null;
    readonly includeCanceled?: boolean;
  },
): ClientTasksView | null {
  if (!copy.deals.has(dealId)) return null;
  const full = holdsWhole(copy, dealId, opts.userId);
  // The deal's clients, first linked first (the server's `dealClients`).
  const clients = (copy.linksTo.get(dealId) ?? [])
    .filter((l) => l.addonKey === 'realestate_client' && l.personId)
    .sort((a, b) => a.at - b.at || byText(a.id, b.id))
    .flatMap((l) => {
      const p = copy.personParts(l.personId!);
      return p
        ? [
            {
              id: l.personId!,
              firstName: p.firstName,
              name: `${p.firstName} ${p.lastName}`.trim(),
              email: p.email,
            },
          ]
        : [];
    });
  const tasks = (full ? [...copy.rows('client_tasks', dealId)] : [])
    .filter((t) => opts.includeCanceled || text(t.data.status) !== 'canceled')
    .sort(byTime('created_at'));
  const parts = full ? [...copy.rows('client_task_completions', dealId)].sort(byTime('at')) : [];
  return {
    full,
    tasks: tasks.map(({ id, data: t }) => {
      const task = {
        kind: (text(t.kind) ?? 'do') as ClientTaskKind,
        forPersonId: text(t.for_person_id),
      };
      const status = (text(t.status) ?? 'open') as ClientTasksView['tasks'][number]['status'];
      const mine = parts.filter((p) => text(p.data.task_id) === id);
      const doneBy = mine.map((p) => text(p.data.person_id) ?? '');
      return {
        id,
        kind: task.kind,
        title: str(t.title) ?? '',
        detail: str(t.detail),
        signOffWords: str(t.sign_off_words),
        forPersonId: task.forPersonId,
        dueOn: text(t.due_on),
        status,
        doneAt: isoOr(t.done_at),
        waiting: status === 'open' ? waitingWords(task, clients, doneBy) : null,
        completions: mine.map(({ data: p }) => {
          const personId = text(p.person_id) ?? '';
          const fileId = text(p.file_id);
          const by = text(p.recorded_by);
          return {
            personId,
            name: clients.find((c) => c.id === personId)?.name ?? 'A client',
            at: isoOr(p.at) ?? iso(0),
            file: fileId ? { id: fileId, name: copy.file(fileId) ?? 'File' } : null,
            signedWords: str(p.signed_words),
            recordedBy: by ? { id: by, fullName: memberName(copy, by) } : null,
            note: str(p.note),
          };
        }),
      };
    }),
    clients: clients.map((c) => {
      const a = copy.portalAccess(c.id);
      return {
        personId: c.id,
        name: c.name,
        email: c.email,
        portal: !a
          ? ('none' as const)
          : a.revokedAt
            ? ('revoked' as const)
            : a.lastUsedAt
              ? ('signed_in' as const)
              : ('invited' as const),
        portalSince: a && !a.revokedAt ? a.givenAt : null,
      };
    }),
  };
}

// ---------- contingencies ----------

/** The deal's contingencies, or null when the phone doesn't hold the deal. */
export function contingenciesOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null; readonly now: number; readonly timeZone: string },
): ContingenciesView | null {
  if (!copy.deals.has(dealId)) return null;
  const full = holdsWhole(copy, dealId, ctx.userId);
  const keyDates = keyDatesOf(termsNow(termEntriesOfCopy(copy, dealId)));
  const calendar = calendarOf(copy.settings.closedDays);
  const today = localDateOf(ctx.now, ctx.timeZone);
  const documents = documentTitles(copy, dealId);
  const rows = full ? [...copy.rows('contingencies', dealId)].sort(byTime('created_at')) : [];
  return {
    dealId,
    full,
    contingencies: rows.map(({ id, data: c }) => {
      const kind = text(c.kind) as ContingencyKind;
      const state = (text(c.state) ?? 'open') as ContingencyState;
      const end = contingencyEnd({ kind, endsOn: text(c.ends_on) }, keyDates);
      const resolvedAt = ms(c.resolved_at);
      const resolvedOn = resolvedAt === null ? null : localDateOf(resolvedAt, ctx.timeZone);
      const by = text(c.resolved_by);
      const documentId = text(c.document_id);
      const title = documentId ? documents.get(documentId) : undefined;
      return {
        id,
        kind,
        label: contingencyLabel({ kind, label: str(c.label) }),
        endKey: text(c.end_key),
        endsOn: end.date,
        endConfirmed: end.confirmed,
        state,
        stateWords: contingencyStateWords({ state, resolvedOn }, end.date, today),
        clock: state === 'open' ? contingencyClock(end.date, today, calendar) : 'open',
        source: (text(c.source) ?? 'typed') as 'offer' | 'contract' | 'typed',
        resolvedAt: isoOr(c.resolved_at),
        resolvedByName: by ? copy.user(by) : null,
        document: documentId && title ? { id: documentId, title } : null,
        note: str(c.note),
        overrideReason: str(c.override_reason),
      };
    }),
  };
}

// ---------- the readings of its contracts ----------

/** The readings of the deal's contracts and amendments, newest first; or null when the phone doesn't hold the deal. */
export function contractReadsOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): ContractReadsView | null {
  if (!copy.deals.has(dealId)) return null;
  const full = holdsWhole(copy, dealId, ctx.userId);
  const documents = documentTitles(copy, dealId);
  const reads = full ? [...copy.rows('contract_reads', dealId)] : [];
  return {
    full,
    reads: reads
      .sort((a, b) => byTime('requested_at')(b, a))
      .flatMap(({ id, data: r }) => {
        const documentId = text(r.document_id) ?? '';
        const title = documents.get(documentId);
        // As on the server: a reading shows with its document.
        if (title === undefined) return [];
        const found = list(r.found) as { readonly state?: unknown }[];
        return [
          {
            readId: id,
            documentId,
            documentTitle: title,
            kind: (text(r.kind) ?? 'contract') as ContractReadsView['reads'][number]['kind'],
            state: (text(r.state) ?? 'reading') as ContractReadsView['reads'][number]['state'],
            scan: r.scan === true,
            waiting: found.filter((v) => v?.state === 'waiting').length,
            confirmed: found.filter((v) => v?.state === 'confirmed').length,
            unclear: list(r.unclear).length,
            requestedAt: isoOr(r.requested_at) ?? iso(0),
          },
        ];
      }),
  };
}
