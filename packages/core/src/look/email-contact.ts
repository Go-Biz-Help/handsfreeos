/**
 * What an email's footer shows about the business (design tools, part 5): its postal address (the one quotes and
 * campaign emails carry), the number it texts and calls from, its website and its social links. Server side: the
 * worker puts it on the emails it sends, and Settings → Email's preview shows the same (email.setup_status).
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { businessPostalAddress } from '../campaigns/postal-address';
import { formatPhone } from '../crm/phone';
import { defaultNumber } from '../messaging/store';
import type { EmailContact } from './email';
import { lookOf } from './look';
import { footerHasAny, type CustomerFooter } from './page-kit';

export async function emailContactOf(
  tx: Tx,
  workspaceId: string,
  settings?: unknown,
): Promise<EmailContact> {
  const s =
    settings ??
    (
      await tx
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
    )[0]?.settings;
  const address = await businessPostalAddress(tx, workspaceId);
  const number = await defaultNumber(tx, workspaceId);
  const record = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  const website = typeof record['website'] === 'string' ? record['website'].trim() : '';
  return {
    address: (address ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
    phone: number ? formatPhone(number.e164) || null : null,
    website: /^https?:\/\/\S+$/i.test(website) ? website : null,
    socials: lookOf(s).socials?.links ?? [],
  };
}

/**
 * What the bottom of a customer's page says about the business (design tools, part 7: their invoice, estimate,
 * payment plan, document to sign and appointment): the email footer's address, phone, website and social links, and
 * its license number. Null when there's nothing to say.
 */
export async function customerFooterOf(
  tx: Tx,
  workspaceId: string,
  settings?: unknown,
): Promise<CustomerFooter | null> {
  const s =
    settings ??
    (
      await tx
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
    )[0]?.settings;
  const footer: CustomerFooter = {
    license: lookOf(s).license?.text ?? null,
    ...(await emailContactOf(tx, workspaceId, s ?? {})),
  };
  return footerHasAny(footer) ? footer : null;
}
