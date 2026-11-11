/**
 * Contractor Operations' words (docs/contractor.md): what its pages, its refusals and the AI say, in one place so the
 * web, the phone and the Assistant read the same. Browser-safe and pure.
 */
import { JOB_STATUS_WORDS as CORE_VISIT_STAGE_WORDS } from '../../schemas/job';
import { requiredItemsWords, type ItemKind } from './checklists';
import { marginWords, type CostKind, type OkReason } from './estimating';
import {
  amountWords,
  MATERIAL_COUNTS,
  materialWords,
  type MaterialCount,
  type MaterialCounts,
  type MaterialState,
} from './materials';
import type { ProfitGroup, ProfitPeriod } from './job-costing';
import type { JobKind, JobStatus, PhaseStatus } from './progress';
import { durationWords, MAX_FIXED_HOURS, MAX_RUNNING_HOURS, type TimeKind } from './time';

export const CONTRACTOR_NAME = 'Contractor Operations';

/** Its pages in the side menu, which pop out of its one row. */
export const CONTRACTOR_PAGES = {
  jobs: 'Jobs',
  dispatch: 'Dispatch',
  estimates: 'Estimates',
  costs: 'Item costs',
  profit: 'Profit',
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

// ---------- materials (the owner's decision 9) ----------

export const MATERIAL_STATE_WORDS: Readonly<Record<MaterialState, string>> = {
  to_order: 'To order',
  ordered: 'On order',
  here: 'Here',
  used: 'Used up',
};

export const MATERIAL_COUNT_WORDS: Readonly<Record<MaterialCount, string>> = {
  needed: 'Needed',
  ordered: 'Ordered',
  delivered: 'Delivered',
  used: 'Used',
  wasted: 'Wasted',
  returned: 'Returned',
};

export const MATERIAL_COUNT_HINTS: Readonly<Record<MaterialCount, string>> = {
  needed: 'How much the job needs.',
  ordered: 'How much has been ordered so far.',
  delivered: 'How much has arrived or been picked up.',
  used: 'How much went into the work.',
  wasted: 'How much was damaged, cut wrong or thrown out.',
  returned: 'How much went back to the supplier.',
};

/** "3 materials" · "1 material". */
export const materialsCountWords = (n: number) => `${n} ${n === 1 ? 'material' : 'materials'}`;

/** "1 material missing" · "3 materials missing": what a visit still doesn't have. */
export const materialsMissingWords = (n: number) => `${materialsCountWords(n)} missing`;

/**
 * What changed on a material, for the job's timeline: "12/2 wire: 20 ft delivered, 12 ft used". Empty when none
 * of its counts moved.
 */
export function materialChangeWords(
  name: string,
  unitLabel: string,
  before: MaterialCounts,
  after: MaterialCounts,
): string {
  const moved = MATERIAL_COUNTS.filter((k) => before[k] !== after[k]).map(
    (k) => `${amountWords(after[k], unitLabel)} ${MATERIAL_COUNT_WORDS[k].toLowerCase()}`,
  );
  return moved.length ? `${name}: ${moved.join(', ')}` : '';
}

/** "Never" · "2 hours before" · "The day before" · "3 days before" · "A week before". */
export function alertHoursWords(hours: number): string {
  if (hours <= 0) return 'Never';
  if (hours === 24) return 'The day before';
  if (hours === 168) return 'A week before';
  if (hours % 24 === 0) return `${hours / 24} days before`;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} before`;
}

/**
 * The alert before a visit that's still missing materials (decision 9): which job and visit, what's short, and
 * what to do about it. Never an amount of money.
 */
export function materialsAlertWords(a: {
  readonly job: string;
  /** "Fri, Sep 18 at 10:00 AM", in the business's time zone. */
  readonly when: string;
  readonly missing: readonly {
    readonly name: string;
    readonly unitLabel: string;
    readonly short: number;
  }[];
}): { title: string; detail: string } {
  const n = a.missing.length;
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  const short = namesWords(
    a.missing.map((m) => materialWords(m.short, m.unitLabel, clip(m.name, 60))),
    5,
  );
  return {
    title: clip(
      `“${clip(a.job, 80)}” is still missing ${materialsCountWords(n)} for ${a.when}`,
      200,
    ),
    detail: clip(
      `Still short: ${short}. Order ${n === 1 ? 'it' : 'them'} or pick ${n === 1 ? 'it' : 'them'} up before the crew leaves, then mark ${n === 1 ? 'it' : 'them'} delivered under Materials on the job.`,
      1000,
    ),
  };
}

export const TIME_KIND_WORDS: Readonly<Record<TimeKind, string>> = {
  travel: 'Travel',
  work: 'Work',
  break: 'Break',
};

/** "Travel 9:05 AM to 9:40 AM", for a timeline line or a Confirm card: a stretch said plainly. */
export const stretchWords = (kind: TimeKind, from: string, to: string | null) =>
  `${TIME_KIND_WORDS[kind].toLowerCase()} from ${from}${to ? ` to ${to}` : ', still running'}`;

/**
 * The alert when time was left running on a visit and stopped on its own (decision 10): whose, on which job, and
 * what to do. Never an amount of money.
 */
export function timeStoppedAlertWords(a: {
  readonly job: string;
  readonly names: readonly string[];
}): { title: string; detail: string } {
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  const who = namesWords(a.names.map((n) => clip(n, 60)));
  return {
    title: clip(`Time on “${clip(a.job, 80)}” ran ${MAX_RUNNING_HOURS} hours and was stopped`, 200),
    detail: clip(
      `${who ? `${who}’s time` : 'Someone’s time'} on a visit was still running after ${MAX_RUNNING_HOURS} hours, so it was stopped there. Open the job, and under Time press Fix to set when it really ended. If ${MAX_RUNNING_HOURS} hours is right, save it as it is.`,
      1000,
    ),
  };
}

export const PROFIT_PERIOD_WORDS: Readonly<Record<ProfitPeriod, string>> = {
  month: 'Done this month',
  last_month: 'Done last month',
  quarter: 'Done this quarter',
  year: 'Done this year',
  all: 'Done, all time',
  open: 'Open jobs',
};

export const PROFIT_GROUP_WORDS: Readonly<Record<ProfitGroup, string>> = {
  job: 'By job',
  customer: 'By customer',
  crew: 'By crew',
  trade: 'By service',
};

/** What the jobs with no customer, crew or trade are called on the profit page. */
export const PROFIT_NONE_WORDS: Readonly<Record<ProfitGroup, string>> = {
  job: 'Job',
  customer: 'No customer',
  crew: 'No crew',
  trade: 'No trade picked',
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
  time: {
    title: 'Time',
    visitTitle: 'Time on this visit',
    hint: 'Time starts when a visit is marked On the way (travel) or Started (work), and stops at Waiting on parts or Done.',
    none: 'No time yet. It starts when a visit is marked On the way or Started.',
    noneForVisit:
      'No time on this visit yet. It starts when the visit is marked On the way or Started.',
    work: 'Work',
    travel: 'Travel',
    breaks: 'Breaks',
    running: 'Running',
    since: (when: string) => `since ${when}`,
    onClock: (n: number) => `${n} on the clock now`,
    autoStopped: `Stopped on its own after ${MAX_RUNNING_HOURS} hours.`,
    autoStoppedFix: 'Press Fix to set when it really ended.',
    fixedBy: (by: string | null, reason: string) => `Fixed${by ? ` by ${by}` : ''}: ${reason}`,
    takeBreak: 'Take a break',
    backToWork: 'Back to work',
    onBreak: 'You’re on a break.',
    breakStarted: 'Your break has started. Press Back to work when you’re back.',
    breakEnded: 'You’re back on the clock.',
    menu: (name: string) => `More for ${name}’s time`,
    fix: 'Fix',
    fixTitle: (name: string) => `Fix ${name}’s time`,
    add: 'Add time',
    addTitle: 'Add time',
    addHint:
      'For time that wasn’t tracked: someone forgot to press Started, or worked without a visit.',
    remove: 'Remove',
    removeTitle: (name: string) => `Remove ${name}’s time?`,
    removeAsk:
      'It comes off the job’s hours and its labor cost. The job’s history keeps what it was and why you removed it.',
    person: 'Who',
    kind: 'What',
    visit: 'Visit',
    noVisit: 'No visit',
    started: 'Started',
    ended: 'Ended',
    reason: 'Why',
    reasonHint: 'Kept with the time, so the next person knows.',
    reasonPlaceholder: 'Forgot to press Done',
    save: 'Save',
    cancel: 'Cancel',
    fixed: 'Time fixed.',
    added: (name: string) => `Time added for ${name}.`,
    removed: (name: string) => `${name}’s time is removed.`,
    gone: 'Someone who’s left',
    truncated: (n: number) => `Showing the newest ${n} stretches.`,
    showAll: (n: number) => `Show all ${n}`,
    showFewer: 'Show fewer',
    needPerson: 'Pick whose time it is.',
    needStart: 'Set when it started.',
    needEnd: 'Set when it ended.',
    seeAll: 'See all the job’s time',
    onlyFixers: 'Only an owner or admin fixes time.',
  },
  costing: {
    title: 'Costs so far',
    hint: 'What this job was planned to cost, what it has cost so far, and where it’s heading.',
    planned: 'Planned',
    soFar: 'So far',
    heading: 'Heading for',
    labor: 'Labor',
    materials: 'Materials',
    other: 'Other costs',
    total: 'Total cost',
    hours: 'Labor hours',
    price: 'Price',
    profit: 'Profit',
    margin: 'Margin',
    notSet: 'Not set',
    over: (amount: string) => `Heading ${amount} over what was planned.`,
    underMargin: (margin: string, lowest: string) =>
      `Heading for a ${margin} margin, under your lowest of ${lowest}.`,
    onTrack: 'On track for what was planned.',
    finished: 'This job is finished, so what it’s heading for is what it cost.',
    noPrice: 'Set the job’s price under Budget and price to see its profit.',
    uncostedHours: (hours: string) =>
      `${hours} of time has no cost yet. Set what an hour costs in Settings → What an hour costs you.`,
    uncostedMaterials: (n: number) =>
      `${n} ${n === 1 ? 'material has' : 'materials have'} no cost yet. Set ${n === 1 ? 'it' : 'them'} under Materials.`,
    pace: 'Labor is paced by the job’s % done. Materials and other costs head for the larger of the plan and what’s spent.',
    byPerson: 'Labor by person',
    otherTitle: 'Other costs',
    otherHint: 'What else the job cost: a permit, a dump fee, a subcontractor’s bill.',
    otherNone: 'None yet.',
    otherAdd: 'Add a cost',
    otherAddTitle: 'Add a cost',
    otherName: 'What it was for',
    otherNamePlaceholder: 'Electrical permit',
    otherAmount: 'Amount',
    otherDay: 'Day',
    otherNote: 'Note',
    otherAdded: (name: string) => `${name} is added to the job’s costs.`,
    otherRemove: 'Remove',
    otherRemoveTitle: (name: string) => `Remove “${name}”?`,
    otherRemoveAsk: 'It comes off the job’s costs. Add it again if that was a mistake.',
    otherRemoved: (name: string) => `${name} is off the job’s costs.`,
    save: 'Save',
    cancel: 'Cancel',
  },
  laborCosts: {
    title: 'What an hour costs you',
    hint: 'What an hour of each person costs the business: their pay, taxes and whatever else you count. It turns the time tracked on a job into its labor cost. Only people who may see job costs see it.',
    cost: 'Cost per hour',
    notSet: 'Not set',
    fallback: (amount: string) =>
      `Someone with no cost of their own counts at ${amount} an hour, the labor cost in Estimating.`,
    noFallback:
      'Someone with no cost of their own counts for nothing until you set one here, or a labor cost per hour in Estimating.',
    fromNow: 'A change counts from now on. Time already tracked keeps what it cost then.',
    save: 'Save',
    saved: (name: string) => `${name}’s cost per hour is saved.`,
    cleared: (name: string) => `${name}’s cost per hour is taken off.`,
    readOnly: 'Only an owner or admin changes these.',
  },
  profit: {
    title: CONTRACTOR_PAGES.profit,
    lede: 'What your jobs made: the price, what each cost in labor, materials and everything else, and what’s left.',
    which: 'Which jobs',
    split: 'Split',
    name: 'Name',
    jobs: 'Jobs',
    price: 'Price',
    cost: 'Cost',
    profit: 'Profit',
    margin: 'Margin',
    hours: 'Labor hours',
    total: 'All of them',
    none: 'No jobs to count here yet. A job counts once it’s marked Done.',
    noneOpen: 'No open jobs right now.',
    openNote: 'Open jobs count at what they’re heading for, not what they’ve cost so far.',
    doneNote:
      'A done job counts at its price and what it really cost. Cancelled jobs aren’t counted.',
    crewNote: 'A job counts for the crew that was on most of its visits.',
    truncated: (n: number) =>
      `Showing the first ${n} jobs. Pick a shorter stretch of time to see them all.`,
  },
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
    materialsMissing: materialsMissingWords,
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
  materials: {
    title: 'Materials',
    hint: 'What this job needs, and how much of it is ordered, delivered and used.',
    visitTitle: 'Materials for this visit',
    visitHint:
      'What this visit needs from the job’s materials. Mark what arrives and what you use.',
    none: 'No materials listed yet.',
    noneForVisit: 'Nothing is listed for this visit.',
    add: 'Add a material',
    addTitle: 'Add a material',
    edit: 'Edit',
    editTitle: (name: string) => `Edit ${name}`,
    product: 'From your price list',
    productNone: 'Not on the price list',
    name: 'What it is',
    namePlaceholder: '12/2 wire',
    unit: 'Counted in',
    unitPlaceholder: 'each, ft, box',
    forVisit: 'Needed for',
    anyVisit: 'Any visit on this job',
    supplier: 'Supplier',
    supplierPlaceholder: 'Where it’s coming from',
    expectedOn: 'Expected on',
    note: 'Note',
    unitCost: 'Cost for one',
    unitCostHint: 'Only people who may see job costs see this.',
    noCost: 'No cost yet',
    costSaved: 'The cost is saved.',
    save: 'Save',
    cancel: 'Cancel',
    added: (name: string) => `${name} is on the job’s materials.`,
    saved: 'Saved.',
    remove: 'Remove',
    removeAsk: (name: string) =>
      `Take “${name}” off this job’s materials? What was counted for it goes too.`,
    removed: (name: string) => `“${name}” is off the materials.`,
    markOrdered: 'Mark ordered',
    markDelivered: 'Mark delivered',
    markUsed: 'Mark used',
    markedOrdered: (name: string) => `${name} is marked ordered.`,
    markedDelivered: (name: string) => `${name} is marked delivered.`,
    markedUsed: (name: string) => `${name} is marked used.`,
    of: (have: string, needed: string) => `${have} of ${needed} here`,
    short: (amount: string) => `${amount} short`,
    left: (amount: string) => `${amount} left`,
    expected: (day: string) => `Expected ${day}`,
    from: (supplier: string) => `From ${supplier}`,
    fromEstimate: 'From the estimate',
    thisVisit: 'This visit',
    missing: (n: number) =>
      n === 1 ? '1 material isn’t all here yet.' : `${n} materials aren’t all here yet.`,
    allHere: 'Everything listed is here.',
    closed: (status: string) =>
      `The job is ${status.toLowerCase()}, so its materials can’t be changed.`,
    planned: 'Everything needed',
    taken: 'Taken so far',
    uncosted: (n: number) =>
      n === 1
        ? '1 material has no cost yet, so these run low.'
        : `${n} materials have no cost yet, so these run low.`,
    menu: (name: string) => `More for ${name}`,
    seeAll: 'See all the job’s materials',
    counted: (words: string) => `Counted: ${words}.`,
  },
  // Notes from the field (part 6): what the crew typed, said or photographed on the job.
  notes: {
    title: 'Notes from the field',
    visitTitle: 'Notes on this visit',
    hint: 'What the crew typed, said or photographed on the job. A voice note’s words follow on their own.',
    none: 'No notes yet.',
    noneForVisit: 'No notes on this visit yet.',
    add: 'Add a note',
    addHint: 'For the crew and the office to read. Photos and voice notes come from the phone.',
    label: 'Note',
    placeholder: 'The shutoff valve is behind the water heater.',
    save: 'Save the note',
    cancel: 'Cancel',
    added: 'Note added.',
    remove: 'Remove',
    removeTitle: 'Remove this note?',
    removeAsk: 'It can’t be brought back. Its photos and its recording stay in the job’s files.',
    removed: 'The note is removed.',
    voice: 'Voice note',
    wordsWaiting: 'Its words are on their way.',
    wordsFailed: 'Its words couldn’t be made. Play the recording instead.',
    recording: 'Play the recording',
    recordingGone: 'The recording was deleted.',
    photo: (n: number) => `Photo ${n}`,
    gone: 'Someone who’s left',
    onVisit: (when: string) => `On the visit of ${when}`,
    truncated: (n: number) => `Showing the newest ${n} notes.`,
    showAll: (n: number) => `Show all ${n}`,
    showFewer: 'Show fewer',
    menu: 'More for this note',
  },
  materialsSettings: {
    title: 'Missing materials',
    hint: 'Before a visit, the job’s lead and the people going are told what still isn’t here.',
    when: 'Tell them',
    saveFirst: 'Press Save settings to keep it.',
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
  materialGone:
    'That material isn’t on the job anymore. Someone may have removed it. Refresh and try again.',
  materialNameNeeded:
    'Say what the material is. Type its name, or pick an item from your price list.',
  tooManyMaterials: (max: number) =>
    `A job has ${max} materials at most. Remove ones it no longer needs first.`,
  materialVisitElsewhere: (job: string) =>
    `That visit isn’t on “${job}”. Pick one of this job’s visits, or leave it for any visit.`,
  materialNoPriceList:
    'You can’t see the price list in this business, so you can’t pick from it. Type the material’s name instead.',
  materialCostNotAllowed:
    'Only people who may see job costs set what a material costs. Leave the cost out, or ask an owner or admin for “See job costs and profit” in Settings → Team.',
  timeGone:
    'That time isn’t on the job anymore. Someone may have removed it. Refresh and try again.',
  timeNotWorking: (name: string | null) =>
    `${name ? `${name} isn’t` : 'You’re not'} on the clock for this visit, so there’s no break to take. Work time starts when the visit is marked Started.`,
  timeNotOnBreak: (name: string | null) =>
    `${name ? `${name} isn’t` : 'You’re not'} on a break on this visit.`,
  timeSomeoneElse:
    'Only an owner or admin changes someone else’s time. Ask one of them, or ask for “Fix time on jobs” in Settings → Team.',
  timeEndsFirst: 'That time ends before it starts. Set the end after the start.',
  timeTooLong: `That’s more than ${MAX_FIXED_HOURS} hours in one stretch. Add each day’s time on its own.`,
  timeInFuture: 'That time hasn’t happened yet. Set an end that’s now or earlier.',
  timeStillRunning:
    'That time is still running. Set when it ended to fix it, or let the visit’s Done button stop it.',
  timeOverlaps: (name: string, other: string) =>
    `${name} already has ${other} then, and nobody is in two places. Change the times so they don’t overlap, or fix that one first.`,
  timeVisitElsewhere: (job: string) =>
    `That visit isn’t on “${job}”. Pick one of this job’s visits, or leave the visit out.`,
  noteGone: 'That note isn’t there anymore. Someone may have removed it. Refresh and try again.',
  noteVisitElsewhere: (job: string) =>
    `That visit isn’t on “${job}”. Pick one of this job’s visits, or leave the visit out.`,
  notePhotoNotOnJob: (job: string) =>
    `A photo on that note isn’t in the files of “${job}”. Add the photo to the job again, then save the note.`,
  noteNotAPhoto: 'One of those files isn’t a picture. Add photos, such as JPG, PNG or HEIC.',
  noteRecordingNotOnJob: (job: string) =>
    `That recording isn’t in the files of “${job}”. Record the note again, then save it.`,
  noteNotARecording: 'That file isn’t a recording. Record the note again, or type it instead.',
  noteSomeoneElse:
    'Only an owner or admin removes someone else’s note. Ask one of them, or ask for “Set up Contractor Operations” in Settings → Team.',
  otherCostGone:
    'That cost isn’t on the job anymore. Someone may have removed it. Refresh and try again.',
  tooManyOtherCosts: (max: number) =>
    `A job has ${max} other costs at most. Add smaller ones together as one.`,
} as const;

/** Why a fixed time can't be kept, in words: each says what to change. */
export const FIX_PROBLEM_WORDS = {
  ends_first: REFUSALS.timeEndsFirst,
  too_long: REFUSALS.timeTooLong,
  in_future: REFUSALS.timeInFuture,
} as const;

/** "2 h 15 min of work", for a timeline line. */
export const timeAmountWords = (kind: TimeKind, seconds: number) =>
  `${durationWords(seconds)} of ${kind === 'break' ? 'break' : TIME_KIND_WORDS[kind].toLowerCase()}`;
