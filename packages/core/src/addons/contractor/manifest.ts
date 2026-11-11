/**
 * Contractor Operations: its manifest (docs/contractor.md, HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md,
 * docs/addon-architecture.md). Browser-safe: the screens, the API, the worker and the AI all read it, so it holds no
 * server code. Everything it declares starts with its id, `contractor`.
 *
 * One add-on for every trade (the owner's decision 1, 2026-11-10): electricians, plumbers, HVAC, roofers, remodelers
 * and general contractors pick their trades in its settings. Part 1 is jobs and projects: a job is a record of its
 * own kind, at a property (another kind it keeps) the customer owns, and starts as a service call; with phases it's
 * a project, with deadlines, a budget and % done. Part 2 is costs and estimates: what each price list item costs,
 * an estimate builder with labor, materials, markup, profit and margin that writes an ordinary HandsFreeOS estimate,
 * and a lowest margin under which an estimate waits for an owner's or admin's OK. Part 3 is crews, work orders and
 * dispatch: named crews of team members and subcontractors, a work order on every visit (instructions, what to bring,
 * who's going, a checklist of boxes and photos), a job that can't be marked Done while a required item is left, and
 * one screen for the day's visits. Part 4 is materials: one list per job of what it needs and how much is ordered,
 * delivered, used, wasted and returned, filled from an approved estimate, with what each visit is still missing and
 * an alert before it. Part 5 is time and job costing: travel and work time from the buttons a crew already taps on a
 * visit, with breaks, what an hour of each person costs, what each job has cost against its plan and where it's
 * heading, and a profit page by job, crew, service and customer. Part 6 is the phone's field pages: its jobs, a job
 * and a visit's work order on the phone, where ticking the checklist, adding its photos, counting what was used,
 * taking a break and leaving a typed, spoken or photographed note all work with no signal. Part 7 is the AI helpers,
 * each of which prepares something and leaves the deciding to a person (the owner's rule): a draft of an estimate
 * from a job's notes, photos and measurements, which a person opens, checks and saves; an alert for the people who
 * may see job costs when a job heads over its budget, with the profit it's now heading for; and a daily report of
 * each job from what its crew left that day, with an update for the customer that goes only when a person sends it.
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
      'estimate builder',
      'job costing',
      'markup',
      'profit margin',
      'good better best',
      'crews',
      'subcontractors',
      'work orders',
      'checklists',
      'dispatch',
      'materials',
      'parts',
      'supplies',
      'field notes',
      'voice notes',
      'works offline',
      'time tracking',
      'timesheet',
      'labor cost',
      'job profit',
      'profit by job',
    ],
    exampleNeeds: [
      'keep track of my jobs and projects',
      'see which jobs are running late',
      'manage a remodel in phases',
      'track every job at a customer’s property',
      'see the profit in an estimate before I send it',
      'stop estimates going out under my margin',
      'give my crews a checklist for every visit',
      'see who’s on which job today',
      'know what materials a job is still missing before the crew leaves',
      'track my crew’s hours on each job',
      'let my techs work a job on their phones with no signal',
      'see which jobs made money',
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
      id: 'contractor.estimates',
      label: 'Estimates with costs',
      description:
        'An estimate builder with labor, materials, markup, profit and margin, good, better and best options, and a lowest margin an owner or admin OKs going under.',
      permission: 'contractor.costs',
    },
    {
      id: 'contractor.crews',
      label: 'Crews, work orders and dispatch',
      description:
        'Crews of team members and subcontractors, a work order with a checklist on every visit, and the day’s visits by person.',
      permission: 'contractor.use',
    },
    {
      id: 'contractor.materials',
      label: 'Materials per job',
      description:
        'What each job needs and how much is ordered, delivered, used, wasted and returned, with an alert before a visit that’s still missing something.',
      permission: 'contractor.use',
    },
    {
      id: 'contractor.time',
      label: 'Time on jobs',
      description:
        'Travel and work time from the buttons a crew already taps on a visit, with breaks, and fixes by an owner or admin.',
      permission: 'contractor.use',
    },
    {
      id: 'contractor.field',
      label: 'The job on the phone',
      description:
        'Jobs, work orders, checklists and their photos, materials used, breaks and notes on the phone, with no signal.',
      permission: 'contractor.use',
    },
    {
      id: 'contractor.costing',
      label: 'Job costing and profit',
      description:
        'What each job has cost in labor, materials and everything else against its plan, where it’s heading, and profit by job, crew, service and customer.',
      permission: 'contractor.costs',
    },
    {
      id: 'contractor.ai',
      label: 'AI helpers',
      description:
        'An estimate drafted from a job’s notes, photos and measurements for a person to check and save, an alert when a job heads over budget, and a daily report of each job from what its crew left.',
      permission: 'contractor.use',
    },
    {
      id: 'contractor.manage',
      label: 'Contractor Operations settings',
      description:
        'The business’s trades, its crews, the phases and checklist new work starts with, when missing materials are told, and what the AI does on its own.',
      permission: 'contractor.manage',
    },
  ],
  // Exist only while it runs in a business. Its migration registers the same list (the parity test checks).
  permissions: [
    {
      key: 'contractor.use',
      label: 'Use Contractor Operations',
      description:
        'See every job and project, start them, and change their status, phases, dates, team and % done. Work a visit’s work order and checklist, keep a job’s materials, see dispatch, see the time tracked on jobs and take a break, and leave notes from the field.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'contractor.costs',
      label: 'See job costs and profit',
      description:
        'See and set what each job is priced at, its budget, what its materials cost and its other costs, and see what its time cost, where its costs are heading and profit by job, crew, service and customer. Techs see their work without the money (the owner’s decision 11).',
      defaultRoles: ['admin'],
      requires: ['contractor.use'],
    },
    {
      key: 'contractor.manage',
      label: 'Set up Contractor Operations',
      description:
        'Pick the business’s trades, set up its crews, set the phases a new project and the checklist a new visit start with, and when missing materials are told. Take anyone’s note off a job.',
      defaultRoles: ['admin'],
      requires: ['contractor.use'],
    },
    {
      key: 'contractor.approve',
      label: 'OK estimates under the lowest margin',
      description:
        'OK an estimate that’s under the business’s lowest margin so it can be sent, and set that margin, the starting markup, labor’s hourly price and cost, and what an hour of each person costs (the owner’s decision 6).',
      defaultRoles: ['admin'],
      requires: ['contractor.costs'],
    },
    {
      key: 'contractor.skip_checks',
      label: 'Mark a job done with required items left',
      description:
        'Mark a job done while required checklist items or photos are still left on its work orders, with a reason (the owner’s decision 8).',
      defaultRoles: ['admin'],
      requires: ['contractor.use'],
    },
    {
      key: 'contractor.fix_time',
      label: 'Fix time on jobs',
      description:
        'Change, add and remove the time tracked on jobs, with a reason (the owner’s decision 10).',
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
  tables: [
    'jobs',
    'phases',
    'team',
    'money',
    'estimating',
    'item_costs',
    'estimates',
    'estimate_costs',
    'estimate_oks',
    'crews',
    'crew_members',
    'work_orders',
    'work_order_items',
    'work_order_subs',
    'materials',
    'material_costs',
    'time_entries',
    'time_costs',
    'labor_rates',
    'other_costs',
    'notes',
    'estimate_drafts',
    'budget_watch',
    'daily_reports',
  ],
  // Before a visit: what it's still missing from the job's materials (apps/worker/src/addons/contractor/materials.ts).
  // On a visit with time running: stopping what has run half a day (./time.ts there). A month after a job closes:
  // taking it off phones (./phone.ts there). A moment after something that costs money changes on a job: where its
  // budget stands (./budget.ts there). The evening of a day with notes: its daily report (./reports.ts there).
  jobs: [
    'contractor.materials_check',
    'contractor.time_check',
    'contractor.phone_check',
    'contractor.budget_check',
    'contractor.report_write',
  ],
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
      'contractor.estimate.saved',
      'contractor.estimate.ok_asked',
      'contractor.estimate.okayed',
      'contractor.estimate.sent',
      'contractor.estimating.saved',
      'contractor.item_cost.set',
      'contractor.job.checks_skipped',
      'contractor.crew.saved',
      'contractor.crew.archived',
      'contractor.work_order.started',
      'contractor.work_order.updated',
      'contractor.work_order.crew_set',
      'contractor.work_order.sub_added',
      'contractor.work_order.sub_removed',
      'contractor.work_order.sub_set',
      'contractor.work_order.subs_told',
      'contractor.work_order.item_added',
      'contractor.work_order.item_updated',
      'contractor.work_order.item_removed',
      'contractor.work_order.item_set',
      'contractor.material.added',
      'contractor.material.updated',
      'contractor.material.removed',
      'contractor.material.cost_set',
      'contractor.materials.filled',
      'contractor.time.tracked',
      'contractor.time.break_set',
      'contractor.time.fixed',
      'contractor.time.added',
      'contractor.time.removed',
      'contractor.time.auto_stopped',
      'contractor.labor_rate.set',
      'contractor.other_cost.added',
      'contractor.other_cost.removed',
      'contractor.note.added',
      'contractor.note.removed',
      'contractor.note.transcribed',
      'contractor.estimate_draft.ready',
      'contractor.estimate_draft.dismissed',
      'contractor.report.written',
      'contractor.report.updated',
      'contractor.report.sent',
    ],
    // A visit booked on a job moves it to Scheduled and gets its work order, with the checklist a new visit starts
    // with; a tech tapping Started on one of its visits moves it to In
    // progress. An estimate the customer approves fills its job's price and budget. An OK asked for on an estimate
    // is an alert for the owners and admins until it's given, the estimate changes or it goes out
    // (apps/worker/src/addons/contractor/index.ts). A visit's missing materials are looked at before it, and again
    // whenever the visit moves or the job's materials change (./materials.ts there). Every status button on a visit
    // starts or stops the time of the people on it; time that changes gets what its hour cost, and a visit with time
    // running is looked at when it has run half a day (./time.ts there). A voice note's recording gets its words
    // (./notes.ts there), and a job that closes leaves phones a month later (./phone.ts there). Whatever changes
    // what a job costs or how far along it is has its budget looked at (./budget.ts there), and a day's notes get
    // the day's report that evening (./reports.ts there).
    consumes: [
      'appointment.booked',
      'appointment.rescheduled',
      'appointment.cancelled',
      'job.status_changed',
      'estimate.accepted',
      'estimate.voided',
      'contractor.estimate.saved',
      'contractor.estimate.ok_asked',
      'contractor.estimate.okayed',
      'contractor.estimate.sent',
      'contractor.material.added',
      'contractor.material.updated',
      'contractor.material.removed',
      'contractor.materials.filled',
      'contractor.time.tracked',
      'contractor.time.break_set',
      'contractor.time.fixed',
      'contractor.time.added',
      'contractor.time.removed',
      'contractor.labor_rate.set',
      'contractor.estimating.saved',
      'contractor.note.added',
      'contractor.note.transcribed',
      'contractor.job.status_changed',
      'contractor.job.money_set',
      'contractor.job.percent_set',
      'contractor.phase.updated',
      'contractor.material.cost_set',
      'contractor.other_cost.added',
      'contractor.other_cost.removed',
    ],
  },
  // What phones keep, so the field pages work with no signal (part 6; migration 20261027025300 registers the same,
  // and a test holds the two equal). No money: not a job's price or budget, what a material or an hour costs, nor
  // its other costs (the owner's decision 11).
  offline: {
    permission: 'contractor.use',
    tables: [
      {
        table: 'jobs',
        key: 'record_id',
        record: 'record_id',
        columns: [
          'kind',
          'status',
          'status_at',
          'status_reason',
          'trade',
          'details',
          'starts_on',
          'due_on',
          'done_at',
          'percent_done',
          'lead_user_id',
          'updated_at',
        ],
      },
      {
        table: 'phases',
        record: 'record_id',
        columns: [
          'position',
          'name',
          'status',
          'percent_done',
          'starts_on',
          'due_on',
          'done_at',
          'created_at',
        ],
      },
      { table: 'team', record: 'record_id', columns: ['user_id', 'created_at'] },
      // The business's own: a work order names its crew.
      { table: 'crews', columns: ['name', 'archived_at'] },
      {
        table: 'work_orders',
        key: 'appointment_id',
        record: 'record_id',
        columns: ['crew_id', 'instructions', 'bring', 'updated_at'],
      },
      {
        table: 'work_order_items',
        record: 'record_id',
        columns: [
          'appointment_id',
          'position',
          'label',
          'kind',
          'required',
          'done_at',
          'done_by',
          'file_id',
          'skipped_at',
          'skipped_by',
          'skip_reason',
          'created_at',
        ],
      },
      {
        table: 'work_order_subs',
        record: 'record_id',
        columns: [
          'appointment_id',
          'person_id',
          'told_at',
          'done_at',
          'done_by',
          'note',
          'created_at',
        ],
      },
      {
        table: 'materials',
        record: 'record_id',
        columns: [
          'position',
          'name',
          'unit_label',
          'appointment_id',
          'needed',
          'ordered',
          'delivered',
          'used',
          'wasted',
          'returned',
          'supplier',
          'expected_on',
          'note',
          'created_at',
        ],
      },
      {
        table: 'time_entries',
        record: 'record_id',
        columns: [
          'appointment_id',
          'user_id',
          'kind',
          'started_at',
          'ended_at',
          'source',
          'auto_stopped',
          'fixed_at',
        ],
      },
      {
        table: 'notes',
        record: 'record_id',
        columns: [
          'appointment_id',
          'body',
          'audio_file_id',
          'transcript',
          'transcript_state',
          'photo_file_ids',
          'created_by',
          'noted_at',
        ],
      },
    ],
  },
  billing: { model: 'free' },
  settings: { version: 1, permission: 'contractor.manage', workspace: ContractorSettingsSchema },
  ui: {
    // Its pages in the side menu, which pop out from its one row (the owner's decision, 2026-10-09).
    nav: [
      { key: 'jobs', label: CONTRACTOR_PAGES.jobs, icon: 'hard-hat', path: '' },
      {
        key: 'dispatch',
        label: CONTRACTOR_PAGES.dispatch,
        icon: 'calendar-clock',
        path: 'dispatch',
      },
      {
        key: 'estimates',
        label: CONTRACTOR_PAGES.estimates,
        icon: 'file-text',
        path: 'estimates',
        permission: 'contractor.costs',
      },
      {
        key: 'costs',
        label: CONTRACTOR_PAGES.costs,
        icon: 'calculator',
        path: 'costs',
        permission: 'contractor.costs',
      },
      {
        key: 'profit',
        label: CONTRACTOR_PAGES.profit,
        icon: 'circle-dollar-sign',
        path: 'profit',
        permission: 'contractor.costs',
      },
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
    // On core's estimate page: an estimate built here shows its costs and profit, and opens in its builder.
    slots: [{ slot: 'estimate.panels', permission: 'contractor.costs' }],
    // The pages the phone draws (part 6): its jobs, a job and a visit's work order. Dispatch, estimates, costs,
    // profit and settings open the web there.
    phone: [
      { path: '', query: ['filter', 'q'] },
      { path: 'jobs/:jobId' },
      { path: 'visits/:appointmentId' },
    ],
  },
  ai: {
    directory:
      'contractor and home service jobs: every job and project with its customer, the property it’s at, its trade, status (new, scheduled, in progress, on hold, done, cancelled), deadline, job lead and team, phases with their dates and % done, its visits, and its price and budget for people who may see job costs; starting jobs, making a service call a project, moving jobs and phases along, adding properties, and its settings (the business’s trades and the phases a new project starts with); estimates with costs: an estimate builder with labor by the hour, materials at cost, markup, profit and margin, good, better and best options, what each price list item costs the business, the lowest margin an estimate may go out at, asking for and giving an owner’s or admin’s OK on one under it, and sending it; crews (named groups of team members and subcontractors), a work order on every visit (instructions, what to bring, the crew and who’s going, subcontractors and texting them the job’s details, and a checklist of boxes to tick and photos to add, some required), a job that can’t be marked done while a required item is left unless an owner or admin says why, and dispatch (a day’s visits by person, the ones nobody is on, where each stands, and jobs with nothing booked); a job’s materials (what it needs, and how much of each is ordered, delivered, used, wasted and returned, the visit each is for, its supplier and the day it’s expected, what’s still missing for a visit, materials filled in from an approved estimate, what each costs for people who may see job costs, and the alert before a visit that’s still missing something); time on jobs (travel and work time started and stopped by a visit’s On the way, Started, Waiting on parts and Done buttons, breaks, each stretch with whose it is and how long, time stopped on its own after 12 hours, and fixing, adding and removing time with a reason for people who may); job costing for people who may see job costs (what an hour of each person costs, a job’s labor, materials and other costs planned, so far and heading for, its other costs like permits and fees, the profit it’s heading for, and profit by job, customer, crew and service); notes from the field on a job or one of its visits (typed, a voice note with its words, or photos), counting how much more of a material was used, wasted or sent back, and the phone’s pages (Jobs, a job and a visit’s work order), which work with no signal; and the AI helpers: an estimate the AI drafts for a job from its notes, photos and what someone types, kept as a draft that a person opens in the builder, checks and saves (the AI never writes or sends an estimate on its own), where a job’s budget stands (heading over its planned cost, under the lowest margin or for a loss) with what’s driving it and what the business could do, and each job’s daily report (what got done, what needs a look, materials, what’s next, the crew’s hours and the day’s photos), with an update for the customer that goes only when a person sends it',
    places: CONTRACTOR_PLACES,
    lookAlikes: CONTRACTOR_LOOK_ALIKES,
  },
});
