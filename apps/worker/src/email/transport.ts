/**
 * What the worker needs to send a workspace's email and set up its own domains. Postmark implements it in
 * production; locally the mail lands in Mailpit and domains verify themselves, so the same paths run.
 */

export interface EmailAttachment {
  readonly name: string;
  readonly contentType: string;
  readonly content: Buffer;
  /** For images the HTML shows inline (cid:). */
  readonly contentId?: string;
}

export interface OutboundEmail {
  readonly from: { readonly address: string; readonly name: string };
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Our own Message-ID, angle brackets included: the customer's reply points back at it. */
  readonly messageIdHeader: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly attachments: readonly EmailAttachment[];
  /** Comes back on the delivery, bounce and complaint events (strings, 10 fields at most). */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SentEmail {
  readonly providerMessageId: string;
  readonly messageIdHeader: string;
}

export interface EmailTransport {
  readonly name: 'postmark' | 'smtp';
  send(email: OutboundEmail): Promise<SentEmail>;
}

/** A workspace domain as the mail service sees it: the DNS records to add and what it has verified. */
export interface DomainState {
  readonly providerDomainId: string;
  readonly dkimHost: string | null;
  readonly dkimValue: string | null;
  readonly returnPathHost: string | null;
  readonly returnPathValue: string | null;
  readonly dkimVerified: boolean;
  readonly returnPathVerified: boolean;
}

export interface EmailDomains {
  create(domain: string): Promise<DomainState>;
  get(providerDomainId: string): Promise<DomainState>;
  /** Asks the service to look for the DNS records now; a record that isn't there yet is not an error. */
  verify(providerDomainId: string): Promise<DomainState>;
  remove(providerDomainId: string): Promise<void>;
}

/** A refusal. Permanent ones (a bad address, a stopped recipient) are recorded on the message; the rest retry. */
export class EmailError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

export const isPermanentEmailError = (e: unknown): e is EmailError =>
  e instanceof EmailError && e.permanent;

/** `"Lone Star HVAC" <lone-star@mail.handsfreeos.com>` (quotes and angle brackets in names removed). */
export const mailbox = (name: string, address: string): string =>
  `"${name.replace(/["<>\\]/g, '').trim() || address}" <${address}>`;
