/**
 * What a practice business is worked for with (Admin → Try onboarding, 20261027027400): its email goes only to the
 * staff member practising, marked, with a line saying who it was for; campaign email goes nowhere; and the carrier,
 * payments and the rest are the stand-ins, whether the work came from the outbox, a job or an HTTP route.
 */
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env';
import type { EmailTransport, OutboundEmail } from '../src/email/transport';
import type { Mailer, MailMessage } from '../src/mailer';
import {
  PRACTICE_SUBJECT,
  createPracticeKit,
  forPractice,
  practiceAware,
  practiceMailer,
  practiceTransport,
} from '../src/practice/kit';
import { inPractice, practiceNow, type PracticeRun } from '../src/practice/scope';
import type { WorkerServices } from '../src/services';

const run: PracticeRun = { organizationId: 'org-1', ownerEmail: 'pat@handsfreeos.test' };

function catchingMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, send: async (m) => (sent.push(m), { messageId: 'm1' }) };
}
function catchingTransport(): EmailTransport & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    name: 'smtp',
    sent,
    send: async (e) => (
      sent.push(e),
      { providerMessageId: 'p1', messageIdHeader: e.messageIdHeader }
    ),
  };
}
const email = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  from: { address: 'hello@practiceplumbing.com', name: 'Practice Plumbing' },
  to: ['customer@example.com'],
  cc: ['partner@example.com'],
  replyTo: 'owner@example.com',
  subject: 'Your quote',
  text: 'Here it is.',
  html: '<html><body><p>Here it is.</p></body></html>',
  messageIdHeader: '<a@b>',
  inReplyTo: null,
  references: [],
  attachments: [],
  metadata: {},
  ...over,
});

describe('a practice business’s email', () => {
  it('HandsFreeOS’s own goes only to the staff member, marked, saying who it was for', async () => {
    const real = catchingMailer();
    await practiceMailer(real, run).send({
      to: 'invitee@example.com',
      cc: ['boss@example.com'],
      replyTo: 'someone@example.com',
      subject: 'You’re invited',
      text: 'Join us.',
      html: '<p>Join us.</p>',
    });
    expect(real.sent).toHaveLength(1);
    const [m] = real.sent;
    expect(m!.to).toBe('pat@handsfreeos.test');
    expect(m!.cc).toBeUndefined();
    expect(m!.replyTo).toBeUndefined();
    expect(m!.subject).toBe(`${PRACTICE_SUBJECT} You’re invited`);
    expect(m!.text).toContain('would have gone to invitee@example.com, boss@example.com');
    expect(m!.html).toContain('invitee@example.com');
  });

  it('the business’s own goes to the staff member from our address, and campaign email goes nowhere', async () => {
    const real = catchingTransport();
    const transport = practiceTransport(real, run, 'mail.handsfreeos.test');
    await transport.send(email());
    await transport.send(email({ bulk: true, subject: 'Spring sale' }));
    expect(real.sent).toHaveLength(1);
    const [e] = real.sent;
    expect(e!.to).toEqual(['pat@handsfreeos.test']);
    expect(e!.cc).toEqual([]);
    expect(e!.replyTo).toBeNull();
    expect(e!.from).toEqual({
      address: 'practice@mail.handsfreeos.test',
      name: 'Practice Plumbing',
    });
    expect(e!.subject).toBe(`${PRACTICE_SUBJECT} Your quote`);
    // The note goes first thing inside the body.
    expect(e!.html).toMatch(
      /<body><p style="[^"]*">Practice business: this email would have gone to/,
    );
  });

  it('with nobody to send it to, nothing goes', async () => {
    const mailer = catchingMailer();
    const transport = catchingTransport();
    const nobody = { organizationId: 'org-2', ownerEmail: null };
    await practiceMailer(mailer, nobody).send({ to: 'a@b.c', subject: 's', text: 't', html: 'h' });
    await practiceTransport(transport, nobody, 'mail.handsfreeos.test').send(email());
    expect(mailer.sent).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('the stand-ins', () => {
  const env = readEnv({
    DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db',
    SMTP_URL: 'smtp://h',
    WORKER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const kit = createPracticeKit(env, pino({ level: 'silent' }));
  const realMailer = catchingMailer();
  const realTransport = catchingTransport();
  const deps = {
    mailer: realMailer,
    telephony: { name: 'real carrier' },
    payments: { name: 'real payments' },
    opinly: { name: 'real opinly' },
    email: {
      transport: realTransport,
      domains: { name: 'real domains' },
      mailDomain: 'mail.hfos.test',
    },
    addonConnect: { fake: false, platformKeys: {} },
    practice: kit,
  } as unknown as WorkerServices;

  it('stand in for the carrier, payments and the rest, only for a practice business', () => {
    const swapped = forPractice(deps, run);
    expect(swapped.telephony).toBe(kit.telephony);
    expect(swapped.payments).toBe(kit.payments);
    expect(swapped.email.domains).toBe(kit.emailDomains);
    expect(swapped.opinly).toBeNull();
    expect(swapped.addonConnect?.fake).toBe(true);
    expect(forPractice(deps, null)).toBe(deps);
  });

  it('answer an HTTP route’s deps while its work is for a practice business, and only then', async () => {
    const aware = practiceAware(deps);
    expect(aware.telephony).toBe(deps.telephony);
    await inPractice(run, async () => {
      expect(practiceNow()).toEqual(run);
      // Still in practice after an await, as a route's work is.
      await Promise.resolve();
      expect(aware.telephony).toBe(kit.telephony);
      await aware.mailer.send({ to: 'x@example.com', subject: 'Hi', text: 't', html: 'h' });
    });
    expect(practiceNow()).toBeNull();
    expect(aware.telephony).toBe(deps.telephony);
    expect(realMailer.sent.map((m) => m.to)).toEqual(['pat@handsfreeos.test']);
  });
});
