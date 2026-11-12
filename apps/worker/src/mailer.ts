import nodemailer from 'nodemailer';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** 'high' marks it urgent in mail apps (X-Priority and Importance headers): emergencies only. */
  readonly priority?: 'high';
  /** Files sent with it: a signed document's copy to someone on the team. */
  readonly attachments?: readonly MailAttachment[];
  /** The name it's from, in place of HandsFreeOS's own: "Shop Your Solar via HandsFreeOS". The address stays ours. */
  readonly fromName?: string;
  /** Where replies go, when that isn't us: the person a business's email was sent for. */
  readonly replyTo?: string;
  /** Copied in: the person it was sent for, so they have what went. */
  readonly cc?: readonly string[];
}

export interface MailAttachment {
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

/** SMTP mailer: Mailpit locally (no auth), a real provider in production via SMTP_URL. */
export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      const { attachments, fromName, cc, ...rest } = message;
      const info = await transport.sendMail({
        from: fromName ? { name: fromName, address: addressOf(from) } : from,
        ...rest,
        ...(cc?.length ? { cc: [...cc] } : {}),
        ...(attachments?.length ? { attachments: attachments.map((a) => ({ ...a })) } : {}),
      });
      return { messageId: String(info.messageId ?? '') };
    },
  };
}

/** The address in a From line: `hello@handsfreeos.com` out of `HandsFreeOS <hello@handsfreeos.com>`. */
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim();
}
