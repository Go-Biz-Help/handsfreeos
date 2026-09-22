/**
 * The one rule every automation that writes to a customer follows (Chris's call):
 * - words the AI teammate writes follow its training: a draft to approve while it is training, sent on its own
 *   once it has graduated, and nothing at all while it is off;
 * - fixed words the business has read (a reminder, a confirmation request, a form link) go as they are, even
 *   while the teammate is training, the way reminders always have.
 * Money is not here on purpose: chasing money beyond the reminders a business agreed to always waits for a person.
 */
import type { CustomerFacing } from './catalog';
import type { TeammateStatus } from '../schemas/ai-team';

export type SendMode = 'send' | 'draft' | 'blocked';

export function sendModeOf(
  customerFacing: Exclude<CustomerFacing, null>,
  teammateStatus: TeammateStatus | null,
): SendMode {
  if (customerFacing === 'owner_wording') return 'send';
  if (teammateStatus === 'automatic') return 'send';
  if (teammateStatus === 'training') return 'draft';
  return 'blocked';
}
