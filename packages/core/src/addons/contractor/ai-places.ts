/**
 * Where Contractor Operations' pages are, for the Assistant (its manifest's `ai.places`): each the way there from the
 * side menu, in the screens' own words (./words.ts), what's on it and how to do what people ask about there. Its
 * pages pop out of its one row in the side menu. Said only in businesses it runs in. Browser-safe and pure.
 */
import type { AppPlace } from '../../assistant/places-map';
import { CONTRACTOR_PAGES as P, CONTRACTOR_WORDS as W, JOB_STATUS_WORDS as S } from './words';

const NAME = W.title;
const J = W.jobs;
const N = W.newJob;
const D = W.job;
const G = W.settings;

const statuses = Object.values(S).join(', ');

export const CONTRACTOR_PLACES: readonly AppPlace[] = [
  {
    label: P.jobs,
    what: 'every job and project, with where each one stands',
    where: [NAME, P.jobs],
    onScreen: [
      `${J.counts.open}, ${J.counts.late}, ${J.counts.onHold} and ${J.counts.doneThisMonth}`,
      `${J.newJob}, ${J.search}, ${J.filters.all}, ${J.filters.mine} and ${J.filters.late}, ${J.views.board} or ${J.views.list}, and ${J.showClosed}`,
      `The board: a column for each status (${statuses}); each job with its customer, property, % done, deadline (red when late), lead and next visit`,
    ],
    howTo: [
      `Start a job: ${NAME} → ${P.jobs} → ${J.newJob}. Pick ${N.kindHints.service.toLowerCase().replace(/\.$/, '')} (${W.newJob.kind}: Service call) or a project, its customer, its property (or a new address), its trade, lead, start and deadline`,
      `See what’s running late: ${NAME} → ${P.jobs} → ${J.filters.late}`,
      `See only my jobs: ${NAME} → ${P.jobs} → ${J.filters.mine} (jobs you lead or are on the team of)`,
    ],
    canChange: ['start a job or a project, and find jobs by name, customer or property'],
    path: '',
  },
  {
    label: 'A job',
    what: 'one job or project: its status, customer, property, phases, deadlines, team, visits and budget',
    where: [NAME, P.jobs],
    then: 'press the job',
    onScreen: [
      `At the top: its name, Service call or Project, ${D.status} (${statuses}; On hold and Cancelled ask why), % done and ${D.late} when past its deadline`,
      `${D.customer}, ${D.property}, ${D.trade}, ${D.startsOn}, ${D.dueOn}, ${D.lead} and ${D.team} (${D.addToTeam}, ${D.removeFromTeam}), with ${D.edit}`,
      `${D.details}`,
      `${D.phases.title}: each phase with its status, % done, ${D.phases.startsOn} and ${D.phases.dueOn}, ${D.phases.rename}, ${D.phases.moveUp}, ${D.phases.moveDown} and ${D.phases.remove}; ${D.phases.add}; on a service call ${D.phases.makeProject}`,
      `${D.visits}: the visits booked on it, and ${D.bookVisit}`,
      `${D.money.title} (only for people who may see job costs and profit): ${D.money.price}, ${D.money.labor}, ${D.money.materials}, ${D.money.other}, ${D.money.hours}, ${D.money.total}, ${D.money.profit} and ${D.money.margin}`,
      `${D.openRecord}: the job’s own record page, with its timeline, notes, files and tasks`,
    ],
    howTo: [
      `Move a job along: its page, then ${D.status}. It also moves on its own: a visit booked on it makes it Scheduled, and a tech pressing Started on one of its visits makes it In progress`,
      `Turn a service call into a project: its page, ${D.phases.title} → ${D.phases.makeProject} (it gets the starter phases), or ${D.phases.add}`,
      `Set how far along it is: a service call’s ${D.setPercent}; a project’s % done is the average of its phases’ (a done phase counts 100)`,
      `Set the budget: its page, ${D.money.title} → ${D.money.edit} (owners and admins, and anyone given “See job costs and profit”)`,
      `Book a visit on it: its page, ${D.visits} → ${D.bookVisit}`,
    ],
    canChange: [
      'change its status, details, dates, customer, property, lead and team, set a service call’s % done, make it a project, add, rename, reorder, move along and remove phases, and set its price and budget (with job-cost access)',
    ],
    notHere: [
      'estimates with costs and markup, crews, work orders and checklists, materials, time on jobs and job profit dashboards: coming in the next parts of Contractor Operations',
      'deleting a job: archive its record instead, and everything on it is kept',
    ],
    path: 'jobs/[jobId]',
  },
  {
    label: P.gear,
    what: 'the business’s trades, and the phases a new project starts with',
    where: [NAME, P.gear],
    onScreen: [
      `${G.trades} (Electrical, Plumbing, HVAC, Roofing, Remodeling and General contracting)`,
      `${G.phases}, with ${G.addPhase} and Start from a trade’s starter phases`,
    ],
    howTo: [
      `Pick your trades: ${NAME} → ${P.gear} → ${G.trades} (owners and admins)`,
      `Change the phases a new project starts with: ${NAME} → ${P.gear} → ${G.phases}`,
    ],
    canChange: ['pick the business’s trades and the phases a new project starts with'],
    path: 'settings',
  },
];

export const CONTRACTOR_LOOK_ALIKES: readonly string[] = [
  'Its Settings page is the add-on’s own (Contractor Operations → Settings), not the business’s Settings.',
  'A job here is Contractor Operations’ job (Contractor Operations → Jobs): the whole piece of work for a customer. The status on a visit’s sheet in the calendar (On the way, Started, Waiting on parts, Done) is that one visit’s, and moves the job along on its own.',
  'Jobs and Properties also have their own tabs under Contacts, since they’re records: their timelines, notes, files and tasks are there.',
];
