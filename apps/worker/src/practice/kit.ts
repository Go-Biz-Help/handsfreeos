/**
 * What a practice business gets instead of the outside world (Admin → Try onboarding, 20261027027200). Everything a
 * business can reach outside HandsFreeOS is swapped for the stand-ins local development and the tests use:
 *
 * - **The phone carrier**: numbers are "bought", texts and calls "go", registrations are "approved", in memory.
 * - **Payments, calendars, mailboxes, reviews, Facebook and Instagram, web addresses**: their stand-ins. Connecting
 *   one from a practice business ends on a page that says it's pretended (http/oauth.ts).
 * - **Sending domains**: the stand-in Postmark, so a domain "verifies" with nothing made at the provider.
 * - **Email**: the one thing that really goes, and only to the staff member practising, marked "[Practice]", from our
 *   own shared address, with a line saying who it was for. Campaign email to many doesn't go at all.
 * - **Opinly**: nothing, so a practice sign-up is never counted as one.
 *
 * The AI, reading websites, pictures, files and pushes to the staff member's own phone stay real, on purpose.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import { createCalendars } from '../calendar/index';
import { createLocalEmail } from '../email/local';
import type { EmailServices } from '../email/index';
import type { EmailTransport, OutboundEmail } from '../email/transport';
import { createSiteHost } from '../hosting';
import type { Mailer, MailMessage } from '../mailer';
import { createMailboxes } from '../mailbox/index';
import { createPayments } from '../payments/index';
import { createReviews } from '../reviews/index';
import type { WorkerServices } from '../services';
import { createMeta } from '../social/index';
import { createFakeTelephony } from '../telephony/fake';
import { practiceNow, type PracticeRun } from './scope';

/** The stand-ins, made once when the worker starts. */
export interface PracticeKit {
  readonly telephony: WorkerServices['telephony'];
  readonly emailDomains: EmailServices['domains'];
  readonly mailboxes: WorkerServices['mailboxes'];
  readonly calendars: WorkerServices['calendars'];
  readonly reviews: WorkerServices['reviews'];
  readonly social: WorkerServices['social'];
  readonly payments: WorkerServices['payments'];
  readonly siteHost: WorkerServices['siteHost'];
}

/** How long the stand-in carrier takes to approve a texting registration: long enough to see the wait. */
const PRACTICE_APPROVAL_MS = 30_000;

export function createPracticeKit(env: WorkerEnv, log: Logger): PracticeKit {
  // The same factories, told to make their stand-ins. Nothing else in `env` changes.
  const standIns: WorkerEnv = {
    ...env,
    mailboxProvider: 'fake',
    calendarProvider: 'fake',
    reviewProvider: 'fake',
    metaProvider: 'fake',
    paymentsProvider: 'fake',
    paymentsFakeSettleMs: null,
    siteHost: 'fake',
  };
  const local = createLocalEmail({
    // Never used: only its domains are, and they make nothing anywhere.
    smtpUrl: 'smtp://practice.invalid:25',
    eventsUrl: null,
    webhookUser: env.postmarkWebhookUser,
    webhookPassword: env.postmarkWebhookPassword,
    log,
  });
  return {
    telephony: createFakeTelephony({
      approvalMs: PRACTICE_APPROVAL_MS,
      // Nobody to post a delivery report to: a text "sent" here stays sent.
      callbacks: false,
      log: log.child({ practice: true }),
      autoTransferMs: PRACTICE_APPROVAL_MS * 3,
    }),
    emailDomains: local.domains,
    mailboxes: createMailboxes(standIns),
    calendars: createCalendars(standIns),
    reviews: createReviews(standIns),
    social: createMeta(standIns),
    payments: createPayments(standIns),
    siteHost: createSiteHost(standIns),
  };
}

export const PRACTICE_SUBJECT = '[Practice]';

/** The line at the top of a practice business's email: who it was really for. */
export function practiceNote(to: readonly string[]): string {
  const list = to.filter(Boolean).join(', ');
  return list
    ? `Practice business: this email would have gone to ${list}. Nobody else got it.`
    : 'Practice business: nobody else got this email.';
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The note, first thing in the body: after `<body …>` when there is one. */
function withNote(html: string, note: string): string {
  const line = `<p style="margin:0 0 12px;padding:8px 12px;border-radius:8px;background:#fff4d6;color:#6b4e00;font:13px/1.4 system-ui,sans-serif;">${escapeHtml(note)}</p>`;
  const body = /<body[^>]*>/i.exec(html);
  return body ? html.replace(body[0], `${body[0]}${line}`) : `${line}${html}`;
}

const subjectOf = (subject: string) =>
  subject.startsWith(PRACTICE_SUBJECT) ? subject : `${PRACTICE_SUBJECT} ${subject}`;

/** HandsFreeOS's own email (invitations, alerts, a handover): to the staff member only. */
export function practiceMailer(real: Mailer, run: PracticeRun): Mailer {
  return {
    async send(m: MailMessage) {
      if (!run.ownerEmail) return { messageId: `practice-${randomUUID()}` };
      const note = practiceNote([m.to, ...(m.cc ?? [])]);
      const { cc: _cc, replyTo: _replyTo, ...rest } = m;
      return real.send({
        ...rest,
        to: run.ownerEmail,
        subject: subjectOf(m.subject),
        text: `${note}\n\n${m.text}`,
        html: withNote(m.html, note),
      });
    },
  };
}

/**
 * The business's own email (to customers, from its address): to the staff member only, from our shared address, since
 * a practice business's own domain was never really set up. Campaign email to many is "sent" without going anywhere.
 */
export function practiceTransport(
  real: EmailTransport,
  run: PracticeRun,
  mailDomain: string,
): EmailTransport {
  return {
    name: real.name,
    async send(email: OutboundEmail) {
      const pretend = { providerMessageId: `practice-${randomUUID()}`, messageIdHeader: email.messageIdHeader };
      if (email.bulk || !run.ownerEmail) return pretend;
      const note = practiceNote([...email.to, ...email.cc]);
      return real.send({
        ...email,
        from: { address: `practice@${mailDomain}`, name: email.from.name },
        to: [run.ownerEmail],
        cc: [],
        replyTo: null,
        subject: subjectOf(email.subject),
        text: `${note}\n\n${email.text}`,
        html: withNote(email.html, note),
      });
    },
  };
}

/** The services a practice business is worked for with: the real ones, with the outside swapped for the kit's. */
export function practiceServices(real: WorkerServices, run: PracticeRun): Partial<WorkerServices> {
  const kit = real.practice;
  // A worker without a kit (some tests) still never reaches outside for a practice business: email stays ours.
  const email: EmailServices = {
    ...real.email,
    transport: practiceTransport(real.email.transport, run, real.email.mailDomain),
    ...(kit ? { domains: kit.emailDomains } : {}),
  };
  return {
    mailer: practiceMailer(real.mailer, run),
    email,
    opinly: null,
    ...(real.addonConnect ? { addonConnect: { ...real.addonConnect, fake: true } } : {}),
    ...(kit
      ? {
          telephony: kit.telephony,
          mailboxes: kit.mailboxes,
          calendars: kit.calendars,
          reviews: kit.reviews,
          social: kit.social,
          payments: kit.payments,
          siteHost: kit.siteHost,
        }
      : {}),
  };
}

/** `deps` as a practice business is worked for with, when it is one; `deps` itself otherwise. */
export function forPractice<T extends WorkerServices>(deps: T, run: PracticeRun | null): T {
  return run ? { ...deps, ...practiceServices(deps, run) } : deps;
}

/**
 * `deps` that answer with the practice services whenever the work in hand is for a practice business
 * (`practiceNow()`), for the HTTP routes, which hold on to the one `deps` they were registered with.
 */
export function practiceAware<T extends WorkerServices>(deps: T): T {
  const made = new Map<string, Partial<WorkerServices>>();
  return new Proxy(deps, {
    get(target, prop, receiver) {
      const run = practiceNow();
      if (run && typeof prop === 'string') {
        let swap = made.get(run.organizationId);
        if (!swap) {
          swap = practiceServices(target, run);
          if (made.size > 500) made.clear();
          made.set(run.organizationId, swap);
        }
        if (Object.prototype.hasOwnProperty.call(swap, prop))
          return (swap as Record<string, unknown>)[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
