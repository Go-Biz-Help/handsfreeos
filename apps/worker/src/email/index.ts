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
  /**
   * Campaign email can go: Postmark has a Broadcasts stream (POSTMARK_BROADCAST_STREAM), or it's the local
   * stand-in. False pauses an email campaign rather than sending bulk mail on the one-to-one stream.
   */
  readonly bulkReady: boolean;
}

/**
 * Where each receiving domain's Postmark server posts its mail (M19): the same inbound webhook as every other, with
 * the basic auth Postmark sends (it signs nothing).
 */
function inboundHookUrl(env: WorkerEnv): string {
  const url = new URL(`${env.publicUrl}/webhooks/postmark/inbound`);
  url.username = env.postmarkWebhookUser;
  url.password = env.postmarkWebhookPassword;
  return url.toString();
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
      bulkReady: !!env.postmarkBroadcastStream,
      ...createPostmark({
        serverToken: env.postmarkServerToken!,
        accountToken: env.postmarkAccountToken,
        stream: env.postmarkMessageStream,
        broadcastStream: env.postmarkBroadcastStream,
        inboundHookUrl: inboundHookUrl(env),
      }),
    };
  return {
    ...base,
    bulkReady: true,
    ...createLocalEmail({
      smtpUrl: env.smtpUrl,
      eventsUrl: `${env.publicUrl}/webhooks/postmark/events`,
      webhookUser: env.postmarkWebhookUser,
      webhookPassword: env.postmarkWebhookPassword,
      log,
    }),
  };
}
