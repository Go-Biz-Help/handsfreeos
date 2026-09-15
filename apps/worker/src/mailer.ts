import nodemailer from 'nodemailer';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** 'high' marks it urgent in mail apps (X-Priority and Importance headers): emergencies only. */
  readonly priority?: 'high';
}

export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

/** SMTP mailer: Mailpit locally (no auth), a real provider in production via SMTP_URL. */
export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      const info = await transport.sendMail({ from, ...message });
      return { messageId: String(info.messageId ?? '') };
    },
  };
}
