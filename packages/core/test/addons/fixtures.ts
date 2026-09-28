/**
 * A made-up catalogue for the add-on tests: seventeen add-ons shaped like the ones HandsFreeOS expects to build
 * (property management with rent collection on top of it, accounting, social posting, content, projects…), plus
 * one planned, one in beta, one paid, one deprecated and one switched off, so every rule has something to bite on.
 *
 * Every id starts with `fx` so a fixture can never be mistaken for, or collide with, a real add-on: the database
 * tests register these ids' permissions in a shared local database, and the parity tests ignore ids that aren't in
 * the real catalogue. Nothing here is imported by anything but tests.
 */
import { defineAddon, type AddonManifest, type Catalog } from '../../src/index';

const base = {
  version: '1.0.0',
  dataVersion: 1,
  description: 'A test fixture.',
  billing: { model: 'free' },
} as const;

export const fxprop = defineAddon({
  ...base,
  id: 'fxprop',
  name: 'Property Management',
  summary: 'Properties, units, tenants and leases.',
  category: 'industry',
  catalog: {
    status: 'available',
    keywords: ['property', 'properties', 'unit', 'tenant', 'lease', 'landlord', 'rent'],
    exampleNeeds: ['track my rental properties and their tenants'],
    industries: ['property management'],
  },
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
    {
      key: 'fxprop.write',
      label: 'Change properties',
      description: 'Add and edit properties, units and leases.',
      defaultRoles: ['admin', 'member'],
      requires: ['fxprop.read'],
    },
  ],
  recordKinds: [
    {
      key: 'fxprop_property',
      singular: 'Property',
      plural: 'Properties',
      nameLabel: 'Address',
      icon: 'home',
      writePermission: 'fxprop.write',
    },
    {
      key: 'fxprop_lease',
      singular: 'Lease',
      plural: 'Leases',
      icon: 'file-text',
      writePermission: 'fxprop.write',
    },
  ],
  relationshipTypes: [
    {
      key: 'fxprop_tenant',
      a: { kind: 'person' },
      aLabel: 'Tenant',
      b: { kind: 'record', recordKind: 'fxprop_lease' },
      bLabel: 'Lease',
    },
    {
      key: 'fxprop_owner',
      a: { kind: 'person' },
      aLabel: 'Owner',
      b: { kind: 'record', recordKind: 'fxprop_property' },
      bLabel: 'Property',
    },
  ],
  events: { emits: ['fxprop.lease.signed'], consumes: ['person.updated'] },
  jobs: ['fxprop.rent_check'],
  ui: { nav: [{ key: 'properties', label: 'Properties', icon: 'building', path: '' }] },
  ai: { directory: 'properties, units, tenants and leases' },
});

export const fxrent = defineAddon({
  ...base,
  id: 'fxrent',
  name: 'Rent Collection',
  summary: 'Rent reminders and late fees for leases.',
  category: 'finance',
  catalog: { status: 'available', keywords: ['rent', 'late', 'fee', 'reminder'] },
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
  events: { consumes: ['fxprop.lease.signed', 'invoice.paid'] },
  resources: ['fxrent.bank_feed'],
});

const simple = (
  id: string,
  name: string,
  keywords: string[],
  extra: Partial<AddonManifest> = {},
): AddonManifest =>
  defineAddon({
    ...base,
    id,
    name,
    summary: `${name} for tests.`,
    category: 'operations',
    catalog: { status: 'available', keywords },
    capabilities: [
      {
        id: `${id}.use`,
        label: name,
        description: `${name}: ${keywords.join(', ')}.`,
        permission: `${id}.use`,
      },
    ],
    permissions: [
      {
        key: `${id}.use`,
        label: `Use ${name}`,
        description: `Everything ${name} does.`,
        defaultRoles: ['admin', 'member'],
      },
    ],
    ...extra,
  });

export const fxacct = simple('fxacct', 'Accounting', ['books', 'ledger', 'expenses', 'profit']);
export const fxsocial = simple('fxsocial', 'Social Media Scheduler', [
  'social',
  'posts',
  'schedule',
  'facebook',
  'instagram',
]);
export const fxcontent = simple('fxcontent', 'Content Creator', ['blog', 'content', 'captions'], {
  requires: [{ addon: 'fxsocial', kind: 'optional', why: 'It can hand posts to the scheduler.' }],
});
export const fxseo = simple('fxseo', 'SEO Tools', ['seo', 'ranking', 'keywords', 'search']);
export const fxinv = simple('fxinv', 'Inventory', ['stock', 'inventory', 'parts', 'warehouse']);
export const fxproj = simple('fxproj', 'Project Management', ['projects', 'milestones', 'gantt']);
export const fxjobs = simple('fxjobs', 'Field Service Jobs', ['jobs', 'dispatch', 'technician']);
export const fxcoach = simple('fxcoach', 'AI Sales Coach', ['coaching', 'calls', 'objections']);
export const fxdocs = simple('fxdocs', 'Document Intelligence', ['documents', 'contracts', 'ocr']);
export const fxcare = simple('fxcare', 'AI Customer Service', ['support', 'tickets', 'answers']);
export const fxwarranty = simple('fxwarranty', 'Warranties', ['warranty', 'expiry', 'coverage'], {
  requires: [{ addon: 'fxjobs', kind: 'required', why: 'Warranties are kept on its jobs.' }],
});

/** Planned: no code, only a promise. Never installable, never recommended. */
export const fxinflu = defineAddon({
  ...base,
  id: 'fxinflu',
  name: 'Influencer Marketplace',
  summary: 'Find influencers to promote the business.',
  category: 'marketing',
  catalog: { status: 'planned', keywords: ['influencer', 'marketplace', 'promote'] },
  capabilities: [
    {
      id: 'fxinflu.marketplace',
      label: 'Influencer marketplace',
      description: 'Find and book influencers to promote the business.',
    },
  ],
  permissions: [],
});

/** Built and in beta: only staff can hand it out, never recommended. */
export const fxbeta = simple('fxbeta', 'Beta Loyalty', ['loyalty', 'points', 'rewards'], {
  catalog: { status: 'beta', keywords: ['loyalty', 'points', 'rewards'] },
});

/** Available, but paid: installable only by staff until billing exists. */
export const fxpaid = simple('fxpaid', 'Premium Payroll', ['payroll', 'wages', 'paycheck'], {
  billing: { model: 'paid', meters: [{ key: 'fxpaid.runs', unit: 'run', label: 'Payroll runs' }] },
});

/** Deprecated: still runs where installed, never offered again. */
export const fxold = simple('fxold', 'Old Newsletter', ['newsletter', 'mailing'], {
  catalog: { status: 'deprecated', keywords: ['newsletter', 'mailing'], replacedBy: 'fxsocial' },
});

/** Every fixture, in a stable order. */
export const FIXTURE_CATALOG: Catalog = [
  fxprop,
  fxrent,
  fxacct,
  fxsocial,
  fxcontent,
  fxseo,
  fxinv,
  fxproj,
  fxjobs,
  fxcoach,
  fxdocs,
  fxcare,
  fxwarranty,
  fxinflu,
  fxbeta,
  fxpaid,
  fxold,
];

/** Twelve free, available add-ons with no required dependencies between them: a busy business. */
export const TWELVE = [
  'fxprop',
  'fxacct',
  'fxsocial',
  'fxcontent',
  'fxseo',
  'fxinv',
  'fxproj',
  'fxjobs',
  'fxcoach',
  'fxdocs',
  'fxcare',
  'fxwarranty',
] as const;

/** A letters-only id for the `i`th synthetic add-on: fxsaa, fxsab, … (ids are letters only). */
export const syntheticId = (i: number): string =>
  `fxs${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;

/** `n` synthetic add-ons, each requiring the one before it every third step: for scale and timing tests. */
export function syntheticCatalog(n: number): Catalog {
  return Array.from({ length: n }, (_, i) => {
    const id = syntheticId(i);
    return simple(id, `Synthetic ${i}`, [`word${i}`, 'shared'], {
      requires:
        i > 0 && i % 3 === 0
          ? [{ addon: syntheticId(i - 1), kind: 'required', why: 'Chained.' }]
          : [],
    });
  });
}
