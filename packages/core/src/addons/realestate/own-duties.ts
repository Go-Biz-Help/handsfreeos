/**
 * Duties that aren't rows of the catalog (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Duties"): the phone check
 * a changed wire needs, and a duty a person writes on one deal. Their keys start with W: `W-00` is the wire check
 * (each report another pass), and `W-01` onwards are the deal's own. Browser-safe and pure.
 */
import type {
  AccountableRole,
  Materiality,
  ProofRule,
  ResolvedDuty,
  TrackerCode,
} from './catalog/types';
import type { DealSide, DealStage } from './states';

export const WIRE_CHECK_KEY = 'W-00';

/** What the person checking says, in their own name, when they complete it. */
export const WIRE_CHECK_WORDS =
  'I called the title or escrow company at a number I found myself, not one in the message, and they confirmed the wiring instructions';

/**
 * "Wiring instructions changed" (spec §22, "Wire change"): a critical hold until a person checks by phone, at a
 * number they found themselves. Never automatic; nothing relays new instructions.
 */
export function wireCheck(side: DealSide, stage: DealStage): ResolvedDuty {
  return {
    id: WIRE_CHECK_KEY as ResolvedDuty['id'],
    side,
    title: 'Verify changed wiring instructions by phone',
    phase: 'Both / closing',
    behavior:
      'Someone said the wiring instructions changed. Hold every payment until a person calls the title or escrow company at a number they found themselves, and they confirm.',
    spec: { owner: 'Agent / settlement provider', mode: 'Control', share: 'High' },
    tracker: 'COMPLY',
    trigger: { on: 'stage', stage },
    due: { kind: 'after_start', hours: 2 },
    proof: {
      mode: 'all',
      items: [{ kind: 'attestation', words: WIRE_CHECK_WORDS }, { kind: 'note' }],
    },
    accountable: 'agent',
    performedBy: ['title'],
    automation: 'AX',
    materiality: 'critical',
    reminders: [],
  };
}

/** Proof a person can ask of a duty they write. */
export const OWN_PROOF = ['none', 'note', 'file', 'attestation'] as const;
export type OwnProof = (typeof OWN_PROOF)[number];

/** A duty written on one deal. */
export function ownDuty(input: {
  readonly key: string;
  readonly side: DealSide;
  readonly stage: DealStage;
  readonly title: string;
  readonly details?: string | null;
  readonly tracker: TrackerCode;
  readonly accountable: AccountableRole;
  readonly materiality: Materiality;
  readonly proof: OwnProof;
  readonly attestation?: string | null;
}): ResolvedDuty {
  const proof: ProofRule | null =
    input.proof === 'none'
      ? null
      : {
          mode: 'all',
          items: [
            input.proof === 'attestation'
              ? { kind: 'attestation', words: input.attestation?.trim() || 'I did it' }
              : { kind: input.proof },
          ],
        };
  return {
    id: input.key as ResolvedDuty['id'],
    side: input.side,
    title: input.title,
    phase: 'Added on this deal',
    behavior: input.details?.trim() ?? '',
    spec: { owner: '', mode: '', share: '' },
    tracker: input.tracker,
    trigger: { on: 'stage', stage: input.stage },
    due: { kind: 'none' },
    proof,
    accountable: input.accountable,
    automation: 'A0',
    materiality: input.materiality,
    reminders: [7, 3, 1],
  };
}
