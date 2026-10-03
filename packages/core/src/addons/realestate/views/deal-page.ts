/**
 * A deal's page from a phone's copy (Real Estate round six, step 14): what `realestate.deal.get` answers about the
 * deal, its team, its home, its people, its terms and its duties (with what proof each still lacks), worked out from
 * the rows the phone keeps (`./synced.ts`). `packages/core/test/addons/realestate-phone-views.test.ts` holds each part
 * to the server's answer.
 *
 * Left to the server, and so to signal: the date checks (they need the business's closed days), the linked deal seen
 * through its link (the phone keeps only deals the person sees), the commission, and what the person may do.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { ResolvedDuty } from '../catalog/types';
import { gapWords, proofGaps, type DealProofFacts, type EvidenceFact } from '../proof';
import { proofRuleWords } from '../rule-words';
import type { DealGetOutput } from '../schemas';
import { isDoneDuty, isOverdue, STAGE_LABELS, type DealStage, type DutyStatus } from '../states';
import {
  keyDatesOf,
  termKind,
  termLabel,
  termsNow,
  TERM_KEYS,
  type TermEntry,
  type TermKey,
} from '../terms';
import { PARTY_ROLES, type PartyRole } from '../words';
import { byText, iso, ms, text, type RealestateCopy } from './synced';

type DealGet = z.infer<typeof DealGetOutput>;
/**
 * What the phone shows of a deal with no signal: the server's answer, less what only the server can work out. `full`
 * is false for a deal the person isn't on but sees as someone who sees every deal: the phone keeps its summary, duties
 * and dates, not its documents and proof, so what proof each duty lacks is left empty and loads with signal.
 */
export type DealPage = Pick<
  DealGet,
  'deal' | 'team' | 'property' | 'parties' | 'terms' | 'duties'
> & {
  readonly full: boolean;
};

const isoOr = (v: unknown): string | null => {
  const t = ms(v);
  return t === null ? null : iso(t);
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
const int = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

/** The deal's page, or null when the phone doesn't hold it. */
export function dealPageOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null; readonly now: number },
): DealPage | null {
  const deal = copy.deals.get(dealId);
  if (!deal) return null;
  const full =
    ctx.userId !== null &&
    (deal.ownerUserId === ctx.userId || deal.teamUserIds.includes(ctx.userId));
  const d = deal.data;
  const stage = text(d.stage) ?? '';

  // Terms, as entered: the newest live entry counts while every live one agrees.
  const entries = copy.rows('term_entries', dealId).map(({ id, data: e }) => ({
    id,
    key: text(e.key) as TermKey,
    valueDate: text(e.value_date),
    valueTime: text(e.value_time),
    valueCents: e.value_cents === null || e.value_cents === undefined ? null : int(e.value_cents),
    valueText: text(e.value_text),
    source: text(e.source) as TermEntry['source'],
    sourceRef: text(e.source_ref),
    enteredAt: isoOr(e.entered_at) ?? iso(0),
    confirmedAt: isoOr(e.confirmed_at),
    supersededAt: isoOr(e.superseded_at),
    rejectedAt: isoOr(e.rejected_at),
  }));
  const terms = termsNow(entries);
  const keyDates = keyDatesOf(terms);

  const roles = new Map(
    copy.rows('deal_roles', dealId).map((r) => [text(r.data.user_id) ?? '', text(r.data.role)]),
  );
  const teamIds = [deal.ownerUserId, ...deal.teamUserIds].filter((i): i is string => !!i);
  const home = copy.homes.get(dealId);

  // Its people: every one of the add-on's links to it but the home, in the kinds' order.
  const parties = (copy.linksTo.get(dealId) ?? [])
    .filter((l) => l.addonId === 'realestate' && l.addonKey !== 'realestate_property_of')
    .filter((l) => l.personId || l.companyId)
    .sort((a, b) => a.position - b.position || a.at - b.at || byText(a.id, b.id))
    .map((l) => {
      const role = (l.addonKey ?? '').replace(/^realestate_/, '') as PartyRole;
      const name =
        (l.companyId ? copy.company(l.companyId) : null) ??
        (l.personId ? copy.personPlain(l.personId) : null);
      return {
        relationshipId: l.id,
        role,
        label: PARTY_ROLES[role]?.label ?? role,
        personId: l.personId,
        companyId: l.companyId,
        name: name ?? 'Someone',
        note: l.note,
      };
    });

  // What the deal itself holds that a duty's proof may ask for.
  const fields = new Set<string>();
  if (d.expected_commission_cents !== null && d.expected_commission_cents !== undefined)
    fields.add('expected_commission');
  if (d.final_commission_cents !== null && d.final_commission_cents !== undefined)
    fields.add('final_commission');
  if (home) fields.add('property');
  if (copy.clients.has(dealId)) fields.add('client');
  const proofFacts: DealProofFacts = {
    confirmedDates: new Set(
      (Object.keys(keyDates) as (keyof typeof keyDates)[]).filter((k) => keyDates[k]?.confirmed),
    ),
    fields: fields as DealProofFacts['fields'],
  };
  const documents = new Map(copy.rows('documents', dealId).map((r) => [r.id, r.data]));
  const evidence = copy.rows('duty_evidence', dealId).map(({ data: e }) => {
    const doc = text(e.document_id) ? documents.get(text(e.document_id)!) : undefined;
    return {
      dutyId: text(e.duty_id) ?? '',
      fact: {
        kind: text(e.kind) as EvidenceFact['kind'],
        withdrawn: e.withdrawn_at !== null && e.withdrawn_at !== undefined,
        documentKind: doc ? text(doc.kind) : null,
        signed: doc ? text(doc.signed_at) !== null && text(doc.status) !== 'void' : false,
      } satisfies EvidenceFact,
    };
  });

  const duties = [...(copy.duties.get(dealId) ?? [])]
    .sort(
      (a, b) =>
        (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
        a.createdAt - b.createdAt ||
        byText(a.id, b.id),
    )
    .map((t) => {
      const row = copy.rows('duties', dealId).find((r) => r.id === t.id)!.data;
      const rule = (row.definition as ResolvedDuty | null)?.proof ?? null;
      const status = t.status as DutyStatus;
      const dueAt = t.dueAt === null ? null : iso(t.dueAt);
      let proofMissing = '';
      if (full && !isDoneDuty(status)) {
        const gaps = proofGaps(
          rule,
          evidence.filter((e) => e.dutyId === t.id).map((e) => e.fact),
          proofFacts,
        );
        proofMissing = gaps.length ? gapWords(rule, gaps) : '';
      }
      const who = t.accountableUserId;
      return {
        dutyId: t.id,
        key: t.key,
        pass: int(row.pass),
        title: t.title,
        tracker: text(row.tracker) ?? '',
        status,
        overdue: isOverdue({ status, dueAt }, ctx.now),
        materiality: t.materiality,
        automation: text(row.automation) ?? '',
        accountableRole: text(row.accountable_role) ?? '',
        accountable: who ? { userId: who, name: copy.user(who) ?? 'Former member' } : null,
        startedBy: text(row.started_by) ?? '',
        dueState: t.dueState as 'due' | 'none' | 'waiting',
        dueAt,
        dueDate: text(row.due_date),
        dueTime: text(row.due_time),
        needsDates: strings(row.needs_dates),
        warnings: list(row.due_warnings),
        proof: rule ? proofRuleWords(rule) : '',
        proofMissing,
        waitingOn: text(row.waiting_on),
        blocked: status === 'blocked' ? (text(row.blocker) ?? '') : null,
      };
    });

  return {
    full,
    deal: {
      dealId,
      name: deal.name,
      notes: deal.notes,
      side: (text(d.side) ?? 'buyer') as DealPage['deal']['side'],
      stage,
      stageLabel: STAGE_LABELS[stage as DealStage] ?? stage,
      stageEnteredAt: isoOr(d.stage_entered_at) ?? iso(0),
      outcome: text(d.outcome),
      outcomeAt: isoOr(d.outcome_at),
      outcomeReason: text(d.outcome_reason),
      archived: deal.archived,
      leadId: text(d.lead_id),
      facts: strings(d.facts),
      health: (text(d.health) ?? 'green') as DealPage['deal']['health'],
      healthReasons: list(d.health_reasons),
      catalogVersion: int(d.catalog_version),
      templateSetId: text(d.template_set_id),
      createdAt: isoOr(d.created_at) ?? iso(0),
    },
    team: teamIds.map((id) => ({
      userId: id,
      name: copy.user(id) ?? 'Former member',
      role: id === deal.ownerUserId ? 'agent' : (roles.get(id) ?? 'co_agent'),
      main: id === deal.ownerUserId,
    })),
    property: home ? { propertyId: home, address: copy.record(home) ?? '' } : null,
    parties,
    terms: TERM_KEYS.filter((k) => terms.has(k)).map((k) => {
      const t = terms.get(k)!;
      return {
        key: k,
        label: termLabel(k),
        kind: termKind(k),
        conflict: t.conflict,
        confirmed: t.confirmed,
        entries: t.live.map((e) => ({
          entryId: e.id,
          date: e.valueDate,
          time: e.valueTime,
          cents: e.valueCents,
          text: e.valueText,
          source: e.source,
          sourceRef: e.sourceRef,
          enteredAt: e.enteredAt,
          confirmed: e.confirmedAt !== null,
        })),
      };
    }),
    duties,
  };
}
