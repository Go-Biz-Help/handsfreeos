/**
 * Local and test email: messages go to Mailpit over SMTP, the "mail service" reports delivery to the
 * worker's own events webhook (an address at bounce.example.com bounces instead), and domains verify when
 * asked. A receiving domain's MX "points here" too, unless its name says otherwise. Nothing leaves the machine.
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import {
  EmailError,
  INBOUND_REFUSALS,
  type DomainState,
  type EmailDomains,
  type EmailTransport,
} from './transport';

/** Not a secret: local and test webhooks use it, and the browser tests post with it. */
export const LOCAL_WEBHOOK_PASSWORD = 'local-postmark-webhook-password';

const localState = (id: string, domain: string, verified: boolean): DomainState => ({
  providerDomainId: id,
  dkimHost: `20260912000000pm._domainkey.${domain}`,
  dkimValue: 'k=rsa; p=LOCAL-DEVELOPMENT-KEY-NOT-REAL',
  returnPathHost: `pm-bounces.${domain}`,
  returnPathValue: 'pm.mtasv.net',
  dkimVerified: verified,
  returnPathVerified: verified,
});

export function createLocalEmail(opts: {
  smtpUrl: string;
  /** Where to post the delivery reports (the worker's own events webhook); null in unit tests. */
  eventsUrl: string | null;
  webhookUser: string;
  webhookPassword: string;
  log: Logger;
}): { transport: EmailTransport; domains: EmailDomains } {
  const smtp = nodemailer.createTransport(opts.smtpUrl);
  const domains = new Map<string, { name: string; verified: boolean; checks: number }>();
  const mxChecks = new Map<string, number>();
  /** The receiving domains' stand-in servers. */
  const inbound = new Set<string>();
  const report = (payload: Record<string, unknown>) => {
    if (!opts.eventsUrl) return;
    const url = opts.eventsUrl;
    const timer = setTimeout(() => {
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${opts.webhookUser}:${opts.webhookPassword}`).toString('base64')}`,
        },
        body: JSON.stringify(payload),
      }).catch((e: unknown) => opts.log.warn({ err: e }, 'local email report failed'));
    }, 600);
    timer.unref();
  };

  return {
    transport: {
      name: 'smtp',
      async send(email) {
        await smtp.sendMail({
          from: { name: email.from.name, address: email.from.address },
          to: [...email.to],
          cc: [...email.cc],
          ...(email.replyTo ? { replyTo: email.replyTo } : {}),
          subject: email.subject,
          text: email.text,
          html: email.html,
          messageId: email.messageIdHeader,
          ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
          ...(email.references.length > 0 ? { references: [...email.references] } : {}),
          ...(email.headers?.length
            ? { headers: email.headers.map((h) => ({ key: h.name, value: h.value })) }
            : {}),
          attachments: email.attachments.map((a) => ({
            filename: a.name,
            content: a.content,
            contentType: a.contentType,
            ...(a.contentId ? { cid: a.contentId } : {}),
          })),
        });
        const providerMessageId = `local-${randomUUID()}`;
        const to = email.to[0] ?? '';
        const at = new Date().toISOString();
        report(
          /@bounce\.example\.com$/i.test(to)
            ? {
                RecordType: 'Bounce',
                Type: 'HardBounce',
                TypeCode: 1,
                MessageID: providerMessageId,
                Email: to,
                Inactive: true,
                CanActivate: true,
                Description: 'The server was unable to deliver your message (ex: unknown user).',
                Details: 'smtp;550 5.1.1 user unknown',
                BouncedAt: at,
                Metadata: email.metadata,
              }
            : {
                RecordType: 'Delivery',
                MessageID: providerMessageId,
                Recipient: to,
                DeliveredAt: at,
                Details: '250 2.0.0 OK',
                Metadata: email.metadata,
              },
        );
        return { providerMessageId, messageIdHeader: email.messageIdHeader };
      },
    },
    domains: {
      async create(domain) {
        const id = `local-${domain}`;
        domains.set(id, { name: domain, verified: false, checks: 0 });
        return localState(id, domain, false);
      },
      async get(id) {
        const d = domains.get(id);
        // A restarted worker forgets its domains; treat those as verified.
        return localState(id, d?.name ?? id.replace(/^local-/, ''), d?.verified ?? true);
      },
      async verify(id) {
        const known = domains.get(id);
        const name = known?.name ?? id.replace(/^local-/, '');
        const checks = (known?.checks ?? 0) + 1;
        // A domain named lapsed-… verifies the first time, then its records "disappear" (the daily check's case).
        const verified = !(/^lapsed-/.test(name) && checks > 1);
        domains.set(id, { name, verified, checks });
        return localState(id, name, verified);
      },
      async remove(id) {
        domains.delete(id);
      },
      async receives(domain) {
        const checks = (mxChecks.get(domain) ?? 0) + 1;
        mxChecks.set(domain, checks);
        // nomx-… never points here, and a lapsed-… domain does the first time, then stops (the daily check's case).
        return !(/^nomx-/.test(domain) || (/^lapsed-/.test(domain) && checks > 1));
      },
      // The token is always there, except on a squat-… domain, whose TXT record isn't this business's (M19).
      async owns(domain) {
        return !/^squat-/.test(domain);
      },
      // A server for every domain, except elsewhere-… (another account receives it) and full-… (no room left).
      async openInbound(domain) {
        if (/^elsewhere-/.test(domain))
          throw new EmailError(
            'The specified inbound domain is already registered or in use on another server.',
            INBOUND_REFUSALS.elsewhere,
            true,
            422,
          );
        if (/^full-/.test(domain))
          throw new EmailError('Entitlement limit reached.', INBOUND_REFUSALS.full, true, 422);
        inbound.add(`local-inbound-${domain}`);
        return `local-inbound-${domain}`;
      },
      async closeInbound(serverId) {
        inbound.delete(serverId);
      },
    },
  };
}
