/**
 * An e-signature service, whichever it is (round five, step 7): what each adapter (./docusign.ts, ./dotloop.ts,
 * ./standin.ts) does, in one shape. An adapter only asks and translates; which account, whether it worked and what
 * to keep are ./index.ts's. A sign-in turned down throws ConnectionRefused; a service that didn't answer throws
 * EsignUnreachable, tried again later.
 */
import type { EsignSigner } from '@hfos/core/addons/realestate/esign';

export interface EsignPrepareRequest {
  readonly subject: string;
  readonly message: string | null;
  readonly signers: readonly Pick<EsignSigner, 'name' | 'email' | 'order'>[];
  readonly document: { readonly name: string; readonly bytes: Buffer };
  /** Where the service sends its updates (DocuSign), or null. */
  readonly webhookUrl: string | null;
  /** The deal, for a Dotloop loop's name and kind. */
  readonly deal: { readonly name: string; readonly side: 'buyer' | 'listing' };
}

export interface EsignPrepared {
  /** The service's own id for it: an envelope's, or a loop's document's. */
  readonly externalId: string;
  /** Where to open it there, when it's always the same (a Dotloop loop); DocuSign's is made each time. */
  readonly openUrl: string | null;
}

/** Where it stands at the service. */
export interface EsignStanding {
  readonly state: 'draft' | 'sent' | 'completed' | 'declined' | 'voided';
  readonly signers: readonly EsignSigner[] | null;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
}

export interface EsignCopies {
  readonly signed: Buffer;
  /** DocuSign's certificate of completion; Dotloop has none. */
  readonly certificate: Buffer | null;
}

export interface EsignService {
  readonly provider: 'docusign' | 'dotloop' | 'standin';
  prepare(request: EsignPrepareRequest, signal: AbortSignal): Promise<EsignPrepared>;
  /** A page to open it on now: to place the fields and send a draft, or to see one that's out. */
  openUrl(
    externalId: string,
    state: 'draft' | 'sent',
    returnUrl: string,
    signal: AbortSignal,
  ): Promise<string>;
  /** Where it stands, or null when the service doesn't say (Dotloop). */
  status(externalId: string, signal: AbortSignal): Promise<EsignStanding | null>;
  copies(externalId: string, signal: AbortSignal): Promise<EsignCopies>;
  /** Stops it at the service, so nobody can sign it. A draft is thrown away. */
  void(externalId: string, reason: string, draft: boolean, signal: AbortSignal): Promise<void>;
  /** Sends it again to whoever hasn't signed yet, when the service can (DocuSign). */
  remind?(externalId: string, signal: AbortSignal): Promise<void>;
}

/** The service didn't answer, or answered with trouble of its own: try again later. */
export class EsignUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EsignUnreachable';
  }
}

/** How an adapter calls a service: `fetch`, or a test's own. */
export type EsignFetch = (url: string, init: RequestInit) => Promise<Response>;
