/**
 * E-sign (round five, step 7): a deal's document sent for signing through the brokerage's DocuSign or Dotloop, and
 * where it stands, in words. Browser-safe and pure: the commands, the screens and the Assistant say the same thing.
 *
 * HandsFreeOS prepares it there (the document and its signers); the agent places the fields and sends it in that
 * service, where signing happens. Nothing is signed on anyone's behalf.
 */

export const ESIGN_PROVIDERS = { docusign: 'DocuSign', dotloop: 'Dotloop' } as const;
export type EsignProvider = keyof typeof ESIGN_PROVIDERS;
export const ESIGN_PROVIDER_KEYS = Object.keys(ESIGN_PROVIDERS) as [
  EsignProvider,
  ...EsignProvider[],
];

export const ESIGN_STATES = {
  preparing: 'Getting it ready',
  draft: 'Ready to send',
  sent: 'Out for signing',
  completed: 'Signed',
  declined: 'Declined',
  voided: 'Voided',
  failed: 'Didn’t go',
} as const;
export type EsignState = keyof typeof ESIGN_STATES;
export const ESIGN_STATE_KEYS = Object.keys(ESIGN_STATES) as [EsignState, ...EsignState[]];
/** Still with the service: looked at again until it's done. */
export const ESIGN_OPEN: readonly EsignState[] = ['draft', 'sent'];

export const SIGNER_STATES = {
  waiting: 'Waiting',
  sent: 'Sent',
  opened: 'Opened',
  signed: 'Signed',
  declined: 'Declined',
} as const;
export type SignerState = keyof typeof SIGNER_STATES;
export const SIGNER_STATE_KEYS = Object.keys(SIGNER_STATES) as [SignerState, ...SignerState[]];

export interface EsignSigner {
  readonly name: string;
  readonly email: string;
  /** Who signs first: 1, 2… */
  readonly order: number;
  readonly state: SignerState;
  readonly signedAt: string | null;
}

/** What to do now, in words, for where it stands. */
export function esignWords(
  state: EsignState,
  provider: EsignProvider,
  failure: string | null,
): string {
  const name = ESIGN_PROVIDERS[provider];
  switch (state) {
    case 'preparing':
      return `Getting it ready in ${name}…`;
    case 'draft':
      return provider === 'dotloop'
        ? `It’s in a loop in ${name}. Place the fields and send it there; once everyone has signed, press “It’s signed” here.`
        : `It’s ready in ${name}. Open it, place the fields and send it there.`;
    case 'sent':
      return provider === 'dotloop'
        ? `Out for signing in ${name}. Once everyone has signed, press “It’s signed” here and the signed copy comes back.`
        : `Out for signing in ${name}. The signed copy comes back to Documents on its own.`;
    case 'completed':
      return `Signed. The signed copy${provider === 'docusign' ? ' and its certificate are' : ' is'} in Documents, locked.`;
    case 'declined':
      return `A signer declined in ${name}. Open it there to see why, then send a new one.`;
    case 'voided':
      return 'Voided. Nothing more will be signed on it.';
    case 'failed':
      return failure ?? `${name} couldn’t take it just now. Try again in a few minutes.`;
  }
}

/** "Signed by 1 of 2" */
export function signersWords(signers: readonly Pick<EsignSigner, 'state'>[]): string {
  const signed = signers.filter((s) => s.state === 'signed').length;
  return `Signed by ${signed} of ${signers.length}`;
}
