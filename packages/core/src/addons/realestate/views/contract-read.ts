/**
 * One reading of a contract from a phone's copy (Real Estate round six, board 80): what `realestate.contract.read`
 * answers about it (each value with its clause, page and words, and what the AI couldn't place), worked out from the
 * rows the phone keeps. Reading is offline; deciding needs signal, so what confirming would move (`moves`,
 * `problems`) and what counts on the deal now beside each value are the server's.
 * `packages/core/test/addons/realestate-phone-closing.test.ts` holds it to the server's answer.
 *
 * A deal kept as its summary (someone who sees every deal, not on this one) has no readings on the phone: null.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { KEY_DATES, type KeyDateKey } from '../dates/key-dates';
import type { ContractReadOutput } from '../schemas';
import { termLabel, termValueWords, type TermKey } from '../terms';
import { holdsWhole, isoOr } from './deal-facts';
import { iso, text, type RealestateCopy } from './synced';

type ReadOut = z.infer<typeof ContractReadOutput>;
export type ContractReadView = Omit<ReadOut, 'values' | 'moves' | 'problems' | 'newerReadId'> & {
  readonly values: readonly Omit<ReadOut['values'][number], 'now' | 'nowFrom' | 'same'>[];
  /** The document's file name and version, as the board's title line has them. */
  readonly fileName: string | null;
  readonly version: number;
};

/** A value as the reading keeps it (`addon_realestate.contract_reads.found`). */
interface FoundValue {
  readonly id: string;
  readonly key: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly cents: number | null;
  readonly text: string | null;
  readonly worked: {
    readonly days: number;
    readonly business: boolean;
    readonly from: string;
    readonly fromDate: string;
  } | null;
  readonly clause: string | null;
  readonly page: number | null;
  readonly quote: string;
  readonly state: 'waiting' | 'confirmed' | 'rejected';
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "9 days after the contract accepted (Sep 24, 2026)", or "On the closing (Oct 30, 2026)": the server's words. */
const workedWords = (w: FoundValue['worked']) => {
  if (!w) return null;
  const from = `the ${KEY_DATES[w.from as KeyDateKey].label.toLowerCase()} (${termValueWords({ valueDate: w.fromDate, valueTime: null, valueCents: null, valueText: null })})`;
  if (w.days === 0) return `On ${from}`;
  return `${w.days} ${w.business ? (w.days === 1 ? 'business day' : 'business days') : w.days === 1 ? 'day' : 'days'} after ${from}`;
};

/** The reading, or null when the phone doesn't hold it (or its deal only as a summary). */
export function contractReadOfCopy(
  copy: RealestateCopy,
  dealId: string,
  readId: string,
  ctx: { readonly userId: string | null },
): ContractReadView | null {
  const deal = copy.deals.get(dealId);
  if (!deal || !holdsWhole(copy, dealId, ctx.userId)) return null;
  const read = copy.rows('contract_reads', dealId).find((r) => r.id === readId);
  if (!read) return null;
  const r = read.data;
  const documentId = text(r.document_id) ?? '';
  const doc = copy.rows('documents', dealId).find((d) => d.id === documentId)?.data;
  // As on the server: a reading shows with its document.
  if (!doc) return null;
  const fileId = text(doc.file_id) ?? '';
  const by = text(r.requested_by);
  return {
    readId,
    dealId,
    dealName: deal.name,
    documentId,
    documentTitle: text(doc.title) ?? '',
    fileId,
    kind: (text(r.kind) ?? 'contract') as ContractReadView['kind'],
    state: (text(r.state) ?? 'reading') as ContractReadView['state'],
    scan: r.scan === true,
    pages: typeof r.pages === 'number' ? r.pages : null,
    failure: text(r.failure),
    requestedAt: isoOr(r.requested_at) ?? iso(0),
    readAt: isoOr(r.read_at),
    requestedByName: by ? copy.user(by) : null,
    values: (list(r.found) as FoundValue[]).map((v) => ({
      id: v.id,
      key: v.key as ContractReadView['values'][number]['key'],
      label: termLabel(v.key as TermKey),
      value: termValueWords({
        valueDate: v.date,
        valueTime: v.time,
        valueCents: v.cents,
        valueText: v.text,
      }),
      date: v.date,
      cents: v.cents,
      text: v.text,
      worked: workedWords(v.worked),
      clause: v.clause,
      page: v.page,
      quote: v.quote,
      state: v.state,
      decidedByName: v.decidedBy ? (copy.user(v.decidedBy) ?? null) : null,
      decidedAt: v.decidedAt,
      reason: v.reason,
    })),
    unclear: list(r.unclear) as ContractReadView['unclear'],
    dropped: Number(r.dropped ?? 0) || 0,
    fileName: copy.file(fileId),
    version: Number(doc.version ?? 0) || 0,
  };
}
