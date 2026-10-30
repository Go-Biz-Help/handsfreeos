import { readNetwork } from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';

import type { ChangeIcon } from './describe';
import type { SqlRunner } from './outbox';

/**
 * Words for Social Outreach's changes made on the phone (decision 44), as Changes on this phone and the Sign out?
 * sheet say them: "OK’d message to Dana Reyes", "OK’d 5 messages", "Skipped message to Dana Reyes", "Start my day".
 * Who a message is to comes from the phone's copy of the person's messages (`addon_phone_rows`, source `sends`).
 */

export interface OutreachNames {
  /** Who a message the phone holds is to. */
  sendTo(sendId: string | null): string | null;
}

export const NO_OUTREACH_NAMES: OutreachNames = { sendTo: () => null };

export interface OutreachWords {
  readonly title: string;
  readonly part: string;
  readonly icon: ChangeIcon;
  readonly quote: string | null;
  readonly heldUntil: string;
}

type Input = Readonly<Record<string, unknown>>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** " on LinkedIn": the network a day was pressed on, when the change names one. */
const onNetwork = (input: Input): string => {
  const platform = readNetwork(str(input.platform));
  return platform ? ` on ${PLATFORMS[platform]}` : '';
};

const sendsOf = (input: Input): { sendId: string | null; text: string | null }[] =>
  Array.isArray(input.sends)
    ? input.sends.map((s: unknown) => {
        const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
        return { sendId: str(o.sendId), text: str(o.text) };
      })
    : [];

export function describeOutreach(
  name: string,
  input: Input,
  names: OutreachNames,
): OutreachWords | null {
  if (!name.startsWith('outreach.')) return null;
  const words = (
    title: string,
    part: string,
    icon: ChangeIcon,
    quote: string | null = null,
  ): OutreachWords => ({ title, part, icon, quote, heldUntil: `${lower(title)} goes through` });
  const to = (sendId: string | null) => {
    const who = names.sendTo(sendId);
    return who ? `message to ${who}` : 'a message';
  };
  switch (name) {
    case 'outreach.send.approve': {
      const sends = sendsOf(input);
      if (sends.length === 1) {
        const [one] = sends;
        return one!.text
          ? words(`Changed and OK’d ${to(one!.sendId)}`, 'a message OK’d', 'text', one!.text)
          : words(`OK’d ${to(one!.sendId)}`, 'a message OK’d', 'text');
      }
      return words(
        `OK’d ${sends.length.toLocaleString('en-US')} messages`,
        'messages OK’d',
        'text',
      );
    }
    case 'outreach.send.skip':
      return words(`Skipped ${to(str(input.sendId))}`, 'a message skipped', 'text');
    case 'outreach.send.retry':
      return input.needIds === null
        ? words('Tried what didn’t go again', 'messages tried again', 'text')
        : words('Tried a message again', 'a message tried again', 'text');
    case 'outreach.day.start':
      return words(`Start my day${onNetwork(input)}`, 'Start my day', 'calendar');
    case 'outreach.day.stop':
      return words(`Stop for today${onNetwork(input)}`, 'Stop for today', 'calendar');
    case 'outreach.need.clear':
      return input.how === 'dismissed'
        ? words('Let a step go', 'a step let go', 'task')
        : words('Did a step yourself', 'a step done', 'task');
    case 'outreach.request.set_aside':
      return words('Left a friend request', 'a friend request left', 'person');
    case 'outreach.request.answer':
      return input.answer === 'confirm'
        ? words('Confirmed a friend request', 'a friend request confirmed', 'person')
        : words('Deleted a friend request', 'a friend request deleted', 'person');
    case 'outreach.post.skip':
      return words('Put a post aside', 'a post put aside', 'item');
    default:
      return words('A change in Social Outreach', 'a change', 'change');
  }
}

/** Who the messages the changes name are to, from the phone's copy. */
export async function loadOutreachNames(
  runner: SqlRunner,
  inputs: readonly Input[],
): Promise<OutreachNames> {
  const ids = new Set<string>();
  for (const input of inputs) {
    const one = str(input.sendId);
    if (one) ids.add(`sends:${one}`);
    for (const s of sendsOf(input)) if (s.sendId) ids.add(`sends:${s.sendId}`);
  }
  if (ids.size === 0) return NO_OUTREACH_NAMES;
  const ROWS = "SELECT id, data FROM addon_phone_rows WHERE addon_id = 'outreach' AND id IN (?)";
  const rows = await runner.getAll<{ id: string; data: string | null }>(
    ROWS.replace('(?)', `(${[...ids].map(() => '?').join(', ')})`),
    [...ids],
  );
  const names = new Map<string, string>();
  for (const r of rows) {
    try {
      const data: unknown = JSON.parse(r.data ?? '{}');
      const name = data && typeof data === 'object' ? str((data as Input).name) : null;
      if (name) names.set(r.id.slice(r.id.indexOf(':') + 1), name);
    } catch {
      // A row that isn't JSON names nobody.
    }
  }
  return { sendTo: (id) => (id ? (names.get(id) ?? null) : null) };
}
