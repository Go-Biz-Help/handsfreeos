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
        'Mark a duty done without its proof or waive it, with a reason, and set a deal’s final commission.',
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
    ],
  },
  // The sweep: every fifteen minutes while it's on, armed again from now each time it's turned on.
  jobs: ['realestate.sweep'],
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
  },
  ai: {
    directory:
      'buyer and listing deals: their people, property, key dates, duties, deadlines, documents and alerts',
  },
});
