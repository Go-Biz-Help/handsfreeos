/**
 * Real Estate Agent's words that more than one place shows: the team's roles on a deal, the outside parties, the
 * kinds of link between two deals, and how a deal's outcome reads. Browser-safe: the screens, the phone and the
 * Assistant say the same thing.
 */

/** What someone on the team does on a deal besides its main agent (`agent`). */
export const TEAM_ROLES = ['co_agent', 'coordinator', 'assistant'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type DealRole = 'agent' | TeamRole;

export const DEAL_ROLE_LABELS: Readonly<Record<DealRole, string>> = {
  agent: 'Main agent',
  co_agent: 'Co-agent',
  coordinator: 'Coordinator',
  assistant: 'Assistant',
};

/**
 * The people and companies from outside with a part in a deal, each a relationship type of the add-on's
 * (`realestate_<role>`, manifest.ts).
 */
export const PARTY_ROLES = {
  client: { end: 'person', label: 'Client' },
  loan_officer: { end: 'person', label: 'Loan officer' },
  other_agent: { end: 'person', label: 'Other side’s agent' },
  title_contact: { end: 'person', label: 'Title or escrow contact' },
  inspector: { end: 'person', label: 'Inspector' },
  vendor: { end: 'person', label: 'Vendor' },
  attorney: { end: 'person', label: 'Attorney' },
  lender: { end: 'company', label: 'Lender' },
  title_company: { end: 'company', label: 'Title or escrow company' },
  brokerage: { end: 'company', label: 'Other side’s brokerage' },
  vendor_company: { end: 'company', label: 'Vendor' },
} as const satisfies Record<string, { end: 'person' | 'company'; label: string }>;
export type PartyRole = keyof typeof PARTY_ROLES;
export const PARTY_ROLES_LIST = Object.keys(PARTY_ROLES) as [PartyRole, ...PartyRole[]];
/** The relationship type a party role is. */
export const partyTypeKey = (role: PartyRole) => `realestate_${role}` as const;
/** Each deal's one property. */
export const PROPERTY_TYPE_KEY = 'realestate_property_of';

/** The two sides of one home, or a client's sale and their next purchase. */
export const DEAL_LINK_KINDS = {
  same_home: 'Other side of this home',
  sale_and_purchase: 'Client’s other deal',
} as const;
export type DealLinkKind = keyof typeof DEAL_LINK_KINDS;
export const DEAL_LINK_KINDS_LIST = Object.keys(DEAL_LINK_KINDS) as [
  DealLinkKind,
  ...DealLinkKind[],
];

/** How a deal ended, as its page says it. */
export const OUTCOME_LABELS = {
  closed: 'Closed',
  terminated: 'Terminated',
  lost: 'Lost',
  ended: 'Ended',
} as const;

/** "buyer deal" or "listing", in a sentence. */
export const sideWords = (side: 'buyer' | 'listing') =>
  side === 'buyer' ? 'buyer deal' : 'listing';

/** The moments a person records on a deal, as its timeline says them. */
export const EVENT_WORDS = {
  offer_received: 'an offer came in',
  inspection_report: 'the inspection report is in',
  repair_request: 'a repair request was made',
  repairs_agreed: 'repairs were agreed',
  low_appraisal: 'the appraisal came in low',
  amendment: 'the contract was amended',
  search_changed: 'the search changed',
} as const;
