/**
 * The Deals list from a phone's copy (Real Estate round six, step 13): what `realestate.deal.list` answers, worked out
 * from the rows the phone keeps (`./synced.ts`), so the list reads the same with no signal.
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds it to the server's answer, row for row, for each of
 * the list's filters.
 *
 * Browser-safe and pure: the time, the person and the business's today come in.
 */
import type { z } from 'zod';
import type { DealListInput, DealListOutput } from '../schemas';
import { OPEN_DUTY_STATUSES, STAGE_LABELS, type DealSide, type DealStage } from '../states';
import { byText, iso, ms, type RealestateCopy } from './synced';

export type DealListItem = z.infer<typeof DealListOutput>['deals'][number];
export type DealListFilter = Partial<Omit<z.input<typeof DealListInput>, 'workspaceId'>>;

export interface ViewContext {
  /** Whoever is looking: "mine" is the deals they're on, or the duties they answer for. */
  readonly userId: string | null;
  readonly now: number;
  /** The business's today (YYYY-MM-DD), for closing within so many days. */
  readonly today: string;
}

const OPEN = new Set<string>(OPEN_DUTY_STATUSES);
const WAITING: Readonly<Record<'outside' | 'blocked' | 'either', readonly string[]>> = {
  outside: ['waiting_external'],
  blocked: ['blocked'],
  either: ['waiting_external', 'blocked'],
};

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The deals the phone holds, filtered, ordered and shaped as the server's list. */
export function dealListOfCopy(
  copy: RealestateCopy,
  filter: DealListFilter,
  ctx: ViewContext,
): DealListItem[] {
  const all: (DealListItem & { open: boolean; at: number })[] = [];
  for (const deal of copy.deals.values()) {
    const d = deal.data;
    const its = copy.duties.get(deal.id) ?? [];
    const open = its.filter((t) => OPEN.has(t.status));
    const next = open
      .filter((t) => t.dueAt !== null)
      .sort((a, b) => a.dueAt! - b.dueAt! || byText(a.id, b.id))[0];
    const waiting = its
      .filter((t) => t.status === 'waiting_external' || t.status === 'blocked')
      .sort((a, b) => (a.nextLook ?? Infinity) - (b.nextLook ?? Infinity) || byText(a.id, b.id))[0];
    const live = (copy.terms.get(deal.id) ?? []).filter((e) => e.live);
    const closing = live
      .filter((e) => e.key === 'closing')
      .sort((a, b) => b.enteredAt - a.enteredAt || byText(b.id, a.id))[0];
    const reasons = Array.isArray(d.health_reasons) ? (d.health_reasons as unknown[]) : [];
    const first = reasons[0] as { words?: unknown } | undefined;
    const client = copy.clients.get(deal.id);
    const home = copy.homes.get(deal.id);
    const outcome = typeof d.outcome === 'string' ? d.outcome : null;
    const stage = typeof d.stage === 'string' ? d.stage : '';
    const owner = deal.ownerUserId;
    const at = Math.max(ms(d.updated_at) ?? 0, deal.recordUpdatedAt);
    all.push({
      dealId: deal.id,
      name: deal.name,
      side: (typeof d.side === 'string' ? d.side : 'buyer') as DealSide,
      stage,
      stageLabel: STAGE_LABELS[stage as DealStage] ?? stage,
      outcome,
      archived: deal.archived,
      health: (typeof d.health === 'string' ? d.health : 'green') as DealListItem['health'],
      mainAgent: owner ? { userId: owner, name: copy.user(owner) ?? 'Former member' } : null,
      client: client ? { personId: client, name: copy.person(client) ?? 'Customer' } : null,
      property: home ? { propertyId: home, address: copy.record(home) ?? '' } : null,
      openDuties: open.length,
      overdueDuties: open.filter((t) => t.dueAt !== null && t.dueAt <= ctx.now).length,
      nextDue: next ? { dutyId: next.id, title: next.title, dueAt: iso(next.dueAt!) } : null,
      closing: closing?.date ?? null,
      headline: first && typeof first.words === 'string' ? first.words : null,
      mine: ctx.userId !== null && (owner === ctx.userId || deal.teamUserIds.includes(ctx.userId)),
      datesToConfirm: new Set(live.filter((e) => !e.confirmed).map((e) => e.key)).size,
      updatedAt: iso(at),
      waiting: waiting ? { title: waiting.title, who: waiting.who ?? '' } : null,
      open: !deal.archived && outcome === null,
      at,
    });
  }

  const wanted = all.filter((x) => matches(x, filter, ctx, copy));
  wanted.sort(
    (a, b) => Number(b.open) - Number(a.open) || b.at - a.at || byText(a.dealId, b.dealId),
  );
  return wanted.slice(0, filter.limit ?? 100).map(({ open: _open, at: _at, ...item }) => item);
}

function matches(
  x: DealListItem,
  f: DealListFilter,
  ctx: ViewContext,
  copy: RealestateCopy,
): boolean {
  const status = f.status ?? 'open';
  if (status === 'open' && (x.archived || x.outcome !== null)) return false;
  if (status === 'closed' && (x.archived || x.outcome !== 'closed')) return false;
  if (
    status === 'ended' &&
    (x.archived || !['lost', 'ended', 'terminated'].includes(x.outcome ?? ''))
  )
    return false;
  if (status === 'archived' && !x.archived) return false;
  if (f.side && x.side !== f.side) return false;
  if (f.mine && !x.mine) return false;
  if (f.agentUserId && x.mainAgent?.userId !== f.agentUserId) return false;
  if (f.stage && x.stage !== f.stage) return false;
  if (f.closingWithinDays !== undefined) {
    const last = addDays(ctx.today, f.closingWithinDays);
    const soon = (copy.terms.get(x.dealId) ?? []).some(
      (e) =>
        e.live && e.key === 'closing' && e.date !== null && e.date >= ctx.today && e.date <= last,
    );
    if (!soon) return false;
  }
  if (f.waitingOn) {
    const on = WAITING[f.waitingOn];
    if (!(copy.duties.get(x.dealId) ?? []).some((t) => on.includes(t.status))) return false;
  }
  if (f.search) {
    const q = f.search.trim().toLowerCase();
    const hit = [x.name, x.client?.name, x.property?.address].some((s) =>
      (s ?? '').toLowerCase().includes(q),
    );
    if (!hit) return false;
  }
  return true;
}
