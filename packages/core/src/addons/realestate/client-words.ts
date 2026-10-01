/**
 * The client's side of a deal, in their words (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer
 * core"): where it stands, the tasks an agent gives them, and who a task is waiting on. Browser-safe and pure: the
 * portal, the deal's page and the phone say the same thing.
 */
import type { DealStage } from './states';

/** Where a deal stands, as the client reads it: plain words, never the office's own stages. */
export const CLIENT_STAGE_WORDS: Readonly<Record<DealStage, string>> = {
  // Buying.
  lead: 'Getting started',
  onboarding: 'Getting started',
  representation: 'Signing on',
  financing: 'Getting preapproved',
  searching: 'Looking for homes',
  touring: 'Touring homes',
  offer: 'Making an offer',
  negotiation: 'Negotiating',
  under_contract: 'Under contract',
  inspections: 'Inspections',
  appraisal: 'Appraisal',
  financing_title: 'Loan and title',
  closing: 'Getting ready to close',
  possession: 'Moving in',
  past_client: 'Closed',
  // Selling.
  seller_lead: 'Getting started',
  consultation: 'Getting started',
  signed: 'Signed on',
  pre_listing: 'Getting ready to list',
  coming_soon: 'Coming soon',
  active: 'For sale',
  showings: 'Showing the home',
  offers: 'Reviewing offers',
  inspection: 'Inspection',
  sold: 'Sold',
  withdrawn: 'Off the market',
  expired: 'Off the market',
  cancelled: 'Off the market',
};

/** The few steps the client sees their deal move through, and where it is on them. */
const BUYER_STEPS: readonly (readonly DealStage[])[] = [
  ['lead', 'onboarding', 'representation', 'financing'],
  ['searching', 'touring'],
  ['offer', 'negotiation'],
  ['under_contract', 'inspections', 'appraisal', 'financing_title'],
  ['closing', 'possession', 'past_client'],
];
const LISTING_STEPS: readonly (readonly DealStage[])[] = [
  ['seller_lead', 'consultation', 'signed', 'pre_listing'],
  ['coming_soon', 'active', 'showings'],
  ['offers', 'negotiation'],
  ['under_contract', 'inspection', 'appraisal', 'financing_title'],
  ['closing', 'sold', 'past_client'],
];
export const CLIENT_STEP_WORDS = {
  buyer: ['Getting ready', 'Finding a home', 'Making an offer', 'Under contract', 'Closing'],
  listing: ['Getting ready', 'On the market', 'Offers', 'Under contract', 'Closing'],
} as const;

/** Which of the client's five steps a stage is on (0–4); -1 off the market. */
export function clientStep(side: 'buyer' | 'listing', stage: DealStage): number {
  return (side === 'buyer' ? BUYER_STEPS : LISTING_STEPS).findIndex((s) => s.includes(stage));
}

// ---------- the client's tasks ----------

export const CLIENT_TASK_KINDS = {
  upload: 'Upload',
  sign_off: 'Sign off',
  do: 'Do',
  // Round three: the seller's questionnaire about their home, asked from the listing.
  questionnaire: 'Answer',
} as const;
export type ClientTaskKind = keyof typeof CLIENT_TASK_KINDS;
/** The kinds an agent adds by hand; a questionnaire is asked from the listing's facts. */
export const CLIENT_TASK_KIND_KEYS = [
  'upload',
  'sign_off',
  'do',
] as const satisfies readonly ClientTaskKind[];
export const ALL_CLIENT_TASK_KIND_KEYS = Object.keys(CLIENT_TASK_KINDS) as [
  ClientTaskKind,
  ...ClientTaskKind[],
];

/** The tasks an agent gives most often, ready to add. `{agent}` is the deal's main agent's first name. */
export const CLIENT_TASK_PRESETS = {
  preapproval: {
    kind: 'upload',
    title: 'Upload your preapproval letter',
    detail:
      'The letter from your lender saying how much you’re preapproved for. A photo or a PDF is fine.',
    documentKind: 'preapproval',
  },
  buyer_agreement: {
    kind: 'upload',
    title: 'Upload your signed buyer agreement',
    detail: 'Once you’ve signed it, upload a copy here.',
    documentKind: 'buyer_agreement',
  },
  photo_id: {
    kind: 'upload',
    title: 'Upload your photo ID',
    detail:
      'A driver’s license or passport, for the title company. A clear photo of the front is enough.',
    documentKind: null,
  },
  repair_sign_off: {
    kind: 'sign_off',
    title: 'Sign off on the repair request',
    detail: 'Read the repair request, then sign off so {agent} can send it.',
    signOffWords: 'We’ve read the repair request and want {agent} to send it.',
    documentKind: null,
  },
  closing_items: {
    kind: 'do',
    title: 'Bring your photo ID to closing',
    detail:
      'Bring the same ID you uploaded. If you’re bringing a check, it must be a cashier’s check.',
    documentKind: null,
  },
} as const;
export type ClientTaskPreset = keyof typeof CLIENT_TASK_PRESETS;
export const CLIENT_TASK_PRESET_KEYS = Object.keys(CLIENT_TASK_PRESETS) as [
  ClientTaskPreset,
  ...ClientTaskPreset[],
];

/** Puts the agent's first name in a preset's words. */
export const withAgent = (words: string, agentFirstName: string): string =>
  words.replaceAll('{agent}', agentFirstName);

/** Whether a task is done: a sign-off once every client it's for has; anything else once one has. */
export function taskDone(
  task: { readonly kind: ClientTaskKind; readonly forPersonId: string | null },
  clientIds: readonly string[],
  doneBy: readonly string[],
): boolean {
  const due = task.forPersonId ? [task.forPersonId] : clientIds;
  if (!due.length) return false;
  return task.kind === 'sign_off'
    ? due.every((p) => doneBy.includes(p))
    : due.some((p) => doneBy.includes(p));
}

/** Who an open task waits on, by first name: "Waiting on Tuan", "Waiting on Linh and Tuan". */
export function waitingWords(
  task: { readonly kind: ClientTaskKind; readonly forPersonId: string | null },
  clients: readonly { readonly id: string; readonly firstName: string }[],
  doneBy: readonly string[],
): string | null {
  const due = task.forPersonId ? clients.filter((c) => c.id === task.forPersonId) : clients;
  if (
    !due.length ||
    taskDone(
      task,
      due.map((c) => c.id),
      doneBy,
    )
  )
    return null;
  const left = task.kind === 'sign_off' ? due.filter((c) => !doneBy.includes(c.id)) : due;
  const names = left.map((c) => c.firstName || 'the client');
  return `Waiting on ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
}
