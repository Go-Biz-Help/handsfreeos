/**
 * Contractor Operations' words (docs/contractor.md): what its pages, its refusals and the AI say, in one place so the
 * web, the phone and the Assistant read the same. Browser-safe and pure.
 */
import { JOB_STATUS_WORDS as CORE_VISIT_STAGE_WORDS } from '../../schemas/job';
import { requiredItemsWords, type ItemKind } from './checklists';
import { marginWords, type CostKind, type OkReason } from './estimating';
import type { JobKind, JobStatus, PhaseStatus } from './progress';

export const CONTRACTOR_NAME = 'Contractor Operations';

/** Its pages in the side menu, which pop out of its one row. */
export const CONTRACTOR_PAGES = {
  jobs: 'Jobs',
  dispatch: 'Dispatch',
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

/** Where a visit stands, as its crew sets it in Calendar or on the phone: core's own words for it. */
export const VISIT_STAGE_WORDS = CORE_VISIT_STAGE_WORDS;

export const ITEM_KIND_WORDS: Readonly<Record<ItemKind, string>> = {
  check: 'Checkbox',
  photo: 'Photo',
};

/** "Ana, Ben and 2 more": a few names said in a sentence. */
export function namesWords(names: readonly string[], most = 3): string {
  const shown = names.slice(0, most);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * The text a subcontractor gets about a visit (the owner's decision 7): who it's from, the job, where, when, what to
 * do and what to bring. They don't sign in, so it says everything they need and that they can reply.
 */
export function subTextWords(t: {
  readonly firstName: string | null;
  readonly business: string;
  readonly job: string;
  readonly address: string | null;
  readonly when: string;
  readonly instructions: string | null;
  readonly bring: string | null;
  readonly note: string | null;
}): string {
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return [
    `${t.firstName ? `Hi ${t.firstName}, ` : ''}${t.business} has you on a job: ${t.job}${
      t.address ? ` at ${t.address}` : ''
    }, ${t.when}.`,
    t.instructions ? `Work to do: ${clip(t.instructions, 500)}` : null,
    t.bring ? `Bring: ${clip(t.bring, 200)}` : null,
    t.note || null,
    'Reply here with any questions.',
  ]
    .filter(Boolean)
    .join('\n');
}

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
    openWorkOrder: 'Work order',
    notReady: {
      title: 'Not ready to mark done',
      left: (n: number) => `${requiredItemsWords(n)} still left on its work orders:`,
      onVisit: (when: string) => `Visit of ${when}`,
      finish: 'Finish them on each visit’s work order.',
      askAdmin: 'Or ask an owner or admin to mark the job done anyway.',
      skipTitle: 'Or mark it done anyway',
      skipHint: 'Say why. The reason is kept on each item passed over, and on the job’s timeline.',
      skipReason: 'Why',
      skipReasonPlaceholder: 'The customer wasn’t home for the walkthrough',
      skip: 'Mark done anyway',
      skipped: 'Marked done, with the reason kept.',
      close: 'Close',
    },
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
  dispatch: {
    title: CONTRACTOR_PAGES.dispatch,
    lede: 'The day’s visits by person, what nobody is on yet, and where each visit stands.',
    today: 'Today',
    previous: 'Day before',
    next: 'Day after',
    pickDay: 'Day',
    nobody: 'Nobody on it yet',
    nobodyHint: 'Open a visit’s work order to put a crew on it.',
    noVisits: 'No visits on jobs this day.',
    subs: (done: number, total: number) =>
      total === 1
        ? `1 subcontractor${done ? ', done' : ''}`
        : `${total} subcontractors, ${done} done`,
    noWorkOrder: 'No work order yet',
    needsVisit: 'Needs a visit',
    needsVisitHint: 'Open jobs with nothing booked from today on.',
    needsVisitNone: 'Every open job has a visit booked.',
    book: 'Book a visit',
    openJob: 'Open the job',
    more: 'There are more visits this day than fit here. Open Calendar to see them all.',
  },
  workOrder: {
    title: 'Work order',
    when: 'When',
    stage: 'Where it stands',
    stageHint: 'Its crew sets this in Calendar or on their phones.',
    job: 'Job',
    workToDo: 'Work to do',
    whoGoes: 'Who’s going',
    crew: 'Crew',
    noCrew: 'No crew',
    crewHint:
      'Picking a crew puts everyone in it on the visit, and its subcontractors on this work order.',
    crewSet: (name: string) => `${name} is on the visit.`,
    crewCleared: 'The crew’s name is off the visit. The people on it stay.',
    crewAnyway: 'Put them on anyway',
    crewAnywayTitle: 'Someone in the crew isn’t free then',
    people: 'Team',
    peopleNone: 'Nobody on the team is on this visit yet.',
    subs: 'Subcontractors',
    subsHint:
      'Contacts who don’t sign in. Text them the job’s details, and mark their work when it’s done.',
    subsNone: 'No subcontractors on this visit.',
    addSub: 'Add a subcontractor',
    subAdded: (name: string) => `${name} is on the visit.`,
    removeSub: 'Take off the visit',
    subRemoved: (name: string) => `${name} is off the visit.`,
    tellSubs: 'Text them the details',
    tellOne: 'Text the details',
    tellNote: 'Add a line of your own (optional)',
    tellNotePlaceholder: 'Park on the street, the driveway is being poured.',
    tellSend: 'Send the text',
    told: (names: string) => `Texted ${names}.`,
    notToldTitle: 'Not texted',
    toldAt: 'Texted',
    notTold: 'Not texted yet',
    noMobile: 'No mobile number',
    subDone: 'Mark their work done',
    subNotDone: 'Not done after all',
    subDoneSaved: (name: string) => `${name}’s work is marked done.`,
    subUndone: (name: string) => `${name}’s work is back to not done.`,
    subWorkDone: 'Work done',
    instructions: 'Instructions',
    instructionsPlaceholder: 'What to do on this visit, where to park, who to ask for.',
    noInstructions: 'Nothing written yet.',
    bring: 'What to bring',
    bringPlaceholder: 'Tools, parts, a ladder.',
    noBring: 'Nothing listed yet.',
    edit: 'Edit',
    save: 'Save',
    saved: 'Saved.',
    cancel: 'Cancel',
    checklist: 'Checklist',
    checklistNone: 'Nothing on the checklist yet.',
    addItem: 'Add an item',
    addItemPlaceholder: 'Photo of the panel',
    itemKind: 'Kind',
    required: 'Required',
    requiredHint: 'The job can’t be marked done while a required item is left.',
    makeRequired: 'Make it required',
    makeOptional: 'Make it optional',
    addPhoto: 'Add a photo',
    replacePhoto: 'Replace the photo',
    seePhoto: 'See the photo',
    photoAdded: 'Photo added.',
    removeItem: 'Remove',
    removeItemAsk: (label: string) =>
      `Remove “${label}” from this visit’s checklist? The rest of the work order stays.`,
    itemRemoved: (label: string) => `“${label}” is removed.`,
    doneBy: (who: string | null) => (who ? `Done by ${who}` : 'Done'),
    skipped: (who: string | null, reason: string) =>
      `Passed over by ${who ?? 'an owner or admin'}: ${reason}`,
    ready: 'Every required item is done.',
    left: (n: number) => `${requiredItemsWords(n)} left before the job can be marked done.`,
    closed: (status: string) =>
      `The job is ${status.toLowerCase()}, so this work order can’t be changed.`,
    cancelled: 'This visit was cancelled, so its work order can’t be changed.',
    notStarted: 'This visit has no work order yet.',
    start: 'Start its work order',
    startHint: 'It starts with your checklist for a new visit.',
    started: 'Its work order is started.',
    quietAgain: 'Press Send again to send it anyway.',
    openInCalendar: 'Open in Calendar',
    untick: (label: string) => `Not done after all: ${label}`,
    tick: (label: string) => `Done: ${label}`,
    itemMenu: (label: string) => `More for ${label}`,
    uploading: 'Adding the photo…',
  },
  crews: {
    title: 'Crews',
    hint: 'Named groups of your team and subcontractors. Putting a crew on a visit books everyone in it.',
    none: 'No crews yet. Make one to book a whole team at once.',
    add: 'New crew',
    name: 'Crew name',
    namePlaceholder: 'Install crew',
    people: 'Team members',
    peopleNone: 'Nobody on your team can use Contractor Operations yet.',
    subs: 'Subcontractors',
    subsHint: 'Contacts who don’t sign in. For a company, pick the person you deal with there.',
    addSub: 'Add a subcontractor',
    removeSub: 'Take out of the crew',
    save: 'Save the crew',
    saved: (name: string) => `${name} is saved.`,
    edit: 'Edit',
    archive: 'Archive',
    archiveAsk: (name: string) =>
      `Archive ${name}? Visits it worked keep its name, and you can bring it back from Show archived.`,
    archived: (name: string) => `${name} is archived.`,
    restore: 'Bring back',
    restored: (name: string) => `${name} is back.`,
    showArchived: 'Show archived',
    size: (people: number, subs: number) =>
      [
        people ? `${people} on the team` : null,
        subs ? `${subs} ${subs === 1 ? 'subcontractor' : 'subcontractors'}` : null,
      ]
        .filter(Boolean)
        .join(', ') || 'Nobody in it yet',
  },
  checklistSettings: {
    title: 'Checklist for a new visit',
    hint: 'Every new work order starts with these. Leave it empty to use your first trade’s starter checklist.',
    startFrom: (trade: string) => `Start from ${trade}`,
    add: 'Add',
    addPlaceholder: 'Photo of the finished work',
    remove: 'Remove',
    usesTrade: (trade: string, items: string) =>
      `New visits use ${trade}’s starter checklist: ${items}.`,
    usesPlain: (items: string) =>
      `New visits start with ${items} until you pick a trade or add items here.`,
    saveFirst: 'Press Save settings to keep it.',
  },
  settings: {
    title: 'Settings',
    lede: 'Your trades, your crews, and what a new project and a new visit start with.',
    trades: 'Your trades',
    tradesHint:
      'Pick every trade you do. Each brings its starter phases and checklist, and later its materials.',
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
  visitGone: 'That visit isn’t there anymore. It may have been deleted. Refresh and try again.',
  visitNotOnJob:
    'That visit isn’t on a job, so it has no work order. Open the job and use Book a visit, or put the job on the visit in Calendar.',
  visitCancelled: (title: string) =>
    `“${title}” was cancelled, so its work order can’t change. Book a new visit on the job if the work is still going ahead.`,
  crewGone:
    'That crew isn’t there anymore. It may have been archived. Pick another, or make one in Contractor Operations → Settings → Crews.',
  crewNameNeeded: 'Name the crew, such as Install crew or Crew A.',
  crewNameTaken: (name: string) =>
    `You already have a crew called “${name}”. Give this one another name.`,
  tooManyCrews: (max: number) =>
    `A business has ${max} crews at most. Archive one you no longer use first.`,
  crewTooBigForVisit: (name: string, people: number, max: number) =>
    `${name} has ${people} people on the team, and a visit takes ${max} at most. Take someone out of the crew in Settings → Crews, or book a second visit.`,
  subGone:
    'That contact isn’t there anymore. They may have been deleted. Pick another contact, or add them in Contacts first.',
  subNotOnVisit: 'That contact isn’t a subcontractor on this visit. Add them to it first.',
  tooManySubs: (max: number) => `A visit has ${max} subcontractors at most. Take one off first.`,
  noSubs: 'This visit has no subcontractors to text. Add one first, or pick a crew that has some.',
  subNoMobile: (name: string) =>
    `${name} has no mobile number. Add one on their page in Contacts, then text them.`,
  itemGone:
    'That checklist item isn’t there anymore. Someone may have removed it. Refresh and try again.',
  tooManyItems: (max: number) =>
    `A checklist has ${max} items at most. Remove ones you don’t need first.`,
  photoNeeded: (label: string) => `“${label}” needs a photo. Add the photo, and it’s marked done.`,
  photoNotOnJob: (job: string) =>
    `That photo isn’t on “${job}”. Add it from the work order, or upload it to the job’s files first.`,
  notAPhoto: 'That file isn’t a picture. Add a photo, such as a JPG, PNG or HEIC.',
  jobNotReady: (job: string, left: readonly string[], maySkip: boolean) =>
    `“${job}” can’t be marked done yet: ${requiredItemsWords(left.length)} still left on its work orders (${namesWords(left)}). Finish ${left.length === 1 ? 'it' : 'them'} on the visit’s work order, ${
      maySkip
        ? 'or mark the job done anyway with a reason.'
        : 'or ask an owner or admin to mark the job done anyway.'
    }`,
  skipNotAllowed:
    'Only an owner or admin marks a job done with required items left. Ask one of them, or finish the items on the visit’s work order.',
} as const;
