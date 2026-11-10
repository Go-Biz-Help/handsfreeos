/**
 * Contractor Operations: its manifest (docs/contractor.md, HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md,
 * docs/addon-architecture.md). Browser-safe: the screens, the API, the worker and the AI all read it, so it holds no
 * server code. Everything it declares starts with its id, `contractor`.
 *
 * One add-on for every trade (the owner's decision 1, 2026-11-10): electricians, plumbers, HVAC, roofers, remodelers
 * and general contractors pick their trades in its settings. Part 1 is jobs and projects: a job is a record of its
 * own kind, at a property (another kind it keeps) the customer owns, and starts as a service call; with phases it's
 * a project, with deadlines, a budget and % done. Estimates with costs, crews and work orders, materials, time and
 * job costing, the phone's field screens and the AI helpers come in parts 2 to 7.
 *
 * It's in `development`: offered nowhere, and installable only where HandsFreeOS staff hand it out to try.
 */
import { defineAddon } from '../manifest';
import { CONTRACTOR_LOOK_ALIKES, CONTRACTOR_PLACES } from './ai-places';
import { ContractorSettingsSchema } from './schemas';
import { CONTRACTOR_PAGES } from './words';

export const contractorAddon = defineAddon({
  id: 'contractor',
  name: 'Contractor Operations',
  summary:
    'Jobs and projects for contractors and home service companies: phases, deadlines, budgets, crews, materials and job profit.',
  description:
    'Runs the work for electricians, plumbers, HVAC companies, roofers, remodelers and general contractors. Every job, from a quick service call to a whole project, sits at a property the customer owns, with its phases, deadlines, team, budget and % done, and the AI teammate can do it all on the same screens.',
  category: 'industry',
  version: '0.1.0',
  // One more whenever its data changes shape; the worker brings each business's data up a step at a time
  // (apps/worker/src/addons/contractor/index.ts, `dataMigrations`).
  dataVersion: 1,
  catalog: {
    status: 'development',
    // The words someone uses when they need it: what recommendations and the AI's search match on.
    keywords: [
      'contractor',
      'jobs',
      'projects',
      'job management',
      'project management',
      'field service',
      'home services',
      'electrician',
      'plumber',
      'hvac',
      'roofer',
      'remodeling',
      'general contractor',
      'phases',
      'job budget',
    ],
    exampleNeeds: [
      'keep track of my jobs and projects',
      'see which jobs are running late',
      'manage a remodel in phases',
      'track every job at a customer’s property',
    ],
    industries: [
      'home_services',
      'hvac',
      'plumbing',
      'electrical',
      'roofing',
      'handyman',
      'general_contracting',
      'remodeling',
    ],
    groups: ['Home services & trades', 'Project Management', 'Field Service'],
  },
  capabilities: [
    {
      id: 'contractor.jobs',
      label: 'Jobs and projects',
      description:
        'Every job and project with its customer, property, phases, deadlines, team and % done.',
      permission: 'contractor.use',
    },
    {
      id: 'contractor.costs',
      label: 'Job budgets and profit',
      description: 'What each job is priced at, what it should cost, and the profit planned.',
      permission: 'contractor.costs',
    },
    {
      id: 'contractor.manage',
      label: 'Contractor Operations settings',
      description: 'The business’s trades and the phases a new project starts with.',
      permission: 'contractor.manage',
    },
  ],
  // Exist only while it runs in a business. Its migration registers the same list (the parity test checks).
  permissions: [
    {
      key: 'contractor.use',
      label: 'Use Contractor Operations',
      description:
        'See every job and project, start them, and change their status, phases, dates, team and % done.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'contractor.costs',
      label: 'See job costs and profit',
      description:
        'See and set what each job is priced at, its budget and the profit planned. Techs see their work without the money (the owner’s decision 11).',
      defaultRoles: ['admin'],
      requires: ['contractor.use'],
    },
    {
      key: 'contractor.manage',
      label: 'Set up Contractor Operations',
      description: 'Pick the business’s trades and the phases a new project starts with.',
      defaultRoles: ['admin'],
      requires: ['contractor.use'],
    },
  ],
  recordKinds: [
    {
      key: 'contractor_job',
      singular: 'Job',
      plural: 'Jobs',
      nameLabel: 'Job name',
      icon: 'wrench',
      writePermission: 'contractor.use',
    },
    {
      key: 'contractor_property',
      singular: 'Property',
      plural: 'Properties',
      nameLabel: 'Address',
      icon: 'home',
      writePermission: 'contractor.use',
    },
  ],
  relationshipTypes: [
    // A job is for one customer; a customer has every job done for them.
    {
      key: 'contractor_customer',
      a: { kind: 'person' },
      aLabel: 'Customer',
      b: { kind: 'record', recordKind: 'contractor_job' },
      bLabel: 'Job',
      cardinality: 'one_to_many',
    },
    // A property can have more than one owner (a couple), and an owner more than one property.
    {
      key: 'contractor_owner',
      a: { kind: 'person' },
      aLabel: 'Owner',
      b: { kind: 'record', recordKind: 'contractor_property' },
      bLabel: 'Property',
      cardinality: 'many_to_many',
    },
    // A job is at one property; a property keeps every job done there, for good (the owner's decision 3).
    {
      key: 'contractor_site',
      a: { kind: 'record', recordKind: 'contractor_job' },
      aLabel: 'Job',
      b: { kind: 'record', recordKind: 'contractor_property' },
      bLabel: 'Property',
      cardinality: 'many_to_one',
    },
  ],
  tables: ['jobs', 'phases', 'team', 'money'],
  events: {
    emits: [
      'contractor.job.opened',
      'contractor.job.updated',
      'contractor.job.status_changed',
      'contractor.job.percent_set',
      'contractor.job.team_changed',
      'contractor.job.made_project',
      'contractor.job.money_set',
      'contractor.phase.added',
      'contractor.phase.updated',
      'contractor.phase.removed',
      'contractor.phases.reordered',
      'contractor.property.added',
    ],
    // A visit booked on a job moves it to Scheduled; a tech tapping Started on one of its visits moves it to In
    // progress (apps/worker/src/addons/contractor/index.ts).
    consumes: ['appointment.booked', 'job.status_changed'],
  },
  billing: { model: 'free' },
  settings: { version: 1, permission: 'contractor.manage', workspace: ContractorSettingsSchema },
  ui: {
    // Its pages in the side menu, which pop out from its one row (the owner's decision, 2026-10-09).
    nav: [
      { key: 'jobs', label: CONTRACTOR_PAGES.jobs, icon: 'hard-hat', path: '' },
      // Not `settings`: that key would put the page in Settings search, which opens it on the web.
      {
        key: 'gear',
        label: CONTRACTOR_PAGES.gear,
        icon: 'settings',
        path: 'settings',
        permission: 'contractor.manage',
      },
    ],
    settingsPath: 'settings',
  },
  ai: {
    directory:
      'contractor and home service jobs: every job and project with its customer, the property it’s at, its trade, status (new, scheduled, in progress, on hold, done, cancelled), deadline, job lead and team, phases with their dates and % done, its visits, and its price and budget for people who may see job costs; starting jobs, making a service call a project, moving jobs and phases along, adding properties, and its settings (the business’s trades and the phases a new project starts with)',
    places: CONTRACTOR_PLACES,
    lookAlikes: CONTRACTOR_LOOK_ALIKES,
  },
});
