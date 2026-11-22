/**
 * Whether an email really comes from the address in its From (FDE1). Anyone can write any address there, so mail is
 * taken as that address's owner's only when the From domain vouched for it: DMARC passed, or DKIM passed for the
 * From domain, or SPF passed for an envelope sender at the From domain. Anything else, missing headers included, is
 * unverified. Unverified mail is still filed (nothing is lost), but it's spam-checked like a stranger's, the AI
 * teammate treats it like an unverified website chat, contact AI never takes details from it, and Indeed, the lockbox
 * and ShowingTime readers and support leave it alone.
 *
 * What Postmark's inbound webhook gives us to go on:
 * - X-Spam-Tests: the rules its own spam filter (SpamAssassin) hit, such as DKIM_VALID_AU (a valid DKIM signature
 *   from the author's domain), DMARC_PASS, SPF_PASS or SPF_SOFTFAIL. Its filter writes it, so that's what is believed.
 * - Received-SPF: what its server made of the envelope sender (MAIL FROM, `envelope-from=`), and Return-Path, that
 *   sender as delivered. SPF judges the envelope sender, not From, so a pass counts only when its domain is From's.
 * - Authentication-Results is never read: Postmark doesn't write one, so one in the headers came from whoever sent it.
 *
 * Postmark puts the headers it adds first, so the first of each is its own. Two X-Spam-Tests mean one was forged.
 * Pure: the inbound processors (processors/postmark.ts, support/inbound.ts) and the tests share it.
 */
import { headerOf, type MailHeader } from './render';

export interface SenderCheck {
  /** The From domain vouched for the mail. */
  readonly verified: boolean;
  /** How it did, or null when it didn't. */
  readonly how: 'dmarc' | 'dkim' | 'spf' | null;
}

const UNVERIFIED: SenderCheck = { verified: false, how: null };

const domainOf = (address: string | null | undefined): string | null => {
  const at = (address ?? '').trim().toLowerCase().replace(/^<|>$/g, '');
  const domain = at.slice(at.lastIndexOf('@') + 1).replace(/\.$/, '');
  return at.includes('@') && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
};

/**
 * Whether two domains are one sender's: the same, or one inside the other (bounces.acme.com and acme.com). Without a
 * public-suffix list this is a little stricter than DMARC's "same registrable domain": two siblings (eu.acme.com,
 * us.acme.com) don't count. It never matches two different owners, since no one else can publish SPF or sign DKIM
 * inside a domain.
 */
export function sameSender(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.includes('.')) return false;
  return short === long || long.endsWith(`.${short}`);
}

/** The rules the spam filter hit, upper case; null when there's no list, or more than one (one was forged). */
function spamTests(headers: readonly MailHeader[]): Set<string> | null {
  const lists = headers.filter((h) => h.Name.toLowerCase() === 'x-spam-tests');
  if (lists.length !== 1) return null;
  return new Set(
    lists[0]!.Value.split(/[\s,]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean),
  );
}

/** DMARC failed, whatever DKIM and SPF say (SpamAssassin's DMARC rules: reject, quarantine or none policy). */
const DMARC_FAILED = ['DMARC_REJECT', 'DMARC_QUAR', 'DMARC_NONE'];

/** The envelope sender's own SPF result, unless the filter's own says otherwise (a HELO result is a different check). */
function spfAligned(
  headers: readonly MailHeader[],
  fromDomain: string,
  tests: Set<string> | null,
): boolean {
  if (tests && [...tests].some((t) => /^(T_)?SPF_(?!HELO_)/.test(t) && t !== 'SPF_PASS'))
    return false;
  const spf = headerOf(headers, 'Received-SPF');
  if (!spf || !/^pass\b/i.test(spf)) return false;
  const identity = /\bidentity=([a-z]+)/i.exec(spf)?.[1]?.toLowerCase();
  if (identity && identity !== 'mailfrom') return false;
  const returnPath = domainOf(headerOf(headers, 'Return-Path'));
  const named = /\b(?:envelope-from|smtp\.mailfrom)=\s*"?<?([^\s;"<>]+)/i.exec(spf)?.[1];
  const envelope = named ? domainOf(named) : returnPath;
  if (!envelope) return false;
  // The envelope sender as delivered, when Postmark gives it, is the one SPF judged.
  if (returnPath && returnPath !== envelope) return false;
  return sameSender(envelope, fromDomain);
}

/** Whether Postmark's checks say the From address's domain sent this email. */
export function checkSender(headers: readonly MailHeader[], from: string): SenderCheck {
  const fromDomain = domainOf(from);
  if (!fromDomain) return UNVERIFIED;
  const tests = spamTests(headers);
  if (tests && DMARC_FAILED.some((t) => tests.has(t))) return UNVERIFIED;
  if (tests?.has('DMARC_PASS')) return { verified: true, how: 'dmarc' };
  if (tests?.has('DKIM_VALID_AU')) return { verified: true, how: 'dkim' };
  if (spfAligned(headers, fromDomain, tests)) return { verified: true, how: 'spf' };
  return UNVERIFIED;
}
