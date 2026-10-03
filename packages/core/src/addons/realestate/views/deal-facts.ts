/**
 * What more than one of a deal's phone pages reads from the copy (round six): its terms as entered, the facts a
 * duty's proof may ask of the deal, and each duty's proof as facts. The server's `termEntriesOf`, `dealProofFactsOf`
 * and `evidenceFactsOf` (ops/engine.ts, ops/duties.ts) read the same from the database.
 *
 * Browser-safe and pure.
 */
import type { DealProofFacts, EvidenceFact } from '../proof';
import { keyDatesOf, termsNow, type TermEntry, type TermKey } from '../terms';
import { iso, ms, text, type RealestateCopy } from './synced';

export const isoOr = (v: unknown): string | null => {
  const t = ms(v);
  return t === null ? null : iso(t);
};
const isSet = (v: unknown) => v !== null && v !== undefined;

export type CopyTermEntry = TermEntry & { readonly sourceRef: string | null };

/** The deal's term entries, every one, as the server's `termEntriesOf` gives them. */
export function termEntriesOfCopy(copy: RealestateCopy, dealId: string): CopyTermEntry[] {
  return copy.rows('term_entries', dealId).map(({ id, data: e }) => ({
    id,
    key: text(e.key) as TermKey,
    valueDate: text(e.value_date),
    valueTime: text(e.value_time),
    valueCents: isSet(e.value_cents) ? Number(e.value_cents) : null,
    valueText: text(e.value_text),
    source: text(e.source) as TermEntry['source'],
    sourceRef: text(e.source_ref),
    enteredAt: isoOr(e.entered_at) ?? iso(0),
    confirmedAt: isoOr(e.confirmed_at),
    supersededAt: isoOr(e.superseded_at),
    rejectedAt: isoOr(e.rejected_at),
  }));
}

/** What the deal itself holds that a duty's proof may ask for. */
export function dealProofFactsOfCopy(copy: RealestateCopy, dealId: string): DealProofFacts {
  const keyDates = keyDatesOf(termsNow(termEntriesOfCopy(copy, dealId)));
  const d = copy.deals.get(dealId)?.data ?? {};
  const fields = new Set<string>();
  if (isSet(d.expected_commission_cents)) fields.add('expected_commission');
  if (isSet(d.final_commission_cents)) fields.add('final_commission');
  if (copy.homes.has(dealId)) fields.add('property');
  if (copy.clients.has(dealId)) fields.add('client');
  return {
    confirmedDates: new Set(
      (Object.keys(keyDates) as (keyof typeof keyDates)[]).filter((k) => keyDates[k]?.confirmed),
    ),
    fields: fields as DealProofFacts['fields'],
  };
}

/** Each duty's proof on the deal, as facts its rule is checked against. */
export function evidenceFactsOfCopy(
  copy: RealestateCopy,
  dealId: string,
): ReadonlyMap<string, EvidenceFact[]> {
  const documents = new Map(copy.rows('documents', dealId).map((r) => [r.id, r.data]));
  const out = new Map<string, EvidenceFact[]>();
  for (const { data: e } of copy.rows('duty_evidence', dealId)) {
    const duty = text(e.duty_id) ?? '';
    const docId = text(e.document_id);
    const doc = docId ? documents.get(docId) : undefined;
    out.set(duty, [
      ...(out.get(duty) ?? []),
      {
        kind: text(e.kind) as EvidenceFact['kind'],
        withdrawn: isSet(e.withdrawn_at),
        documentKind: doc ? text(doc.kind) : null,
        signed: doc ? text(doc.signed_at) !== null && text(doc.status) !== 'void' : false,
      },
    ]);
  }
  return out;
}

/** Whether the phone holds the deal whole: the person is on it. Otherwise it keeps its summary, duties and dates. */
export function holdsWhole(copy: RealestateCopy, dealId: string, userId: string | null): boolean {
  const deal = copy.deals.get(dealId);
  return (
    !!deal && userId !== null && (deal.ownerUserId === userId || deal.teamUserIds.includes(userId))
  );
}
