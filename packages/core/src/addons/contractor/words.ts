/**
 * Contractor Operations' words (docs/contractor.md): what its pages, its refusals and the AI say, in one place so the
 * web, the phone and the Assistant read the same. Browser-safe and pure.
 */
import { marginWords, type CostKind, type OkReason } from './estimating';
import type { JobKind, JobStatus, PhaseStatus } from './progress';

export const CONTRACTOR_NAME = 'Contractor Operations';

/** Its pages in the side menu, which pop out of its one row. */
export const CONTRACTOR_PAGES = {
  jobs: 'Jobs',
  estimates: 'Estimates',
  costs: 'Item costs',
  gear: 'Settings',
} as const;

export const COST_KIND_WORDS: Readonly<Record<CostKind, string>> = {
  labor: 'Labor',
  material: 'Material',
  other: 'Other',
};

/** What each kind of cost is, for its picker and the AI. */
export const COST_KIND_HINTS: Readonly<Record<CostKind, string>> = {
  labor: 'People’s time, by the hour.',
  material: 'Things you buy for the job.',
  other: 'Anything else, such as a permit or a dumpster.',
};

/**
 * Why an estimate waits for an owner’s or admin’s OK before it goes out (the owner’s decision 6), in a sentence;
 * null when it doesn’t. The builder, the refusal and the Assistant all say it this way.
 */
export function okNeededWords(check: {
  readonly needsOk: OkReason | null;
  readonly lowest: { readonly name: string | null; readonly marginBp: number | null } | null;
  readonly minMarginBp: number;
  readonly uncosted: number;
}): string | null {
  if (check.needsOk === 'margin' && check.lowest?.marginBp != null) {
    const which = check.lowest.name
      ? `The “${check.lowest.name}” option’s margin`
      : 'This estimate’s margin';
    return `${which} is ${marginWords(check.lowest.marginBp)}, under your lowest margin of ${marginWords(check.minMarginBp)}.`;
  }
  if (check.needsOk === 'uncosted')
    return check.uncosted === 1
      ? 'One labor or material line has no cost yet, so the margin can’t be checked.'
      : `${check.uncosted} labor or material lines have no cost yet, so the margin can’t be checked.`;
  return null;
}

export const JOB_STATUS_WORDS: Readonly<Record<JobStatus, string>> = {
  new: 'New',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  on_hold: 'On hold',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** What each status means, for the status picker and the AI. */
export const JOB_STATUS_HINTS: Readonly<Record<JobStatus, string>> = {
  new: 'Not scheduled yet.',
  scheduled: 'A visit is booked.',
  in_progress: 'The work has started.',
  on_hold: 'Waiting on something, such as the customer, a permit or materials.',
  done: 'The work is finished.',
  cancelled: 'It isn’t going ahead.',
};

export const JOB_KIND_WORDS: Readonly<Record<JobKind, string>> = {
  service: 'Service call',
  project: 'Project',
};

export const PHASE_STATUS_WORDS: Readonly<Record<PhaseStatus, string>> = {
  not_started: 'Not started',
  in_progress: 'Started',
  done: 'Done',
};

/** A visit's own status (core's appointment), as a job's visits list says it. */
export const VISIT_STATUS_WORDS: Readonly<Record<string, string>> = {
  scheduled: 'Booked',
  completed: 'Done',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

/** "3 days late" · "1 day late". */
export const lateWords = (days: number) => `${days} ${days === 1 ? 'day' : 'days'} late`;

/** "Due today" · "Due in 4 days" · "2 days late". */
export function dueWords(daysLeft: number): string {
  if (daysLeft < 0) return lateWords(-daysLeft);
  if (daysLeft === 0) return 'Due today';
  if (daysLeft === 1) return 'Due tomorrow';
  return `Due in ${daysLeft} days`;
}

/** "25%" from basis points: 2,500 → "25%". */
export const percentFromBp = (bp: number) => `${Math.round(bp / 100)}%`;

/** "12.5 hours" · "1 hour". */
export const hoursWords = (h: number) =>
  `${Number.isInteger(h) ? h : h.toFixed(1).replace(/\.0$/, '')} ${h === 1 ? 'hour' : 'hours'}`;

export const CONTRACTOR_WORDS = {
  title: CONTRACTOR_NAME,
  jobs: {
    title: CONTRACTOR_PAGES.jobs,
    lede: 'Every job, from a quick service call to a whole project, with where each one stands.',
    newJob: 'New job',
    views: { board: 'Board', list: 'List' },
    filters: { all: 'All jobs', mine: 'My jobs', late: 'Late' },
    search: 'Search jobs',
    showClosed: 'Show done and cancelled',
    none: 'No jobs yet. Start one with New job.',
    noneMatch: 'No jobs match. Try another search, or turn off a filter.',
    counts: { open: 'Open', late: 'Late', onHold: 'On hold', doneThisMonth: 'Done this month' },
    setUp: 'Pick your trade to get starter phases for your projects.',
    setUpButton: 'Pick your trade',
  },
  newJob: {
    title: 'New job',
    name: 'Job name',
    namePlaceholder: 'Replace water heater',
    kind: 'What kind of job',
    kindHints: {
      service: 'One piece of work, usually one visit.',
      project: 'Bigger work in phases, with deadlines and % done.',
    } satisfies Record<JobKind, string>,
    customer: 'Customer',
    customerPlaceholder: 'Search customers',
    property: 'Property',
    newProperty: 'New property',
    propertyAddress: 'Address',
    propertyPlaceholder: '12 Oak St, Springfield',
    trade: 'Trade',
    lead: 'Job lead',
    startsOn: 'Starts',
    dueOn: 'Deadline',
    details: 'Work to do',
    detailsPlaceholder: 'What the customer wants done, and anything the crew should know.',
    create: 'Start the job',
    created: (name: string) => `“${name}” is started.`,
  },
  job: {
    back: 'Jobs',
    status: 'Status',
    reason: 'Why',
    reasonPlaceholder: {
      on_hold: 'Waiting on the permit',
      cancelled: 'The customer went with someone else',
    } satisfies Partial<Record<JobStatus, string>>,
    statusSet: (status: string) => `Marked ${status.toLowerCase()}.`,
    percentDone: '% done',
    setPercent: 'Set % done',
    percentSet: (p: number) => `Marked ${p}% done.`,
    late: 'Late',
    customer: 'Customer',
    property: 'Property',
    noCustomer: 'No customer yet',
    noProperty: 'No property yet',
    lead: 'Job lead',
    noLead: 'Nobody yet',
    team: 'Team',
    addToTeam: 'Add to the team',
    removeFromTeam: 'Take off the team',
    teamNone: 'Nobody else is on this job yet.',
    trade: 'Trade',
    startsOn: 'Starts',
    dueOn: 'Deadline',
    details: 'Work to do',
    noDetails: 'Nothing written yet.',
    edit: 'Edit',
    save: 'Save',
    saved: 'Saved.',
    cancel: 'Cancel',
    visits: 'Visits',
    visitsNone: 'No visits on this job yet.',
    bookVisit: 'Book a visit',
    openRecord: 'Notes, files and tasks',
    phases: {
      title: 'Phases',
      none: 'A service call has no phases. Add one to make it a project.',
      add: 'Add a phase',
      addPlaceholder: 'Rough-in inspection',
      addStarters: 'Add the starter phases',
      makeProject: 'Make it a project',
      madeProject: 'It’s a project now, with its starter phases.',
      rename: 'Rename',
      remove: 'Remove',
      removeAsk: (name: string) =>
        `Remove “${name}”? Its dates and % done go with it. The job and everything else on it stay.`,
      removed: (name: string) => `“${name}” is removed.`,
      moveUp: 'Move up',
      moveDown: 'Move down',
      startsOn: 'Starts',
      dueOn: 'Deadline',
    },
    money: {
      title: 'Budget and price',
      hint: 'Only people who may see job costs and profit see this.',
      price: 'Price to the customer',
      labor: 'Labor',
      materials: 'Materials',
      other: 'Other costs',
      hours: 'Labor hours',
      total: 'Budget',
      profit: 'Planned profit',
      margin: 'Margin',
      notSet: 'Not set',
      edit: 'Set the budget',
      saved: 'Budget saved.',
    },
  },
  settings: {
    title: 'Settings',
    lede: 'Your trades, and the phases a new project starts with.',
    trades: 'Your trades',
    tradesHint:
      'Pick every trade you do. Each brings its starter phases, and later its checklists and materials.',
    phases: 'Phases for a new project',
    phasesHint:
      'Every new project starts with these. Leave it empty to use your first trade’s starter phases.',
    startFrom: (trade: string) => `Start from ${trade}`,
    addPhase: 'Add',
    save: 'Save settings',
    saved: 'Settings saved.',
  },
  panels: {
    jobsTitle: 'Jobs',
    jobsNone: 'No jobs yet.',
    newJob: 'New job',
    openJob: 'Open the job',
    estimateTitle: 'Costs and profit',
    estimateHint:
      'This estimate was built in Contractor Operations, which checks its margin before it goes out.',
    openBuilder: 'Open the estimate builder',
  },
  estimates: {
    title: CONTRACTOR_PAGES.estimates,
    lede: 'Estimates with what they cost to do: labor, materials, markup, profit and margin.',
    none: 'No estimates on this job yet.',
    noneAll: 'No estimates yet. Start one with New estimate, or from a job’s page.',
    noneWaiting: 'Nothing is waiting for an OK.',
    add: 'New estimate',
    filters: { all: 'All estimates', waiting: 'Waiting for an OK' },
    draft: 'Draft',
    waitingOk: 'Waiting for an OK',
    okGiven: 'OK’d',
    options: (n: number) => `${n} options`,
    picked: (name: string) => `They picked ${name}`,
    needOk: (n: number) =>
      n === 1 ? '1 estimate is waiting for your OK' : `${n} estimates are waiting for your OK`,
    review: 'Review',
  },
  builder: {
    newTitle: 'New estimate',
    title: 'Estimate',
    forJob: 'Job',
    noJob: 'No job',
    customer: 'Customer',
    titleField: 'What it’s for',
    titlePlaceholder: 'Replace the water heater',
    lines: 'Lines',
    addLine: 'Add a line',
    addLabor: 'Add labor',
    laborName: 'Labor',
    laborUnit: 'hour',
    fromPriceList: 'Search your price list, or type a new line',
    kind: 'Kind',
    cost: 'Cost each',
    costHint: 'What one costs you. The customer never sees it.',
    price: 'Price each',
    markup: 'Markup',
    quantity: 'Qty',
    lineProfit: 'Profit',
    remove: 'Remove',
    notes: 'Notes for the customer',
    expires: 'Good until',
    discount: 'Discount',
    deposit: 'Up front if they say yes',
    costing: {
      title: 'Costs and profit',
      hint: 'Only people who may see job costs and profit see this. The customer never does.',
      price: 'Price before tax',
      labor: 'Labor',
      materials: 'Materials',
      other: 'Other costs',
      cost: 'Cost',
      profit: 'Profit',
      margin: 'Margin',
      hours: 'Labor hours',
      lowest: (min: string) => `Your lowest margin is ${min}.`,
      fine: 'Every option is at or over your lowest margin.',
      fineOne: 'It’s at or over your lowest margin.',
    },
    ok: {
      needed: 'It needs an owner’s or admin’s OK before it’s sent.',
      ask: 'Ask for an OK',
      asked: (who: string | null) =>
        who ? `${who} asked for an OK.` : 'An OK has been asked for.',
      askedNow: 'Asked. The owners and admins have been told.',
      give: 'OK it',
      note: 'A note (optional)',
      notePlaceholder: 'Repeat customer, OK at this price',
      given: (who: string | null) =>
        who ? `${who} OK’d it as it is now.` : 'It’s OK’d as it is now.',
      givenNow: 'OK’d. It can be sent.',
      stale: 'It changed after the last OK, so it needs a fresh one.',
    },
    save: 'Save',
    saved: 'Saved.',
    send: 'Send',
    sent: 'Sent.',
    unsaved: 'Save your changes first.',
    openDocument: 'See it as the customer does',
    noBilling:
      'You can look, but writing and sending estimates needs “Send estimates and invoices, start plans”. An owner or admin can give it to you in Settings → Team.',
    gone: 'It has gone out, so it can’t be changed here. To send a changed one, void it and make a new estimate.',
  },
  estimating: {
    title: 'Estimating',
    lede: 'How estimates are priced and checked here.',
    minMargin: 'Lowest margin',
    minMarginHint:
      'An estimate under this waits for an owner or admin to OK it before it’s sent. 0% turns the check off for margin, but lines with no cost still wait.',
    markup: 'Starting markup',
    markupHint: 'A new line’s price starts at its cost plus this.',
    laborRate: 'Labor price per hour',
    laborCost: 'Labor cost per hour',
    laborHint: 'What an hour of labor sells for and what it costs you, for Add labor.',
    save: 'Save estimating',
    saved: 'Estimating saved.',
    readOnly: 'Only an owner or admin changes these.',
  },
  costs: {
    title: CONTRACTOR_PAGES.costs,
    lede: 'What each item on your price list costs you, so estimates know their profit.',
    search: 'Search your price list',
    none: 'Your price list is empty. Add what you sell in Settings → Products, then set what each costs here.',
    noneMatch: 'Nothing on your price list matches.',
    item: 'Item',
    price: 'Price',
    cost: 'Cost',
    kind: 'Kind',
    margin: 'Margin',
    notSet: 'Not set',
    save: 'Save',
    saved: (name: string) => `${name}’s cost is saved.`,
    cleared: (name: string) => `${name}’s cost is taken off.`,
    products: 'Open your price list',
  },
} as const;

// ---------- refusals: say what's wrong, then what to do ----------

export const REFUSALS = {
  settingUp: 'Contractor Operations is still being set up in this business. Try again in a minute.',
  jobGone:
    'That job isn’t there anymore. It may have been archived or its data deleted. Refresh and try again.',
  phaseGone: 'That phase isn’t there anymore. Someone may have removed it. Refresh and try again.',
  customerGone:
    'That customer isn’t there anymore. They may have been deleted. Pick another customer, or add them first.',
  propertyGone:
    'That property isn’t there anymore. It may have been archived. Pick another property, or add its address as a new one.',
  propertyOrAddress: 'Pick a property, or type a new address, not both.',
  reasonNeeded: (status: string) =>
    `Say why it’s ${status.toLowerCase()}, so the team knows. Put it in Why and try again.`,
  closedJob: (name: string, status: string) =>
    `“${name}” is ${status.toLowerCase()}. Mark it in progress again first if there’s more to do.`,
  datesBackwards: 'The deadline is before the start. Pick a deadline on or after the start day.',
  tooManyPhases: (max: number) =>
    `A project has ${max} phases at most. Combine some, or remove ones that are done with.`,
  phaseNameTaken: (name: string) =>
    `This job already has a phase called “${name}”. Give it another name.`,
  notOnTeam: (who: string) =>
    `${who} can’t use Contractor Operations here, so they can’t be on a job. An owner or admin can give them “Use Contractor Operations” in Settings → Team.`,
  leadOnly: 'Only an owner or admin puts someone else in charge of a job. Ask one of them.',
  teamFull: (max: number) => `A job has ${max} people on its team at most. Take someone off first.`,
  percentOnProject: 'A project’s % done comes from its phases. Set each phase’s % done instead.',
  phaseOrder: 'Give every phase on this job, once each, in the new order. Refresh and try again.',
  estimateGone:
    'That estimate isn’t there anymore. It may have been deleted. Refresh and try again.',
  estimateNotHere:
    'That estimate wasn’t written in Contractor Operations, so it has no costs to check. Open it in Money → Estimates instead.',
  estimateCustomer: 'Say who the estimate is for. Pick a customer, or pick a job that has one.',
  estimateOptionNames:
    'Name each option, such as Good, Better and Best, so the customer can tell them apart.',
  estimateNotDraft: (doing: 'change' | 'OK' | 'ask about') =>
    doing === 'change'
      ? 'This estimate has gone out, so it can’t be changed. To send a changed one, void it in Money → Estimates and make a new estimate.'
      : `This estimate has already gone out, so there’s nothing to ${doing}.`,
  marginNeedsOk: (why: string, mayApprove: boolean) =>
    mayApprove
      ? `${why} OK it first with OK it on the estimate, or raise its price.`
      : `${why} Ask an owner or admin with Ask for an OK on the estimate, or raise its price.`,
  productGone:
    'That price list item isn’t there anymore. It may have been archived. Pick another from Settings → Products.',
} as const;
