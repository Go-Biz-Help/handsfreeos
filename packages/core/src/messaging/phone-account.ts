/**
 * Turning phone & texting on and off for a business: its own Twilio subaccount (parent account → one subaccount
 * per business → its numbers).
 *
 * On makes the subaccount straight away, so a business moving a number here from HighLevel or another Twilio
 * account has the Account SID to give them before it has a single number. Off closes it — and **closing is for
 * good**: Twilio has no undo, and closing releases every number still inside. So off is only allowed when there
 * is nothing in the account to lose. What is in the way is said, one reason each, and nothing is ever released
 * on the business's behalf. Turning it back on later makes a fresh subaccount with a new Account SID.
 *
 * Asked twice: by `telephony.disable` when a person presses it, and again by the worker the moment before it
 * closes the account, because a number can be bought or a transfer started in between. This only knows what
 * HandsFreeOS has written down; the worker also lists the account in Twilio before closing it
 * (apps/worker/src/telephony/account-switch.ts), for a number moved in without anybody asking here.
 */
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import {
  numberImports,
  numberPorts,
  phoneNumbers,
  rcsSenders,
  telephonyRegistrations,
} from '@hfos/db/schema';
import { CLAIMED_STATUSES } from './store';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Everything that would be lost if this business's Twilio account were closed now, in words. Empty: safe. */
export async function phoneAccountBlockers(tx: Tx, workspaceId: string): Promise<string[]> {
  const [numbers, imports, ports, senders, registrations] = await Promise.all([
    tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, workspaceId),
          inArray(phoneNumbers.status, [...CLAIMED_STATUSES]),
        ),
      ),
    tx
      .select({ id: numberImports.id })
      .from(numberImports)
      .where(and(eq(numberImports.workspaceId, workspaceId), eq(numberImports.status, 'waiting'))),
    tx
      .select({ id: numberPorts.id })
      .from(numberPorts)
      .where(
        and(
          eq(numberPorts.workspaceId, workspaceId),
          inArray(numberPorts.status, ['submitted', 'carrier_review', 'scheduled']),
        ),
      ),
    tx
      .select({ id: rcsSenders.id })
      .from(rcsSenders)
      .where(
        and(
          eq(rcsSenders.workspaceId, workspaceId),
          notInArray(rcsSenders.status, ['disconnected', 'failed']),
        ),
      ),
    tx
      .select({ id: telephonyRegistrations.id })
      .from(telephonyRegistrations)
      .where(
        and(
          eq(telephonyRegistrations.workspaceId, workspaceId),
          ne(telephonyRegistrations.status, 'draft'),
        ),
      ),
  ]);
  const out: string[] = [];
  if (numbers.length)
    out.push(
      `${numbers.length} phone ${plural(numbers.length, 'number is', 'numbers are')} still in it. Closing the account would release ${plural(numbers.length, 'it', 'them')} for good, so release or move ${plural(numbers.length, 'it', 'them')} first.`,
    );
  if (imports.length)
    out.push(
      `A number is on its way here from Twilio or HighLevel and would land in this account. Stop watching for it first.`,
    );
  if (ports.length)
    out.push('A number is being moved here from another carrier. Call the port off first.');
  if (senders.length) out.push('Your RCS sender is connected to it. Let it go first.');
  if (registrations.length)
    out.push(
      'Your texting registration (A2P 10DLC or toll-free verification) lives in this account and would be lost for good. Talk to support if you still want phone & texting off.',
    );
  return out;
}
