/**
 * The booking page's check on the email a customer types. A slip like "gmial.com" or "fullspecteum…" sends the
 * confirmation and every reminder to a domain that doesn't exist, and nobody finds out until they don't turn up.
 * So the page refuses an address whose domain can't take mail, while the customer is still there to fix it.
 *
 * Only a firm answer from DNS refuses. A DNS server that is slow or failing lets the booking through, so a lookup
 * never costs a business a booking.
 */
import { domainToASCII } from 'node:url';
import { HfosError } from '@hfos/core/server';
import { mailDomainCanReceive, type MailDnsLookup } from '../email/dns';

/** The domain of a typed address, in the form DNS asks about; null when it isn't shaped like one. */
export function emailDomainOf(email: string | null | undefined): string | null {
  const raw = email?.trim() ?? '';
  const at = raw.lastIndexOf('@');
  if (at < 1) return null;
  const domain = raw
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.+$/, '');
  if (!domain.includes('.')) return null;
  const ascii = domainToASCII(domain);
  return ascii && /^[a-z0-9.-]+$/.test(ascii) ? ascii : null;
}

/**
 * Refuses an email at a domain DNS says takes no mail, on the email field (rule `email_domain_not_found`). An
 * empty email, or one core will refuse for its shape, is left to core.
 */
export async function refuseUndeliverableEmail(
  lookup: MailDnsLookup | null | undefined,
  email: string | null | undefined,
): Promise<void> {
  const domain = emailDomainOf(email);
  if (!lookup || !domain) return;
  if ((await mailDomainCanReceive(lookup, domain)) !== false) return;
  const typed = email!.trim();
  const shown = typed.slice(typed.lastIndexOf('@') + 1);
  throw new HfosError(
    'validation',
    400,
    'Some fields need attention. Fix the ones marked and try again.',
    [
      {
        path: 'email',
        message: `We couldn’t find ${shown}, so emails sent there wouldn’t arrive. Check the spelling of your email address.`,
      },
    ],
    'email_domain_not_found',
  );
}
