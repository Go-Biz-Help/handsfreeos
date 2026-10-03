import {
  capabilitySets,
  findAddon,
  type AddonManifest,
  type Catalog,
  type InstallationState,
} from '@hfos/core';

import type { AddonImpact, AddonList, InstalledRow } from '../types';

/**
 * A made-up catalogue for the phone's add-on tests, shaped like core's (packages/core/test/addons/fixtures.ts):
 * property management with rent collection on top of it, accounting with a switch, a scheduler another add-on works
 * with, and one planned, one in beta, one paid and one deprecated, so every rule has something to bite on. Every id
 * starts with `fx`, so none can be mistaken for a real add-on. The real catalogue is empty until the first ships.
 */

const base = { version: '1.0.0', dataVersion: 1, billing: { model: 'free' } } as const;

export const fxprop: AddonManifest = {
  ...base,
  id: 'fxprop',
  name: 'Property Management',
  summary: 'Properties, units, tenants and leases.',
  description:
    'Keep every property, its units and who lives in each, with leases linked to tenants.',
  category: 'industry',
  catalog: { status: 'available', keywords: ['property', 'tenant', 'lease'] },
  capabilities: [
    {
      id: 'fxprop.properties',
      label: 'Properties and units',
      description: 'Keep properties, their units and who lives in each.',
      permission: 'fxprop.read',
    },
    {
      id: 'fxprop.leases',
      label: 'Leases',
      description: 'Leases with rent, due day and terms, linked to tenants.',
      permission: 'fxprop.read',
    },
  ],
  permissions: [
    {
      key: 'fxprop.read',
      label: 'See properties',
      description: 'Properties, units and leases.',
      defaultRoles: ['admin', 'member'],
    },
  ],
};

export const fxrent: AddonManifest = {
  ...base,
  id: 'fxrent',
  name: 'Rent Collection',
  summary: 'Rent reminders and late fees for leases.',
  description: 'Find tenants who are late with rent, remind them and add late fees.',
  category: 'finance',
  catalog: { status: 'available', keywords: ['rent'] },
  capabilities: [
    {
      id: 'fxrent.overdue',
      label: 'Overdue rent',
      description: 'Find tenants who are late with rent and remind them.',
      permission: 'fxrent.use',
    },
  ],
  permissions: [
    {
      key: 'fxrent.use',
      label: 'Collect rent',
      description: 'See overdue rent and send reminders.',
      defaultRoles: ['admin'],
    },
  ],
  requires: [{ addon: 'fxprop', kind: 'required', why: 'Rent is collected on its leases.' }],
};

export const fxacct: AddonManifest = {
  ...base,
  id: 'fxacct',
  name: 'Accounting',
  summary: 'Books, expenses and profit.',
  description: 'Keep the books beside the invoices and payments HandsFreeOS already has.',
  category: 'finance',
  catalog: { status: 'available', keywords: ['books'] },
  capabilities: [
    {
      id: 'fxacct.books',
      label: 'Books and reports',
      description: 'A ledger, expenses and a profit report.',
      permission: 'fxacct.use',
    },
  ],
  permissions: [
    {
      key: 'fxacct.use',
      label: 'Use Accounting',
      description: 'Everything Accounting does.',
      defaultRoles: ['admin'],
    },
  ],
  settings: {
    version: 1,
    flags: {
      beta_reports: { label: 'Try the new reports', default: false },
      daily_digest: { label: 'Email a daily summary', default: true },
    },
  },
};

export const fxsocial: AddonManifest = {
  ...base,
  id: 'fxsocial',
  name: 'Social Media Scheduler',
  summary: 'Schedule posts for Facebook and Instagram.',
  description: 'Write posts once and have them go out when you choose.',
  category: 'marketing',
  catalog: { status: 'available', keywords: ['social'] },
  capabilities: [
    {
      id: 'fxsocial.posts',
      label: 'Scheduled posts',
      description: 'Posts that go out on their own.',
    },
  ],
  permissions: [],
};

export const fxcontent: AddonManifest = {
  ...base,
  id: 'fxcontent',
  name: 'Content Creator',
  summary: 'Blog posts and captions.',
  description: 'Drafts blog posts and captions in the business’s own voice.',
  category: 'marketing',
  catalog: { status: 'available', keywords: ['content'] },
  capabilities: [
    { id: 'fxcontent.drafts', label: 'Drafts', description: 'Blog posts and captions.' },
  ],
  permissions: [],
  requires: [{ addon: 'fxsocial', kind: 'optional', why: 'It can hand posts to the scheduler.' }],
};

/** Planned: no code, only a promise. Coming soon, never installable. */
export const fxinflu: AddonManifest = {
  ...base,
  id: 'fxinflu',
  name: 'Influencer Marketplace',
  summary: 'Find influencers to promote the business.',
  description: 'Find and book influencers to promote the business.',
  category: 'marketing',
  catalog: { status: 'planned', keywords: ['influencer'] },
  capabilities: [
    {
      id: 'fxinflu.marketplace',
      label: 'Influencer marketplace',
      description: 'Find and book influencers.',
    },
  ],
  permissions: [],
};

/** In beta: only HandsFreeOS support hands it out. */
export const fxbeta: AddonManifest = {
  ...base,
  id: 'fxbeta',
  name: 'Beta Loyalty',
  summary: 'Points and rewards for regulars.',
  description: 'Points customers earn and spend.',
  category: 'sales',
  catalog: { status: 'beta', keywords: ['loyalty'] },
  capabilities: [{ id: 'fxbeta.points', label: 'Loyalty points', description: 'Points.' }],
  permissions: [],
};

/** Available, but paid: HandsFreeOS support turns it on until billing exists. */
export const fxpaid: AddonManifest = {
  ...base,
  id: 'fxpaid',
  name: 'Premium Payroll',
  summary: 'Payroll for the team.',
  description: 'Pay the team, with wages and paychecks.',
  category: 'finance',
  catalog: { status: 'available', keywords: ['payroll'] },
  capabilities: [{ id: 'fxpaid.runs', label: 'Payroll runs', description: 'Pay the team.' }],
  permissions: [],
  billing: { model: 'paid' },
};

/** Deprecated: still runs where installed, offered to nobody. */
export const fxold: AddonManifest = {
  ...base,
  id: 'fxold',
  name: 'Old Newsletter',
  summary: 'A monthly newsletter.',
  description: 'Sends a newsletter.',
  category: 'marketing',
  catalog: { status: 'deprecated', keywords: ['newsletter'] },
  capabilities: [{ id: 'fxold.letters', label: 'Newsletters', description: 'Monthly.' }],
  permissions: [],
};

export const FIXTURE_CATALOG: Catalog = [
  fxprop,
  fxrent,
  fxacct,
  fxsocial,
  fxcontent,
  fxinflu,
  fxbeta,
  fxpaid,
  fxold,
];

/** An owner's permissions here: every add-on permission too, as if each fixture were on. */
export const OWNER = [
  'workspace.read',
  'records.read',
  'addons.manage',
  'addons.purge',
  'fxprop.read',
  'fxrent.use',
  'fxacct.use',
];
export const ADMIN = OWNER.filter((p) => p !== 'addons.purge');
export const MEMBER = ['workspace.read', 'records.read', 'fxprop.read'];

/**
 * What `addon.list` answers for these installations, worked out as the query does (packages/core/src/queries/addon.ts):
 * the capability sets from core, and what could be added and what's planned only for someone who manages add-ons.
 */
export function listFor(
  installations: Readonly<Record<string, InstallationState>>,
  {
    permissions = OWNER,
    catalog = FIXTURE_CATALOG,
    rows = {},
  }: {
    permissions?: readonly string[];
    catalog?: Catalog;
    rows?: Readonly<Record<string, Partial<InstalledRow>>>;
  } = {},
): AddonList {
  const sets = capabilitySets({ catalog, installations, permissions });
  const manages = permissions.includes('addons.manage');
  return {
    installed: Object.entries(installations).map(([addonId, state]) => {
      const m = findAddon(catalog, addonId);
      return {
        addonId,
        name: m?.name ?? addonId,
        summary: m?.summary ?? '',
        state,
        installedVersion: '1.0.0',
        latestVersion: m?.version ?? null,
        generation: 1,
        changedAt: '2026-09-28T12:00:00.000Z',
        lastError: null,
        failedChecks: [],
        retired: !m,
        status: m?.catalog.status ?? null,
        running: !!m && state === 'enabled',
        ...rows[addonId],
      };
    }),
    capabilities: {
      current: [...sets.current],
      restricted: [...sets.restricted],
      turnedOff: [...sets.turnedOff],
      installable: manages ? [...sets.installable] : [],
      planned: manages ? [...sets.planned] : [],
    },
    catalog: manages
      ? catalog
          .filter((m) => m.catalog.status === 'available' || m.catalog.status === 'planned')
          .map((m) => ({
            addonId: m.id,
            name: m.name,
            summary: m.summary,
            category: m.category,
            status: m.catalog.status,
            testing: false,
          }))
      : [],
  };
}

/** What `addon.impact` answers, with nothing held unless a test says otherwise. */
export function impactOf(over: Partial<AddonImpact> & Pick<AddonImpact, 'addonId' | 'action'>) {
  return {
    outcome: 'plan',
    moves: [],
    needsAgreement: [],
    question: null,
    refusal: null,
    optionalFor: [],
    capabilitiesLost: [],
    holds: {
      records: 0,
      relationships: 0,
      pendingJobs: 0,
      heldResources: 0,
      ownRows: 0,
      usageEvents: 0,
    },
    kept: null,
    ...over,
  } satisfies AddonImpact;
}
