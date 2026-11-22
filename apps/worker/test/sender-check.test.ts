/**
 * Whether an email's From domain vouched for it (FDE1), from the headers Postmark's inbound webhook carries: its
 * spam filter's rules (X-Spam-Tests), its SPF check (Received-SPF) and the envelope sender (Return-Path).
 */
import { describe, expect, it } from 'vitest';
import type { MailHeader } from '../src/email/render';
import { checkSender, sameSender } from '../src/email/sender-check';

const h = (Name: string, Value: string): MailHeader => ({ Name, Value });

/** A Gmail user writing in, as Postmark delivers it: its own headers first, then the mail's. */
const gmail: MailHeader[] = [
  h('Return-Path', '<jane.doe@gmail.com>'),
  h(
    'Received',
    'by p-pm-inboundg02a-aws-useast1a.inbound.postmarkapp.com (Postfix, from userid 996)',
  ),
  h('X-Spam-Checker-Version', 'SpamAssassin 3.4.0 (2014-02-07) on p-pm-inboundg02a'),
  h('X-Spam-Status', 'No'),
  h('X-Spam-Score', '-0.1'),
  h(
    'X-Spam-Tests',
    'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,FREEMAIL_FROM,\n\tRCVD_IN_DNSWL_NONE,SPF_HELO_NONE,SPF_PASS',
  ),
  h(
    'Received-SPF',
    'pass (sender SPF authorized) identity=mailfrom; client-ip=209.85.208.48; helo=mail-ed1-f48.google.com; envelope-from=jane.doe@gmail.com; receiver=<UNKNOWN>',
  ),
  h('DKIM-Signature', 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.com; s=20230601; h=from:to'),
];

describe('whether the From domain vouched for an email', () => {
  it('takes Gmail’s signed mail as Gmail’s', () => {
    expect(checkSender(gmail, 'jane.doe@gmail.com')).toEqual({ verified: true, how: 'dkim' });
  });

  it('takes DMARC’s pass, and its fail over anything else', () => {
    expect(checkSender([h('X-Spam-Tests', 'DMARC_PASS')], 'a@acme.com').how).toBe('dmarc');
    expect(
      checkSender([h('X-Spam-Tests', 'DKIM_VALID_AU,DMARC_QUAR')], 'a@acme.com').verified,
    ).toBe(false);
  });

  it('takes an SPF pass only for an envelope sender at the From domain', () => {
    const own = [
      h('Return-Path', '<bounces+123@mail.acme.com>'),
      h('X-Spam-Tests', 'SPF_HELO_NONE,SPF_PASS'),
      h(
        'Received-SPF',
        'pass (sender SPF authorized) identity=mailfrom; client-ip=1.2.3.4; helo=mx.acme.com; envelope-from=bounces+123@mail.acme.com; receiver=<UNKNOWN>',
      ),
    ];
    expect(checkSender(own, 'office@acme.com')).toEqual({ verified: true, how: 'spf' });
  });

  it('refuses a forged From that passed SPF for the forger’s own domain', () => {
    // Sent from the forger's server: SPF passes for attacker.example, which is not gmail.com, and there's no DKIM.
    const forged = [
      h('Return-Path', '<x@attacker.example>'),
      h('X-Spam-Score', '0.4'),
      h(
        'X-Spam-Tests',
        'FREEMAIL_FORGED_FROMDOMAIN,FREEMAIL_FROM,HEADER_FROM_DIFFERENT_DOMAINS,SPF_PASS',
      ),
      h(
        'Received-SPF',
        'pass (sender SPF authorized) identity=mailfrom; client-ip=203.0.113.9; helo=mail.attacker.example; envelope-from=x@attacker.example; receiver=<UNKNOWN>',
      ),
      // What the forger wrote, never read: Postmark doesn't add one.
      h('Authentication-Results', 'mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass'),
    ];
    expect(checkSender(forged, 'jane.doe@gmail.com')).toEqual({ verified: false, how: null });
  });

  it('refuses a forged Received-SPF that names the customer’s domain', () => {
    // The forger's own header comes after Postmark's, and Return-Path shows the real envelope sender.
    const planted = [
      h('Return-Path', '<x@attacker.example>'),
      h('X-Spam-Tests', 'SPF_PASS'),
      h(
        'Received-SPF',
        'pass (sender SPF authorized) identity=mailfrom; envelope-from=jane.doe@gmail.com',
      ),
    ];
    expect(checkSender(planted, 'jane.doe@gmail.com').verified).toBe(false);
    // And a second X-Spam-Tests means one was written by the sender.
    expect(
      checkSender(
        [h('X-Spam-Tests', 'SPF_FAIL'), h('X-Spam-Tests', 'DKIM_VALID_AU')],
        'jane.doe@gmail.com',
      ).verified,
    ).toBe(false);
  });

  it('refuses a softfail, a neutral or no SPF at all, and mail with no checks', () => {
    const spf = (result: string, tests: string) => [
      h('Return-Path', '<jane@acme.com>'),
      h('X-Spam-Tests', tests),
      h('Received-SPF', `${result} identity=mailfrom; envelope-from=jane@acme.com`),
    ];
    expect(checkSender(spf('softfail', 'SPF_SOFTFAIL'), 'jane@acme.com').verified).toBe(false);
    expect(checkSender(spf('neutral', 'SPF_NEUTRAL'), 'jane@acme.com').verified).toBe(false);
    expect(checkSender(spf('none', 'SPF_NONE'), 'jane@acme.com').verified).toBe(false);
    // The filter's own word beats a Received-SPF that says otherwise.
    expect(checkSender(spf('pass', 'SPF_SOFTFAIL'), 'jane@acme.com').verified).toBe(false);
    // A HELO pass says nothing about the sender.
    expect(
      checkSender(
        [h('Received-SPF', 'pass identity=helo; helo=mx.acme.com; envelope-from=jane@acme.com')],
        'jane@acme.com',
      ).verified,
    ).toBe(false);
    expect(checkSender([], 'jane@acme.com').verified).toBe(false);
    expect(checkSender(gmail, 'not an address').verified).toBe(false);
  });

  it('counts a domain and the ones inside it as one sender, and nothing else', () => {
    expect(sameSender('acme.com', 'acme.com')).toBe(true);
    expect(sameSender('bounces.acme.com', 'acme.com')).toBe(true);
    expect(sameSender('acme.com', 'mail.acme.com')).toBe(true);
    expect(sameSender('notacme.com', 'acme.com')).toBe(false);
    expect(sameSender('evil.co.uk', 'victim.co.uk')).toBe(false);
    expect(sameSender('acme.com.evil.example', 'acme.com')).toBe(false);
    expect(sameSender('com', 'acme.com')).toBe(false);
  });
});
