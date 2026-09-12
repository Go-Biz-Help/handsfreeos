import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAILPIT } from './helpers';
import { WORKER_URL } from './telephony';

/**
 * The worker's Postmark webhook login. Locally it is a fixed pair that is not a secret
 * (apps/worker/src/email/local.ts); a developer who set their own in apps/worker/.env gets theirs. Read
 * from the file, never from process.env: Playwright hands its environment to the servers it starts.
 */
function webhookLogin(): string {
  let user = 'postmark';
  let password = 'local-postmark-webhook-password';
  try {
    const text = readFileSync(path.resolve('../worker/.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*(POSTMARK_WEBHOOK_USER|POSTMARK_WEBHOOK_PASSWORD)\s*=\s*(.*?)\s*$/.exec(line);
      const value = m?.[2]?.replace(/^['"]|['"]$/g, '');
      if (!m || !value) continue;
      if (m[1] === 'POSTMARK_WEBHOOK_USER') user = value;
      else password = value;
    }
  } catch {
    // No worker env file: the local defaults.
  }
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

export interface InboundAttachment {
  readonly Name: string;
  readonly Content: string;
  readonly ContentType: string;
  readonly ContentLength: number;
  readonly ContentID?: string;
}

/** A file for the composer's file input. */
export const pdfFile = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% HandsFreeOS test file\n'),
});

/** The same file as Postmark hands it over on inbound mail. */
export function pdfAttachment(name: string): InboundAttachment {
  const bytes = pdfFile(name).buffer;
  return {
    Name: name,
    Content: bytes.toString('base64'),
    ContentType: 'application/pdf',
    ContentLength: bytes.length,
  };
}

/**
 * Someone emails the business, posted to the worker the way Postmark's inbound webhook does. A reply
 * to our Reply-To address carries its token after the "+", which Postmark hands over as the MailboxHash.
 */
export async function emailFromCustomer(opts: {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  attachments?: InboundAttachment[];
}): Promise<string> {
  const hash = /\+([^@]+)@/.exec(opts.to)?.[1] ?? '';
  const messageId = randomUUID();
  const body = {
    MessageID: messageId,
    From: opts.from,
    FromName: opts.fromName ?? '',
    FromFull: { Email: opts.from, Name: opts.fromName ?? '', MailboxHash: '' },
    To: opts.to,
    ToFull: [{ Email: opts.to, Name: '', MailboxHash: hash }],
    CcFull: [],
    OriginalRecipient: opts.to,
    MailboxHash: hash,
    Subject: opts.subject,
    Date: new Date().toUTCString(),
    TextBody: opts.text,
    HtmlBody: '',
    Headers: [{ Name: 'Message-ID', Value: `<${randomUUID()}@mail.example.com>` }],
    Attachments: opts.attachments ?? [],
  };
  const res = await fetch(`${WORKER_URL}/webhooks/postmark/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: webhookLogin() },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`the worker refused the inbound email (${res.status})`);
  return messageId;
}

interface MailpitAddress {
  readonly Name: string;
  readonly Address: string;
}

/** What Mailpit caught: who it says it's from, where replies go, and the attached files. */
export async function mailDetail(id: string): Promise<{
  from: MailpitAddress;
  replyTo: MailpitAddress[];
  attachments: string[];
}> {
  const m = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
    From: MailpitAddress;
    ReplyTo: MailpitAddress[] | null;
    Attachments: { FileName: string }[] | null;
  };
  return {
    from: m.From,
    replyTo: m.ReplyTo ?? [],
    attachments: (m.Attachments ?? []).map((a) => a.FileName),
  };
}
