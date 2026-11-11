/**
 * Where Contractor Operations' pages are, for the Assistant (its manifest's `ai.places`): each the way there from the
 * side menu, in the screens' own words (./words.ts), what's on it and how to do what people ask about there. Its
 * pages pop out of its one row in the side menu. Said only in businesses it runs in. Browser-safe and pure.
 */
import type { AppPlace } from '../../assistant/places-map';
import { DEFAULT_MATERIALS_ALERT_HOURS, MATERIALS_ALERT_HOURS } from './materials';
import { CONTRACTOR_PHONE_WORDS as PH } from './phone-words';
import { PHONE_DAYS } from './progress';
import { MAX_RUNNING_HOURS } from './time';
import {
  alertHoursWords,
  CONTRACTOR_PAGES as P,
  CONTRACTOR_WORDS as W,
  JOB_STATUS_WORDS as S,
  MATERIAL_COUNT_WORDS,
  MATERIAL_STATE_WORDS,
  PROFIT_GROUP_WORDS,
  PROFIT_PERIOD_WORDS,
} from './words';

const NAME = W.title;
const J = W.jobs;
const N = W.newJob;
const D = W.job;
const G = W.settings;
const E = W.estimates;
const B = W.builder;
const C = W.costs;
const T = W.estimating;
const O = W.workOrder;
const X = W.dispatch;
const R = W.crews;
const K = W.checklistSettings;
const M = W.materials;
const A = W.materialsSettings;
const H = W.time;
const Q = W.costing;
const L = W.laborCosts;
const F = W.profit;
const V = W.notes;

const statuses = Object.values(S).join(', ');
const materialCounts = Object.values(MATERIAL_COUNT_WORDS).join(', ');
const materialStates = Object.values(MATERIAL_STATE_WORDS).join(', ');
const profitPeriods = Object.values(PROFIT_PERIOD_WORDS).join(', ');
const profitSplits = Object.values(PROFIT_GROUP_WORDS).join(', ');

export const CONTRACTOR_PLACES: readonly AppPlace[] = [
  {
    label: P.jobs,
    what: 'every job and project, with where each one stands',
    where: [NAME, P.jobs],
    onScreen: [
      `${J.counts.open}, ${J.counts.late}, ${J.counts.onHold} and ${J.counts.doneThisMonth}`,
      `${J.newJob}, ${J.search}, ${J.filters.all}, ${J.filters.mine} and ${J.filters.late}, ${J.views.board} or ${J.views.list}, and ${J.showClosed}`,
      `The board: a column for each status (${statuses}); each job with its customer, property, % done, deadline (red when late), lead and next visit`,
      `On the phone it’s More → ${PH.more.jobs}: ${PH.jobs.today} (each opens its work order), then ${PH.jobs.filters.mine}, ${PH.jobs.filters.all} and ${PH.jobs.filters.late}, a search, and ${PH.jobs.closedToo}. It’s kept on the phone, so it opens with no signal`,
    ],
    howTo: [
      `Start a job: ${NAME} → ${P.jobs} → ${J.newJob}. Pick ${N.kindHints.service.toLowerCase().replace(/\.$/, '')} (${W.newJob.kind}: Service call) or a project, its customer, its property (or a new address), its trade, lead, start and deadline`,
      `See what’s running late: ${NAME} → ${P.jobs} → ${J.filters.late}`,
      `See only my jobs: ${NAME} → ${P.jobs} → ${J.filters.mine} (jobs you lead or are on the team of)`,
      `Work a job from the phone with no signal: More → ${PH.more.jobs}, then the job or one of today’s visits. Ticking the checklist and adding its photos, counting materials, a break, notes, a phase’s status and a service call’s % done all work with no signal: they’re kept on the phone and send on their own. Changing a job’s status and removing a note need signal`,
    ],
    canChange: ['start a job or a project, and find jobs by name, customer or property'],
    notHere: [
      `on the phone: starting a job, dispatch, estimates, costs, profit and settings. ${PH.more.onTheWeb}`,
      `a job done or cancelled more than ${PHONE_DAYS} days ago isn’t kept on phones: it’s on the web`,
    ],
    path: '',
  },
  {
    label: 'A job',
    what: 'one job or project: its status, customer, property, phases, deadlines, team, visits, materials, time, notes from the field, costs so far and budget',
    where: [NAME, P.jobs],
    then: 'press the job',
    onScreen: [
      `At the top: its name, Service call or Project, ${D.status} (${statuses}; On hold and Cancelled ask why), % done and ${D.late} when past its deadline`,
      `${D.customer}, ${D.property}, ${D.trade}, ${D.startsOn}, ${D.dueOn}, ${D.lead} and ${D.team} (${D.addToTeam}, ${D.removeFromTeam}), with ${D.edit}`,
      `${D.details}`,
      `${D.phases.title}: each phase with its status, % done, ${D.phases.startsOn} and ${D.phases.dueOn}, ${D.phases.rename}, ${D.phases.moveUp}, ${D.phases.moveDown} and ${D.phases.remove}; ${D.phases.add}; on a service call ${D.phases.makeProject}`,
      `${D.visits}: the visits booked on it, each with where it stands (Scheduled, On the way, Started, Done), its crew, its checklist’s progress and how many materials it’s still missing, and ${D.bookVisit}; pressing a visit opens its work order`,
      `${M.title}: what the job needs, each with where it stands (${materialStates}), how much of what’s needed is here, what’s short, its supplier, the day it’s expected and the visit it’s for; one button moves it along (${M.markOrdered}, ${M.markDelivered}, ${M.markUsed}); ${M.add}, and ${M.edit} or ${M.remove} under each one’s menu. People who may see job costs also see what one costs, ${M.planned.toLowerCase()} and ${M.taken.toLowerCase()}`,
      `${H.title}: the hours tracked on the job (${H.work}, ${H.travel} and ${H.breaks}, and how many people are on the clock now), then each stretch with whose it is, what it was, from when to when and how long; one that was ${H.autoStopped.toLowerCase().replace(/\.$/, '')} says so, and a fixed one says who fixed it and why. ${H.takeBreak} or ${H.backToWork} while you’re on the clock; for people who may fix time, ${H.add}, and ${H.fix} or ${H.remove} under each one’s menu`,
      `${V.title}: what the crew typed, said or photographed on the job, the newest first, each with who left it, when and the visit it was taken on; a voice note shows its words once they’ve come, with ${V.recording}, and each photo opens among the job’s files; ${V.add}, and ${V.remove} under a note’s menu (your own, or anyone’s for owners and admins)`,
      `${Q.title} (only for people who may see job costs and profit): ${Q.labor}, ${Q.materials}, ${Q.other}, ${Q.total}, ${Q.hours}, ${Q.price}, ${Q.profit} and ${Q.margin}, each ${Q.planned}, ${Q.soFar} and ${Q.heading}; a warning when it’s heading over its plan or under the lowest margin, or when time or materials have no cost yet; ${Q.byPerson}; and ${Q.otherTitle} with ${Q.otherAdd} and ${Q.otherRemove}`,
      `${D.money.title} (only for people who may see job costs and profit): ${D.money.price}, ${D.money.labor}, ${D.money.materials}, ${D.money.other}, ${D.money.hours}, ${D.money.total}, ${D.money.profit} and ${D.money.margin}`,
      `${E.title}: the estimates written for it, each with its status, total and whether it’s ${E.waitingOk.toLowerCase()}, and ${E.add} (for people who may see job costs)`,
      `${D.openRecord}: the job’s own record page, with its timeline, notes, files and tasks`,
      `On the phone (More → ${PH.more.jobs} → the job): its status with ${PH.job.changeStatus}, ${PH.job.about.toLowerCase()} with ${PH.job.callShort} for its customer, ${PH.job.progress} (press a phase to move it along, or set a service call’s % done), its visits, ${M.title}, ${H.title} and ${V.title}. No price, budget or cost is on the phone`,
    ],
    howTo: [
      `Move a job along: its page, then ${D.status}. It also moves on its own: a visit booked on it makes it Scheduled, and a tech pressing Started on one of its visits makes it In progress`,
      `Mark a job done: its page, ${D.status} → Done. It waits while a required checklist item or photo is left on one of its work orders: “${D.notReady.title}” lists them by visit. Finish them on the work order, or an owner or admin types why under “${D.notReady.skipTitle}” and presses ${D.notReady.skip}`,
      `Turn a service call into a project: its page, ${D.phases.title} → ${D.phases.makeProject} (it gets the starter phases), or ${D.phases.add}`,
      `Set how far along it is: a service call’s ${D.setPercent}; a project’s % done is the average of its phases’ (a done phase counts 100)`,
      `Set the budget: its page, ${D.money.title} → ${D.money.edit} (owners and admins, and anyone given “See job costs and profit”)`,
      `Book a visit on it: its page, ${D.visits} → ${D.bookVisit}. Its work order opens next, to put a crew on it`,
      `Write an estimate for it: its page, ${E.title} → ${E.add}. When the customer approves it, the job’s price and budget are filled in from it on their own, and its material lines go onto ${M.title}`,
      `Add a material: its page, ${M.title} → ${M.add}. Pick it from your price list or type what it is, how much is needed, and (if it’s for one visit) ${M.forVisit}`,
      `Say a material was ordered, arrived or was used: its page, ${M.title}, then ${M.markOrdered}, ${M.markDelivered} or ${M.markUsed}; for part of it, or what was wasted or returned, the material’s menu → ${M.edit} (${materialCounts})`,
      `See what a visit is still missing: the job’s ${M.title} shows what’s short in red, and each visit under ${D.visits} says how many it’s missing. The job’s lead and the people going are also told before the visit (set when in ${NAME} → ${P.gear} → ${A.title})`,
      `See the hours on a job: its page, ${H.title}. Time starts on its own when a visit is marked On the way (travel) or Started (work), for everyone on the visit, and stops at Waiting on parts or Done`,
      `Take a break: on the job’s page or the visit’s work order, ${H.title} → ${H.takeBreak}, then ${H.backToWork}. Only your own time pauses`,
      `Fix someone’s time: the job’s page, ${H.title}, the stretch’s menu → ${H.fix}. Set when it started and ended and say why (owners and admins, and anyone given “Fix time on jobs”). Time left running ${MAX_RUNNING_HOURS} hours is stopped on its own and waits for this`,
      `Add time nobody tracked: the job’s page, ${H.title} → ${H.add}. Pick who, what it was, from when to when, and say why`,
      `See whether a job is making money: its page, ${Q.title}. ${Q.soFar} is what it has really cost; ${Q.heading} is where it ends up if it goes on as it has (labor is paced by the job’s % done)`,
      `Add a permit, a fee or a subcontractor’s bill to a job’s costs: its page, ${Q.title} → ${Q.otherTitle} → ${Q.otherAdd}`,
      `Read what a tech said about a job: its page, ${V.title}. A voice note’s words come a moment after the recording reaches HandsFreeOS; until then it says “${V.wordsWaiting}”`,
      `Leave a note on a job: on the web, its page → ${V.title} → ${V.add}. On the phone, the job or the visit’s work order → ${V.title} → ${PH.notes.type}, ${PH.notes.photo} or ${PH.notes.voice}; with no signal it’s kept on the phone and sends on its own`,
      `Say how much of a material was used from the phone: the job or the visit’s work order → ${M.title} → press the material, type what was used, wasted or sent back just now, then ${PH.materials.add}. It adds to what’s counted already`,
    ],
    canChange: [
      'change its status, details, dates, customer, property, lead and team, set a service call’s % done, make it a project, add, rename, reorder, move along and remove phases, add, change and remove materials and say how much is ordered, delivered, used, wasted and returned, take a break or come back from one, fix, add and remove time (with “Fix time on jobs”), leave a typed note and take one off, add to how much of a material was used, wasted or sent back, and set its price and budget and what a material costs and add and remove its other costs (with job-cost access)',
    ],
    notHere: [
      'ordering from a supplier, and stock in a warehouse or a van: the materials list records what a job needs and what’s happened; it places no order (supplier orders and stock come later)',
      'starting or stopping work time by hand: it follows the visit’s buttons (On the way, Started, Waiting on parts, Done), on the visit’s sheet in Calendar or on the crew’s phones. Someone who may fix time adds or fixes it afterwards',
      'paying people: the time here is for what jobs cost, and nothing here runs payroll',
      'deleting a job: archive its record instead, and everything on it is kept',
      'recording a voice note or taking a photo: that’s done on the phone. The Assistant leaves typed notes, and puts a photo or a recording on a note only when it’s already in the job’s files',
      'changing what a note says: take it off and leave a new one',
    ],
    path: 'jobs/[jobId]',
  },
  {
    label: 'A work order',
    what: 'one visit on a job: what to do and bring, the materials it needs, the time on it, its crew, the people and subcontractors going, its checklist, and the notes left on it from the field',
    where: [NAME, P.jobs],
    then: `press the job, then the visit under ${D.visits} (or press a visit on ${P.dispatch})`,
    onScreen: [
      `At the top: when the visit is, where it stands (Scheduled, On the way, Started, Waiting on parts, Done), its checklist’s progress, and ${O.openInCalendar}`,
      `${O.job}: the job, its customer, its property and the ${O.workToDo.toLowerCase()}`,
      `${O.instructions} and ${O.bring}, with ${O.edit}`,
      `${M.visitTitle}: the job’s materials this visit needs (the ones for it, and the ones for any visit), each with how much is here and what’s short, ${M.markDelivered} or ${M.markUsed}, ${M.add}, and ${M.seeAll}`,
      `${H.visitTitle}: the hours tracked on this visit and each stretch of them, with ${H.takeBreak} or ${H.backToWork} while you’re on the clock, and ${H.seeAll}`,
      `${O.checklist}: each item a box to tick or a photo to add, some marked ${O.required}; ${O.addPhoto}, ${O.seePhoto}, ${O.makeRequired} or ${O.makeOptional}, ${O.removeItem}, and ${O.addItem} (Checkbox or Photo, ${O.required} or not)`,
      `${V.visitTitle}: what the crew typed, said or photographed on this visit, with ${V.add} and ${V.remove}`,
      `${O.whoGoes}: ${O.crew} (pick one of your crews, or ${O.noCrew}) and the ${O.people.toLowerCase()} members on the visit`,
      `${O.subs}: each with whether they were texted and whether their work is done; ${O.addSub}, ${O.tellSubs}, ${O.subWorkDone} and ${O.removeSub.toLowerCase()}`,
      `On the phone (More → ${PH.more.jobs} → a visit under ${PH.jobs.today}, or the ${PH.visit.panel} row on the visit’s page in Calendar): when and where it is with ${PH.visit.directions}, the visit’s On my way, Started, Waiting on parts and Done buttons, the instructions and what to bring, who’s going, the checklist (tick a box, or ${PH.visit.takePhoto.toLowerCase()} for a photo item), ${M.visitTitle}, ${H.visitTitle} with the break button, and ${V.visitTitle}. It all works with no signal`,
    ],
    howTo: [
      `Put a crew on a visit: its work order → ${O.whoGoes} → ${O.crew}. Everyone on the team in the crew is booked on the visit, and its subcontractors are added. If someone isn’t free then it says so, with ${O.crewAnyway}`,
      `Text a subcontractor the job’s details: its work order → ${O.subs} → ${O.tellOne} (or ${O.tellSubs} for all of them). They get the job, the address, the time, the instructions and what to bring, from the business’s number`,
      `Mark a subcontractor’s work done: its work order → ${O.subs} → tick ${O.subWorkDone}. They don’t sign in, so the office marks it`,
      `Add a required photo: its work order → ${O.checklist} → type what it’s of, pick Photo, tick ${O.required}, then ${O.addItem}`,
      `Change who on the team is going without a crew: ${O.openInCalendar}, then Who’s going on the visit’s sheet`,
      `Say what was used on a visit: its work order → ${M.visitTitle} → ${M.markUsed}, or the material’s menu → ${M.edit} to type how much was used or wasted`,
      `Take a break on a visit: its work order → ${H.visitTitle} → ${H.takeBreak}, then ${H.backToWork} when you’re back. It’s there once the visit is Started and you’re on the clock`,
      `Work a visit’s checklist with no signal: on the phone, its work order → ${O.checklist}. A tick, a photo, a count, a break or a note made with no signal waits on the phone (“${PH.kept.waitingToSend}”) and sends on its own; it counts from the moment it was made, even if the office closed the job meanwhile`,
      `Leave a note on a visit: its work order → ${V.visitTitle} → ${V.add} (on the phone: ${PH.notes.type}, ${PH.notes.photo} or ${PH.notes.voice})`,
    ],
    canChange: [
      'write its instructions and what to bring, put a crew on it, add, text, mark done and take off subcontractors, add, tick, change and remove checklist items (a photo item is ticked by adding its photo, on the screen), add materials for the visit and say what was delivered and used, take a break or come back from one, and leave a typed note on the visit or take one off',
    ],
    notHere: [
      'where the visit stands (On the way, Started, Done) is set by its crew on the visit’s sheet in Calendar or on their phones',
      'moving or cancelling the visit: on its sheet in Calendar',
      'adding a photo is done on the screen: the Assistant can tick a photo item only with a picture already in the job’s files',
    ],
    path: 'visits/[appointmentId]',
  },
  {
    label: P.dispatch,
    what: 'a day’s visits on jobs by who’s on them, the ones nobody is on yet, and jobs with nothing booked',
    where: [NAME, P.dispatch],
    onScreen: [
      `The day, with ${X.previous}, ${X.next}, a day to pick and ${X.today}`,
      `${X.nobody}: the day’s visits with no one on the team on them`,
      'A column for each person on a visit that day: each visit with its time, where it stands (Scheduled, On the way, Started, Done), its job, customer and property, its crew, its subcontractors, its checklist’s progress and, in red, how many materials it’s still missing',
      `${X.needsVisit}: open jobs with nothing booked from now on, each with ${X.openJob}`,
    ],
    howTo: [
      `See what each tech is doing today: ${NAME} → ${P.dispatch}`,
      `Find visits nobody is on: ${NAME} → ${P.dispatch} → ${X.nobody}; press one to open its work order and pick a crew`,
      `Find jobs that still need a visit: ${NAME} → ${P.dispatch} → ${X.needsVisit}, then ${X.openJob} → ${D.bookVisit}`,
      `See which of the day’s visits are missing materials: ${NAME} → ${P.dispatch}; a visit that’s short says so in red. Press it to see what, under ${M.visitTitle}`,
    ],
    canChange: [
      'nothing on this page itself: a visit opens its work order, and a job opens its page',
    ],
    notHere: [
      'dragging visits between people or times: move a visit in Calendar, or put a crew on it from its work order',
    ],
    path: 'dispatch',
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
    label: P.profit,
    what: 'what the jobs made: price, cost, profit and margin, by job, customer, crew or service (only for people who may see job costs and profit)',
    where: [NAME, P.profit],
    onScreen: [
      `${F.which} (${profitPeriods}) and ${F.split} (${profitSplits})`,
      `${F.price}, ${F.cost}, ${F.profit} and ${F.margin} for all of them together`,
      `A row for each job, customer, crew or service: ${F.jobs}, ${F.price}, ${F.cost}, ${F.profit}, ${F.margin} and ${F.hours}, the most profit first; a job’s row opens the job`,
    ],
    howTo: [
      `See which jobs made the most this month: ${NAME} → ${P.profit} (it opens on ${PROFIT_PERIOD_WORDS.month}, ${PROFIT_GROUP_WORDS.job.toLowerCase()})`,
      `See which crew or which kind of work makes the most: ${NAME} → ${P.profit} → ${F.split} → ${PROFIT_GROUP_WORDS.crew} or ${PROFIT_GROUP_WORDS.trade}. A job counts for the crew that was on most of its visits`,
      `See where the jobs still running are heading: ${NAME} → ${P.profit} → ${F.which} → ${PROFIT_PERIOD_WORDS.open}. They count at what they’re heading for, not what they’ve cost so far`,
      `See why one job’s number is what it is: press the job, then ${Q.title} on its page`,
    ],
    canChange: [
      'nothing on this page itself: a job’s price is set under Budget and price on its page, and its costs come from its time, materials and other costs',
    ],
    notHere: [
      'what was invoiced and paid: that’s in Money. This page counts a job’s price against what the job cost',
      'cancelled jobs, and jobs whose record is archived, aren’t counted',
    ],
    path: 'profit',
  },
  {
    label: P.gear,
    what: 'the business’s trades, its crews, the phases a new project and the checklist a new visit start with, when missing materials are told, how it estimates, and what an hour of each person costs',
    where: [NAME, P.gear],
    onScreen: [
      `${G.trades} (Electrical, Plumbing, HVAC, Roofing, Remodeling and General contracting)`,
      `${G.phases}, with ${G.addPhase} and Start from a trade’s starter phases`,
      `${K.title}: each item a box or a photo, required or not, with ${K.add} and Start from a trade’s starter checklist`,
      `${A.title}: ${A.when} (${MATERIALS_ALERT_HOURS.map(alertHoursWords).join(', ')})`,
      `${R.title}: each crew with who’s in it, ${R.add}, ${R.edit}, ${R.archive} and ${R.showArchived}`,
      `${T.title}: ${T.minMargin}, ${T.markup}, ${T.laborRate} and ${T.laborCost}`,
      `${L.title} (only for people who may see job costs and profit): each person on the team with their ${L.cost.toLowerCase()} and ${L.save}`,
    ],
    howTo: [
      `Pick your trades: ${NAME} → ${P.gear} → ${G.trades} (owners and admins)`,
      `Change the phases a new project starts with: ${NAME} → ${P.gear} → ${G.phases}`,
      `Change the checklist a new visit starts with: ${NAME} → ${P.gear} → ${K.title}, then ${G.save}. Visits already booked keep the checklist they have`,
      `Change when people are told a visit is missing materials, or turn it off: ${NAME} → ${P.gear} → ${A.title} → ${A.when}, then ${G.save}. It starts at ${alertHoursWords(DEFAULT_MATERIALS_ALERT_HOURS).toLowerCase()}; ${alertHoursWords(0)} turns it off`,
      `Make a crew: ${NAME} → ${P.gear} → ${R.title} → ${R.add}. Name it, tick its ${R.people.toLowerCase()}, and add its ${R.subs.toLowerCase()} from Contacts (for a company, the person you deal with there)`,
      `Change the lowest margin an estimate may go out at: ${NAME} → ${P.gear} → ${T.title} → ${T.minMargin} (owners and admins). It starts at 20%`,
      `Set what an hour of someone costs you: ${NAME} → ${P.gear} → ${L.title}, type their ${L.cost.toLowerCase()} and press ${L.save} (owners and admins). It counts for time tracked from then on; time already tracked keeps what it cost. Someone with none counts at the ${T.laborCost.toLowerCase()} under ${T.title}`,
    ],
    canChange: [
      'pick the business’s trades, the phases a new project starts with and the checklist a new visit starts with, set how long before a visit its missing materials are told, make, change, archive and bring back crews, set the lowest margin, the starting markup and labor’s hourly price and cost, and set what an hour of each person costs',
    ],
    path: 'settings',
  },
];

export const CONTRACTOR_LOOK_ALIKES: readonly string[] = [
  'Its Settings page is the add-on’s own (Contractor Operations → Settings), not the business’s Settings.',
  'A job here is Contractor Operations’ job (Contractor Operations → Jobs): the whole piece of work for a customer. The status on a visit’s sheet in the calendar (On the way, Started, Waiting on parts, Done) is that one visit’s, and moves the job along on its own.',
  'Jobs and Properties also have their own tabs under Contacts, since they’re records: their timelines, notes, files and tasks are there.',
  'A work order (Contractor Operations → a job → a visit) is the add-on’s page for a visit: its instructions, crew, subcontractors and checklist. The visit itself is an appointment in Calendar, where it’s moved, cancelled and its crew presses On the way, Started and Done. Pressing Done on a visit doesn’t check the checklist; marking the job Done does.',
  'A crew is a named group set up in Contractor Operations → Settings. A job’s team (on the job’s page) is who works that one job; a calendar’s team (Settings → Calendars) is who can be booked on it.',
  'Dispatch (Contractor Operations → Dispatch) shows only visits booked on jobs. Calendar shows every appointment.',
  'An estimate written in Contractor Operations → Estimates is also in Money → Estimates, like any other. While Contractor Operations runs it’s changed and sent from its builder, which checks its margin first; the customer’s yes, its invoice and its payments are in Money.',
  'Item costs (Contractor Operations → Item costs) are what things cost the business. Their prices to the customer are the price list, in Settings → Products.',
  'A job’s Materials (on the job’s page) is the list of what that one job needs and what’s been ordered, delivered and used. It isn’t the price list (Settings → Products), and it isn’t “What to bring” on a work order, which is a note for the crew.',
  'Marking a material ordered records that someone ordered it. HandsFreeOS places no order with a supplier.',
  'Costs so far (on a job’s page) is what the job has really cost: time tracked, materials taken and its other costs. Budget and price, on the same page, is the plan it’s set against. An estimate’s costing is what was quoted.',
  'Time on a job comes from the visit’s buttons (On the way, Started, Waiting on parts, Done) and the Break button. It’s for what jobs cost, not payroll: nothing in Contractor Operations pays anyone.',
  'What an hour costs you (Contractor Operations → Settings) is each person’s cost to the business, and turns tracked time into labor cost. Labor’s price and cost per hour under Estimating are what a new labor line on an estimate starts at; that cost also counts for anyone with no cost of their own.',
  'Profit (Contractor Operations → Profit) sets each job’s price against what the job cost. What was invoiced and paid is in Money.',
  'Notes from the field (on a job’s page and a visit’s work order) are what the crew typed, said or photographed, mostly from their phones. The Notes on the job’s record page under Contacts are the business’s ordinary notes; a note from the field also shows as a line on the job’s timeline there.',
  'On the phone, Contractor Operations is the Jobs row in More: Jobs, a job and a visit’s work order, all kept on the phone so they work with no signal. A visit on a job also has a Work order row on its page in Calendar.',
];
