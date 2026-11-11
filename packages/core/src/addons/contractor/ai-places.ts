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
const E = W.estimates;
const B = W.builder;
const C = W.costs;
const T = W.estimating;

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
      `${E.title}: the estimates written for it, each with its status, total and whether it’s ${E.waitingOk.toLowerCase()}, and ${E.add} (for people who may see job costs)`,
      `${D.openRecord}: the job’s own record page, with its timeline, notes, files and tasks`,
    ],
    howTo: [
      `Move a job along: its page, then ${D.status}. It also moves on its own: a visit booked on it makes it Scheduled, and a tech pressing Started on one of its visits makes it In progress`,
      `Turn a service call into a project: its page, ${D.phases.title} → ${D.phases.makeProject} (it gets the starter phases), or ${D.phases.add}`,
      `Set how far along it is: a service call’s ${D.setPercent}; a project’s % done is the average of its phases’ (a done phase counts 100)`,
      `Set the budget: its page, ${D.money.title} → ${D.money.edit} (owners and admins, and anyone given “See job costs and profit”)`,
      `Book a visit on it: its page, ${D.visits} → ${D.bookVisit}`,
      `Write an estimate for it: its page, ${E.title} → ${E.add}. When the customer approves it, the job’s price and budget are filled in from it on their own`,
    ],
    canChange: [
      'change its status, details, dates, customer, property, lead and team, set a service call’s % done, make it a project, add, rename, reorder, move along and remove phases, and set its price and budget (with job-cost access)',
    ],
    notHere: [
      'crews, work orders and checklists, materials, time on jobs and job profit dashboards: coming in the next parts of Contractor Operations',
      'deleting a job: archive its record instead, and everything on it is kept',
    ],
    path: 'jobs/[jobId]',
  },
  {
    label: P.estimates,
    what: 'the estimates written with their costs, and which are waiting for an owner’s or admin’s OK',
    where: [NAME, P.estimates],
    onScreen: [
      `${E.add}, and ${E.filters.all} or ${E.filters.waiting}`,
      `Each estimate: its number (or ${E.draft}), customer, status, what it’s for, its job, how many options it offers or the one they picked, its total, and ${E.waitingOk} or ${E.okGiven}`,
    ],
    howTo: [
      `See what’s waiting for an OK: ${NAME} → ${P.estimates} → ${E.filters.waiting}`,
      `Write an estimate with costs: ${NAME} → ${P.estimates} → ${E.add}, or from a job’s page, ${E.title} → ${E.add}`,
    ],
    canChange: ['start an estimate, and open one to change it, OK it or send it'],
    notHere: [
      'an estimate written in Money → Estimates isn’t listed here: it has no costs, and is changed and sent there',
    ],
    path: 'estimates',
  },
  {
    label: 'An estimate',
    what: 'the estimate builder: an estimate’s lines with what each costs, each option’s profit and margin, and its OK',
    where: [NAME, P.estimates],
    then: 'press the estimate, or New estimate',
    onScreen: [
      `${B.customer}, ${B.forJob} and ${B.titleField}`,
      `${B.lines}: each with what it is, ${B.kind} (Labor, Material or Other), ${B.quantity} (hours for labor), ${B.cost}, ${B.markup}, ${B.price}, sales tax, its amount and its profit; ${B.addLabor}, ${B.addLine}, Add from your price list, and a discount`,
      'Offer options (good, better, best): up to three, each with its own lines, and the customer picks one',
      `${B.costing.title}: ${B.costing.price}, ${B.costing.labor}, ${B.costing.materials}, ${B.costing.other}, ${B.costing.cost}, ${B.costing.profit} and ${B.costing.margin}, red when it’s under the lowest margin; with ${B.ok.ask} or, for owners and admins, ${B.ok.give}`,
      `Totals, Deposit, ${B.expires} and ${B.notes}`,
      `${B.save} and ${B.send}`,
    ],
    howTo: [
      `Add labor: ${B.addLabor} puts in a line by the hour at your labor price and cost (set in ${NAME} → ${P.gear} → ${T.title})`,
      `Price a line from its cost: type ${B.cost}, then ${B.markup} (or ${B.price}); a new line’s price starts at its cost plus your starting markup`,
      `Send one that’s under your lowest margin: an owner or admin opens it and presses ${B.ok.give}; anyone else presses ${B.ok.ask}, which tells them. The OK is for the estimate as it is: change it and it needs a fresh one`,
      `Offer good, better, best: in ${B.lines}, Offer options, then fill in each option’s lines`,
    ],
    canChange: [
      'write and change a draft estimate’s lines, costs, options, discount, deposit, notes and good-until date, ask for an OK, OK it (owners and admins) and send it',
    ],
    notHere: [
      'once it’s sent it can’t be changed: void it in Money → Estimates and write a new one',
      'recording the customer’s yes, the invoice and payments: on its page in Money → Estimates',
    ],
    path: 'estimates/[estimateId]',
  },
  {
    label: P.costs,
    what: 'what each item on the price list costs the business',
    where: [NAME, P.costs],
    onScreen: [
      `${C.search}`,
      `Each item: its name and price, ${C.kind} (Labor, Material or Other), ${C.cost}, its margin, and ${C.save}`,
    ],
    howTo: [
      `Set what an item costs you: ${NAME} → ${P.costs}, type its cost and press ${C.save}. Clear the box and save to take it off`,
      'Add or change what’s on the price list itself: Settings → Products',
    ],
    canChange: ['set or take off what a price list item costs, and how it’s costed'],
    path: 'costs',
  },
  {
    label: P.gear,
    what: 'the business’s trades, the phases a new project starts with, and how it estimates',
    where: [NAME, P.gear],
    onScreen: [
      `${G.trades} (Electrical, Plumbing, HVAC, Roofing, Remodeling and General contracting)`,
      `${G.phases}, with ${G.addPhase} and Start from a trade’s starter phases`,
      `${T.title}: ${T.minMargin}, ${T.markup}, ${T.laborRate} and ${T.laborCost}`,
    ],
    howTo: [
      `Pick your trades: ${NAME} → ${P.gear} → ${G.trades} (owners and admins)`,
      `Change the phases a new project starts with: ${NAME} → ${P.gear} → ${G.phases}`,
      `Change the lowest margin an estimate may go out at: ${NAME} → ${P.gear} → ${T.title} → ${T.minMargin} (owners and admins). It starts at 20%`,
    ],
    canChange: [
      'pick the business’s trades and the phases a new project starts with, and set the lowest margin, the starting markup and labor’s hourly price and cost',
    ],
    path: 'settings',
  },
];

export const CONTRACTOR_LOOK_ALIKES: readonly string[] = [
  'Its Settings page is the add-on’s own (Contractor Operations → Settings), not the business’s Settings.',
  'A job here is Contractor Operations’ job (Contractor Operations → Jobs): the whole piece of work for a customer. The status on a visit’s sheet in the calendar (On the way, Started, Waiting on parts, Done) is that one visit’s, and moves the job along on its own.',
  'Jobs and Properties also have their own tabs under Contacts, since they’re records: their timelines, notes, files and tasks are there.',
  'An estimate written in Contractor Operations → Estimates is also in Money → Estimates, like any other. While Contractor Operations runs it’s changed and sent from its builder, which checks its margin first; the customer’s yes, its invoice and its payments are in Money.',
  'Item costs (Contractor Operations → Item costs) are what things cost the business. Their prices to the customer are the price list, in Settings → Products.',
];
