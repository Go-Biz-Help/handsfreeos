import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import { createLocalEmail } from './local';
import { createPostmark } from './postmark';
import type { EmailDomains, EmailTransport } from './transport';

export interface EmailServices {
  readonly transport: EmailTransport;
  readonly domains: EmailDomains;
  /** The shared subdomain every workspace sends from and replies come back to. */
  readonly mailDomain: string;
  /** The basic auth Postmark sends with its webhooks (it signs nothing). */
  readonly webhookUser: string;
  readonly webhookPassword: string;
}

export function createEmail(env: WorkerEnv, log: Logger): EmailServices {
  const base = {
    mailDomain: env.mailDomain,
    webhookUser: env.postmarkWebhookUser,
    webhookPassword: env.postmarkWebhookPassword,
  };
  if (env.emailTransport === 'postmark')
    return {
      ...base,
      ...createPostmark({
        serverToken: env.postmarkServerToken!,
        accountToken: env.postmarkAccountToken,
        stream: env.postmarkMessageStream,
      }),
    };
  return {
    ...base,
    ...createLocalEmail({
      smtpUrl: env.smtpUrl,
      eventsUrl: `${env.publicUrl}/webhooks/postmark/events`,
      webhookUser: env.postmarkWebhookUser,
      webhookPassword: env.postmarkWebhookPassword,
      log,
    }),
  };
}
