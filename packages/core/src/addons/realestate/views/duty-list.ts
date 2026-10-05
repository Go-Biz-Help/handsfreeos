/**
 * My duties from a phone's copy (Real Estate round six, step 13): what `realestate.duty.list` answers, worked out from
 * the rows the phone keeps (`./synced.ts`). Duties on archived deals are left out, as on the server.
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds it to the server's answer for each filter.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { DutyListInput, DutyListOutput } from '../schemas';
import { isOverdue, OPEN_DUTY_STATUSES, type DutyStatus } from '../states';
import type { ViewContext } from './deal-list';
import { byText, iso, type CopyDuty, type RealestateCopy } from './synced';

export type DutyListItem = z.infer<typeof DutyListOutput>['duties'][number];
export type DutyListFilter = Partial<Omit<z.input<typeof DutyListInput>, 'workspaceId'>>;

const OPEN = new Set<string>(OPEN_DUTY_STATUSES);

export function dutyListOfCopy(
  copy: RealestateCopy,
  filter: DutyListFilter,
  ctx: Pick<ViewContext, 'userId' | 'now'>,
): DutyListItem[] {
  const mine = filter.mine ?? true;
  const status = filter.status ?? 'open';
  const wanted: CopyDuty[] = [];
  for (const deal of copy.deals.values()) {
    if (deal.archived) continue;
    if (filter.dealId && deal.id !== filter.dealId) continue;
    for (const t of copy.duties.get(deal.id) ?? []) {
      if (mine && (ctx.userId === null || t.accountableUserId !== ctx.userId)) continue;
      if (status === 'open' && !OPEN.has(t.status)) continue;
      if (status === 'overdue' && !(OPEN.has(t.status) && t.dueAt !== null && t.dueAt <= ctx.now))
        continue;
      if (status === 'drafts' && t.status !== 'draft') continue;
      wanted.push(t);
    }
  }
  // Soonest due first, those with no due time last; then the oldest.
  wanted.sort(
    (a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
      a.createdAt - b.createdAt ||
      byText(a.id, b.id),
  );
  return wanted.slice(0, filter.limit ?? 200).map((t) => {
    const dueAt = t.dueAt === null ? null : iso(t.dueAt);
    const who = t.accountableUserId;
    return {
      dutyId: t.id,
      dealId: t.dealId,
      dealName: copy.deals.get(t.dealId)?.name ?? '',
      key: t.key,
      title: t.title,
      status: t.status as DutyStatus,
      overdue: isOverdue({ status: t.status as DutyStatus, dueAt }, ctx.now),
      materiality: t.materiality,
      accountable: who ? { userId: who, name: copy.user(who) ?? 'Former member' } : null,
      dueAt,
      dueState: t.dueState as DutyListItem['dueState'],
    };
  });
}
