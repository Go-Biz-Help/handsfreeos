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
  /** More headers: a campaign email's `List-Unsubscribe` and `List-Unsubscribe-Post`. */
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
  /**
   * A campaign email, one of many: Postmark's broadcast stream, never the one-to-one stream (whose approval
   * says "no bulk sends").
   */
  readonly bulk?: boolean;
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
  /**
   * Whether the domain's mail comes to the service (M19): its MX names the service's inbound host. Null when DNS
   * didn't answer, which says nothing either way.
   */
  receives(domain: string): Promise<boolean | null>;
  /**
   * Whether the claim's token is published at the domain's ownership host (`_hfos-verify.<domain>`, M19): the
   * business that set the name up is this one. Null when DNS didn't answer.
   */
  owns(domain: string, token: string): Promise<boolean | null>;
  /**
   * A server of the service's own that receives the domain's mail and posts it to our inbound webhook (M19), made
   * or found again (a retry, or a domain that received before). Returns its id. Refusals are permanent
   * `EmailError`s: see `INBOUND_REFUSALS`.
   */
  openInbound(domain: string): Promise<string>;
  /** The domain's server stops receiving: removed, or unhooked where the service won't let us remove it. */
  closeInbound(serverId: string): Promise<void>;
}

/** Why the service wouldn't receive a domain's mail (Postmark's codes; the local stand-in uses the same). */
export const INBOUND_REFUSALS = {
  /** Another server, in any account, already receives the domain. */
  elsewhere: '602',
  /** The account's plan has no room for another server. */
  full: '614',
} as const;

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
