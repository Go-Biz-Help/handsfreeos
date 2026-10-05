/**
 * What happened on a deal, from a phone's copy (Real Estate round six, step 14): what `realestate.deal.history`
 * answers, newest first. A deal kept as its summary has none on the phone; its history loads with signal.
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds it to the server's answer.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { DealHistoryOutput } from '../schemas';
import { isoOr } from './deal-facts';
import { byText, iso, ms, text, type RealestateCopy } from './synced';

export type HistoryLine = z.infer<typeof DealHistoryOutput>['lines'][number];

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function historyOfCopy(
  copy: RealestateCopy,
  dealId: string,
  opts: { readonly limit?: number; readonly before?: string } = {},
): HistoryLine[] {
  const before = opts.before ? Date.parse(opts.before) : null;
  return copy
    .rows('deal_history', dealId)
    .map(({ id, data: l }) => ({ id, l, at: ms(l.at) ?? 0, created: ms(l.created_at) ?? 0 }))
    .filter((x) => before === null || x.at < before)
    .sort((a, b) => b.at - a.at || b.created - a.created || byText(b.id, a.id))
    .slice(0, opts.limit ?? 50)
    .map(({ l }) => {
      const who = text(l.actor_user_id);
      return {
        at: isoOr(l.at) ?? iso(0),
        what: text(l.what) ?? '',
        actorType: (text(l.actor_type) ?? 'system') as HistoryLine['actorType'],
        actor: who ? { userId: who, name: copy.user(who) ?? 'Former member' } : null,
        before: record(l.before),
        after: record(l.after),
        note: text(l.note),
      };
    });
}
