/**
 * Who gets a booking, among the people a slot says are free. Run under the calendar lock with fresh state;
 * the caller stores `nextState` (calendar_assignment_state) in the same transaction.
 *
 * - fixed: the calendar's first person.
 * - customer_choice: the person the customer picked (else the least recently assigned).
 * - round_robin: the free person assigned least recently (never assigned goes first).
 * - weighted: smooth weighted round robin: every free person gains their weight in credit, the richest wins
 *   and pays back the total. Shares track weights within one booking.
 * - first_available: the highest priority free person, ties in team order.
 * - collective: everyone the slot lists.
 * - crew (crewSize k > 1): the strategy runs k times without repeats; extra crew for fixed and customer's
 *   choice come by round robin.
 * - series: the first occurrence's people are kept when free.
 */
import type { CalendarConfig } from '../config';
import type { Assignment, AssignmentOptions, AssignmentState, MemberAssignmentState, Slot } from './types';

const EMPTY: MemberAssignmentState = { assignedCount: 0, lastAssignedAt: null, credit: 0 };

export function memberState(state: AssignmentState, userId: string): MemberAssignmentState {
  return state[userId] ?? EMPTY;
}

export function chooseAssignment(
  slot: Slot,
  config: CalendarConfig,
  state: AssignmentState,
  options: AssignmentOptions = {},
): Assignment {
  if (slot.sessionId) return { userIds: [...slot.userIds], nextState: state };
  const now = options.now ?? Date.now();
  const mode = config.team.assignment;
  const order = new Map(config.team.members.map((m, i) => [m.userId, i]));
  const weight = new Map(config.team.members.map((m) => [m.userId, m.weight]));
  const priority = new Map(config.team.members.map((m) => [m.userId, m.priority]));
  const rank = (u: string) => order.get(u) ?? Number.MAX_SAFE_INTEGER;
  const next: Record<string, MemberAssignmentState> = { ...state };
  const get = (u: string) => next[u] ?? EMPTY;

  if (mode === 'collective') {
    for (const u of slot.userIds) next[u] = { ...get(u), assignedCount: get(u).assignedCount + 1, lastAssignedAt: now };
    return { userIds: [...slot.userIds], nextState: next };
  }

  const k = Math.min(config.team.crewSize, slot.userIds.length);
  const picked: string[] = [];
  const seeds: string[] = [];
  if (mode === 'fixed' && config.team.members[0]) seeds.push(config.team.members[0].userId);
  if (mode === 'customer_choice' && options.chosenUserId) seeds.push(options.chosenUserId);
  seeds.push(...(options.preferUserIds ?? []));

  const leastRecent = (list: string[]) =>
    [...list].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      return (
        (x.lastAssignedAt ?? -Infinity) - (y.lastAssignedAt ?? -Infinity) ||
        x.assignedCount - y.assignedCount ||
        rank(a) - rank(b)
      );
    })[0]!;

  /** One smooth weighted round-robin round over the remaining people; `forced` wins regardless. */
  const weightedPick = (remaining: string[], forced: string | null): string => {
    let total = 0;
    for (const u of remaining) {
      const w = weight.get(u) ?? 1;
      total += w;
      next[u] = { ...get(u), credit: get(u).credit + w };
    }
    const winner =
      forced ??
      remaining.reduce((best, u) =>
        get(u).credit > get(best).credit || (get(u).credit === get(best).credit && rank(u) < rank(best)) ? u : best,
      );
    next[winner] = { ...get(winner), credit: get(winner).credit - total };
    return winner;
  };

  while (picked.length < k) {
    const remaining = slot.userIds.filter((u) => !picked.includes(u));
    const seed = seeds.find((u) => remaining.includes(u)) ?? null;
    let u: string;
    if (mode === 'weighted') u = weightedPick(remaining, seed);
    else if (seed !== null) u = seed;
    else if (mode === 'first_available')
      u = [...remaining].sort((a, b) => (priority.get(b) ?? 0) - (priority.get(a) ?? 0) || rank(a) - rank(b))[0]!;
    else u = leastRecent(remaining);
    picked.push(u);
  }
  for (const u of picked) next[u] = { ...get(u), assignedCount: get(u).assignedCount + 1, lastAssignedAt: now };
  return { userIds: picked, nextState: next };
}
