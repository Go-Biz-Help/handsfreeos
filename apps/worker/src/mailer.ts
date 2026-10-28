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
      const { attachments, ...rest } = message;
      const info = await transport.sendMail({
        from,
        ...rest,
        ...(attachments?.length ? { attachments: attachments.map((a) => ({ ...a })) } : {}),
      });
      return { messageId: String(info.messageId ?? '') };
    },
  };
}
