/**
 * Real Estate Agent: its manifest (docs/addon-architecture.md, HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md).
 * Browser-safe: the screens, the API, the worker and the AI all read it, so it holds no server code. Everything it
 * declares starts with its id, `realestate`.
 *
 * - **A deal** is a record of its kind `realestate_deal`, kept to the people on it (Chris, 2026-09-30): its main agent
 *   and team see it, and so do owners, admins and anyone given **See every deal**. What the add-on knows about one
 *   (its side, stage, commission, health) is in its own table, `deals`, keyed by that record.
 * - **A property** (`realestate_property`) is shared with everyone who works with the add-on; a deal has one, and a
 *   property has every deal ever done on it (both sides of one sale are two deals on one property).
 * - **The people on a deal from outside** are the business's own contacts, tied to it by the relationship types
 *   below: the client, the loan officer, the other side's agent, and the rest.
 *
 * It's in `beta`: offered nowhere on its own. HandsFreeOS staff hand it to a test business (step 2's grants), whose
 * owners and admins add it from their Add-ons page.
 */
import { defineAddon, type AddonRelationshipType } from '../manifest';
import { RealestateSettingsSchema } from './settings';

/** Someone from outside the business with a part in a deal: the person's role, and the deal as they see it. */
const personOnDeal = (key: string, role: string, short: string): AddonRelationshipType => ({
  key: `realestate_${key}`,
  a: { kind: 'person' },
  aLabel: role,
  b: { kind: 'record', recordKind: 'realestate_deal' },
  bLabel: `Deal (${short})`,
});

/** A company with a part in a deal. */
const companyOnDeal = (key: string, role: string, short: string): AddonRelationshipType => ({
  key: `realestate_${key}`,
  a: { kind: 'company' },
  aLabel: role,
  b: { kind: 'record', recordKind: 'realestate_deal' },
  bLabel: `Deal (${short})`,
});

export const realestateAddon = defineAddon({
  id: 'realestate',
  name: 'Real Estate Agent',
  summary: 'Buyer and listing deals with every duty, deadline and proof tracked.',
  description:
    'Runs buyer and listing deals from the first meeting to the keys: every duty an agent owes, each deadline worked out from the contract’s own dates, the proof that it was done, and alerts before anything slips. Deals stay private to the people on them, signed documents are kept, and the Assistant can say what could stop a closing.',
  category: 'industry',
  version: '0.1.0',
  // One more whenever its data changes shape; the worker brings each business's data up a step at a time
  // (apps/worker/src/addons/realestate/index.ts, `dataMigrations`).
  dataVersion: 1,
  catalog: {
    // Beta (step 14): still offered to nobody on its own; HandsFreeOS staff hand it to a test business.
    status: 'beta',
    // The words someone uses when they need it: what recommendations and the AI's search match on.
    keywords: [
      'real estate',
      'realtor',
      'realty',
      'agent',
      'buyer',
      'seller',
      'listing',
      'closing',
      'escrow',
      'transaction',
      'contract',
      'offer',
      'inspection',
      'appraisal',
      'brokerage',
    ],
    exampleNeeds: [
      'track every deadline on my buyer’s contract',
      'know what could stop a closing',
      'keep each listing’s paperwork and duties in one place',
    ],
    industries: ['real estate'],
    groups: ['Real estate & property'],
  },
  capabilities: [
    {
      id: 'realestate.deals',
      label: 'Buyer and listing deals',
      description:
        'Open a deal for a buyer or a listing, with its people, its property, its key dates and its commission.',
      permission: 'realestate.use',
    },
    {
      id: 'realestate.duties',
      label: 'Every duty and deadline',
      description:
        'Every duty an agent owes on a deal, with deadlines worked out from the contract’s dates and proof that each was done.',
      permission: 'realestate.use',
    },
    {
      id: 'realestate.alerts',
      label: 'Alerts before anything slips',
      description:
        'Reminders before a deadline, and alerts on Home, the phone and by email when a deal is at risk.',
      permission: 'realestate.use',
    },
  ],
  // Exist only while it runs in a business. Its migrations register the same list (the parity test checks).
  permissions: [
    {
      key: 'realestate.use',
      label: 'Work on deals',
      description: 'Open deals, and work the ones they’re on.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'realestate.all_deals',
      label: 'See every deal',
      description: 'Every deal in the business, not only the ones they’re on.',
      defaultRoles: ['admin'],
      requires: ['realestate.use'],
    },
    {
      key: 'realestate.except',
      label: 'Approve exceptions',
      description:
        'Mark a duty done without its proof or waive it, with a reason, let a tour through without a current buyer agreement, and set a deal’s final commission.',
      defaultRoles: ['admin'],
      requires: ['realestate.use'],
    },
    {
      key: 'realestate.manage',
      label: 'Run the deal settings',
      description: 'The list of duties, the alerts, business days and the add-on’s other settings.',
      defaultRoles: ['admin'],
      requires: ['realestate.use'],
    },
  ],
  recordKinds: [
    {
      key: 'realestate_deal',
      singular: 'Deal',
      plural: 'Deals',
      nameLabel: 'Deal name',
      icon: 'key',
      writePermission: 'realestate.use',
      keptToTeam: { seeAllPermission: 'realestate.all_deals' },
    },
    {
      key: 'realestate_property',
      singular: 'Property',
      plural: 'Properties',
      nameLabel: 'Address',
      icon: 'home',
      writePermission: 'realestate.use',
    },
  ],
  relationshipTypes: [
    // Each deal is on one property; a property has every deal done on it.
    {
      key: 'realestate_property_of',
      a: { kind: 'record', recordKind: 'realestate_deal' },
      aLabel: 'Deal',
      b: { kind: 'record', recordKind: 'realestate_property' },
      bLabel: 'Property',
      cardinality: 'many_to_one',
    },
    {
      key: 'realestate_client',
      a: { kind: 'person' },
      aLabel: 'Client',
      b: { kind: 'record', recordKind: 'realestate_deal' },
      bLabel: 'Deal',
      // A client sees their deals in their portal (round two).
      portal: true,
    },
    personOnDeal('loan_officer', 'Loan officer', 'loan officer'),
    personOnDeal('other_agent', 'Other side’s agent', 'other side’s agent'),
    personOnDeal('title_contact', 'Title or escrow contact', 'title'),
    personOnDeal('inspector', 'Inspector', 'inspector'),
    personOnDeal('vendor', 'Vendor', 'vendor'),
    personOnDeal('attorney', 'Attorney', 'attorney'),
    companyOnDeal('lender', 'Lender', 'lender'),
    companyOnDeal('title_company', 'Title or escrow company', 'title'),
    companyOnDeal('brokerage', 'Other side’s brokerage', 'other side'),
    companyOnDeal('vendor_company', 'Vendor', 'vendor'),
  ],
  // Its own tables, in `addon_realestate` (packages/core/src/addons/realestate/tables.ts mirrors them).
  tables: [
    'deals',
    'deal_roles',
    'deal_links',
    'deal_history',
    'term_entries',
    'template_sets',
    'template_items',
    'template_overrides',
    'custom_templates',
    'duties',
    'duty_links',
    'documents',
    'duty_evidence',
    'duty_log',
    'drafts',
    'fair_housing_checks',
    // Round two: the buyer's profile and their homes.
    'buyer_profiles',
    'buyer_profile_versions',
    'homes',
    'home_reactions',
    'memory_items',
    'tours',
    'tour_stops',
    'tour_feedback',
    'cmas',
    'cma_comps',
    'offers',
    'offer_versions',
    'financing',
    'financing_steps',
    'inspections',
    'inspection_findings',
    'repair_requests',
    'client_tasks',
    'client_task_completions',
    // Round three: the listing.
    'listings',
    'listing_photos',
    'seller_questionnaires',
    'listing_descriptions',
    'listing_posts',
    'open_houses',
    'open_house_visitors',
    'net_sheets',
    'offer_comparisons',
    'offer_choices',
    'listing_prices',
  ],
  // What its commands say happened, for history, the worker and other add-ons (its test holds the list to them).
  events: {
    emits: [
      'realestate.deal.opened',
      'realestate.deal.stage_changed',
      'realestate.deal.event_recorded',
      'realestate.deal.offer_lost',
      'realestate.deal.terminated',
      'realestate.deal.closed',
      'realestate.deal.ended',
      'realestate.deal.reopened',
      'realestate.deal.facts_changed',
      'realestate.deal.team_changed',
      'realestate.deal.property_set',
      'realestate.deal.linked',
      'realestate.deal.unlinked',
      'realestate.deal.commission_set',
      'realestate.deal.final_commission_set',
      'realestate.party.added',
      'realestate.party.removed',
      'realestate.term.entered',
      'realestate.term.confirmed',
      'realestate.term.rejected',
      'realestate.term.conflict_resolved',
      'realestate.duty.status_changed',
      'realestate.duty.evidence_added',
      'realestate.duty.evidence_withdrawn',
      'realestate.duty.assigned',
      'realestate.duty.acknowledged',
      'realestate.duty.completed',
      'realestate.duty.waived',
      'realestate.duty.cancelled',
      'realestate.duty.reopened',
      'realestate.duty.due_set',
      'realestate.duty.added',
      'realestate.deal.wire_change_reported',
      'realestate.document.added',
      'realestate.document.updated',
      'realestate.document.signed',
      'realestate.document.controlling_set',
      'realestate.document.voided',
      'realestate.template.changed',
      'realestate.template.published',
      'realestate.deal.template_applied',
      'realestate.status_email.requested',
      'realestate.status_email.ready',
      'realestate.status_email.saved',
      'realestate.status_email.flags_acknowledged',
      'realestate.status_email.sent',
      'realestate.status_email.discarded',
      // Round two: the buyer's profile and their homes.
      'realestate.buyer_profile.saved',
      'realestate.home.added',
      'realestate.home.facts_filled',
      'realestate.home.facts_confirmed',
      'realestate.home.status_changed',
      'realestate.memory.added',
      'realestate.memory.decided',
      'realestate.memory.requested',
      'realestate.memory.suggested',
      'realestate.tour.planned',
      'realestate.tour.stops_changed',
      'realestate.tour.rescheduled',
      'realestate.tour.canceled',
      'realestate.tour.visited',
      'realestate.tour.feedback_added',
      'realestate.cma.started',
      'realestate.cma.changed',
      'realestate.cma.finalized',
      'realestate.cma.summary_requested',
      'realestate.cma.summary_ready',
      'realestate.cma.summary_saved',
      'realestate.cma.flags_acknowledged',
      'realestate.cma.shared',
      'realestate.offer.version_added',
      'realestate.offer.answered',
      'realestate.offer.shared',
      'realestate.financing.changed',
      'realestate.financing.step_done',
      'realestate.inspection.changed',
      'realestate.inspection.report_in',
      'realestate.repair.sent',
      'realestate.repair.answered',
      'realestate.repair.received',
      'realestate.client_task.added',
      'realestate.client_task.changed',
      'realestate.client_task.done',
      'realestate.home.reacted',
      // Round three: the listing.
      'realestate.listing.pasted',
      'realestate.listing.facts_read',
      'realestate.listing.facts_confirmed',
      'realestate.listing.photos_changed',
      'realestate.listing.description_requested',
      'realestate.listing.description_ready',
      'realestate.listing.description_saved',
      'realestate.listing.description_flags_kept',
      'realestate.listing.description_sent',
      'realestate.listing.description_signed',
      'realestate.listing.live',
      'realestate.listing.page_changed',
      'realestate.listing.campaign_started',
      'realestate.listing.asked',
      'realestate.listing.posts_requested',
      'realestate.listing.posts_ready',
      'realestate.listing.post_saved',
      'realestate.open_house.planned',
      'realestate.open_house.cancelled',
      'realestate.open_house.followed_up',
      'realestate.open_house.signed_in',
      'realestate.net_sheet.saved',
      'realestate.offers.shared',
      'realestate.offers.seller_chose',
      'realestate.listing.price_proposed',
      'realestate.listing.price_changed',
      'realestate.listing.price_withdrawn',
    ],
    // Its own: a changed wire raises a critical alert at once, and the check that settles it clears it.
    consumes: [
      'realestate.deal.wire_change_reported',
      'realestate.duty.completed',
      'realestate.duty.waived',
      'realestate.duty.cancelled',
      // Client updates: drafted and checked by the model, and offered at each milestone.
      'realestate.status_email.requested',
      'realestate.status_email.saved',
      'realestate.status_email.ready',
      'realestate.status_email.sent',
      'realestate.status_email.discarded',
      'realestate.deal.stage_changed',
      'realestate.deal.event_recorded',
      'realestate.deal.closed',
      // A home with a listing's pasted words: the AI reads them for its facts.
      'realestate.home.added',
      // A listing's old words, pasted: the same read, for the listing's facts.
      'realestate.listing.pasted',
      // A listing's description: drafted, and every version of its words checked.
      'realestate.listing.description_requested',
      'realestate.listing.description_saved',
      // A visitor asked about a listing on its page: its agent hears.
      'realestate.listing.asked',
      // Social posts: drafted, and every version of their words checked.
      'realestate.listing.posts_requested',
      'realestate.listing.post_saved',
      // Open houses: the next morning's reminder to follow up, cleared once everyone is.
      'realestate.open_house.planned',
      'realestate.open_house.followed_up',
      // A seller said what they want about an offer in their portal: their agent hears.
      'realestate.offers.seller_chose',
      // A new price in use: the agent is reminded to change it on the MLS.
      'realestate.listing.price_changed',
      // Buyer memory: a client's message or call starts a read ten minutes on; asked for, at once.
      'message.received',
      'call.transcribed',
      'realestate.memory.requested',
      'realestate.memory.suggested',
      'realestate.memory.decided',
      // Tours: a tour's appointment moved or canceled on the calendar moves or cancels the tour.
      'appointment.rescheduled',
      'appointment.cancelled',
      // The CMA's summary: drafted from its numbers, and every version of its words checked.
      'realestate.cma.summary_requested',
      'realestate.cma.summary_saved',
      // Offers: the response clock, armed with each version and stopped when it's answered.
      'realestate.offer.version_added',
      'realestate.offer.answered',
    ],
  },
  // The sweep: every fifteen minutes while it's on, armed again from now each time it's turned on.
  jobs: [
    'realestate.sweep',
    'realestate.memory_suggest',
    'realestate.offer_clock',
    'realestate.open_house_follow_up',
  ],
  // Its alert person, the business's closed days and its milestone drafts; owners and admins change them.
  settings: { version: 1, permission: 'realestate.manage', workspace: RealestateSettingsSchema },
  // Free while it's tested (Chris, 2026-09-30); what it's used for is counted.
  billing: { model: 'free' },
  // Its places in the side menu, shown only while it runs and to people who may open them, and its panels on core's
  // pages: a customer's, a company's and a lead's deals, and a property's (Start a deal from any of them).
  ui: {
    nav: [
      { key: 'deals', label: 'Deals', icon: 'house', path: '', permission: 'realestate.use' },
      {
        key: 'duties',
        label: 'My duties',
        icon: 'list-checks',
        path: 'duties',
        permission: 'realestate.use',
      },
      {
        key: 'settings',
        label: 'Deal settings',
        icon: 'settings',
        path: 'settings',
        permission: 'realestate.manage',
      },
    ],
    slots: [
      { slot: 'person.panels', permission: 'realestate.use' },
      { slot: 'company.panels', permission: 'realestate.use' },
      { slot: 'lead.panels', permission: 'realestate.use' },
      { slot: 'record.panels', permission: 'realestate.use' },
    ],
    // The deal pages the phone draws too (Chris, 2026-09-30): an alert's push opens the deal there once the phone
    // has the screen, the web until then. Deal settings stays on the web.
    phone: [
      { path: '', query: ['view'] },
      { path: 'duties', query: ['scope', 'duty'] },
      { path: 'deals/:dealId', query: ['duty'] },
      { path: 'deals/:dealId/dates' },
      { path: 'deals/:dealId/documents' },
      { path: 'deals/:dealId/history' },
      { path: 'deals/:dealId/updates/:draftId' },
      // Round two: the buyer's side.
      { path: 'deals/:dealId/buyer' },
      { path: 'deals/:dealId/homes', query: ['add', 'home'] },
      { path: 'deals/:dealId/tours', query: ['plan', 'home'] },
      { path: 'deals/:dealId/cma/:cmaId' },
      { path: 'deals/:dealId/offers', query: ['start'] },
      { path: 'deals/:dealId/offers/:offerId' },
      { path: 'deals/:dealId/offers/:offerId/summary' },
      { path: 'deals/:dealId/financing' },
      { path: 'deals/:dealId/inspections' },
      { path: 'deals/:dealId/client-tasks', query: ['invite'] },
    ],
    // The client's own pages in their portal (round two): their deals, and each one's homes, tours, to-do and more.
    // Homes and To do are places in the portal's menu (pages without an id); the rest open from them.
    portal: [
      { path: '', title: 'Your deals', query: 'realestate.portal.deals' },
      { path: 'homes', title: 'Homes', query: 'realestate.portal.deals' },
      { path: 'todo', title: 'To do', query: 'realestate.portal.deals' },
      { path: 'deals/:dealId', title: 'Your deal', query: 'realestate.portal.deal' },
      { path: 'deals/:dealId/tours/:tourId', title: 'Your tour', query: 'realestate.portal.deal' },
      {
        path: 'deals/:dealId/offers/:offerId',
        title: 'Your offer',
        query: 'realestate.portal.deal',
      },
    ],
    // Round three: a listing's page, for anyone with the link (`/a/<site>/realestate/<slug>`).
    public: [
      { path: ':slug', query: 'realestate.public.listing' },
      { path: ':slug/open-house/:openHouseId', query: 'realestate.public.open_house' },
    ],
  },
  ai: {
    directory:
      'buyer and listing deals: their people, property, key dates, duties, deadlines, documents and alerts',
  },
});
