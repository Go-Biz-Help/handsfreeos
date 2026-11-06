/**
 * Where AI Sales Coach's tabs are, for the Assistant (its manifest's `ai.places`): each the way there from the side
 * menu, a click at a time, in the screens' own words (./words.ts), then what is on it and how to do what people ask
 * about there, above all what only the person does (deleting a coached call, linking Zoom and starting its stream).
 * Said only to people in a business it runs in (the worker's per-business context), never in the fixed instructions.
 *
 * Its page is one row in the side menu with four tabs, kept in the address as `?view=` (`view`): Live call is the bare
 * page, so it's also what a view the tabs don't have (the Zoom panel's) is named. A call's write-up keeps its id at
 * `&call=`, and a rep's trends theirs at `&rep=` (`queryIds`). test/addons/salescoach-places.test.ts holds them to
 * those words. Browser-safe and pure.
 */
import type { AppPlace } from '../../assistant/places-map';
import { SALESCOACH_WORDS as W } from './words';

const NAME = W.title;
const T = W.tabs;
const L = W.live;
const C = W.calls;
const R = W.trends;
const P = W.playbooks;
const B = W.builder;
const N = W.learn;
const Z = W.zoom;
const cardKinds = Object.values(W.cardKinds).join(', ');
const channels = Object.values(C.channels).join(', ');
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Its tabs, in the page's order. Paths are under the add-on's own (`/a/salescoach`); the tab is the address's view. */
export const SALESCOACH_PLACES: readonly AppPlace[] = [
  {
    label: T.live,
    what: 'the call the coach is listening to now: where it is in the script, and the coach’s cards',
    where: [NAME, T.live],
    onScreen: [
      `The status (${L.listening}, ${L.writing.replace(/…$/, '')}, ${L.stopped} or ${L.ended}) and the customer’s name`,
      `${L.stage}: the stage of the script the call is in, n of m (a script whose steps name stages), and ${L.step}: the step, n of m`,
      `The cards, newest first (${cardKinds}), each with the words to say, ${L.how} (how to say it) and, on the newest, ${L.heard}; ${L.dismiss} on each`,
      `${L.stop}; once stopped, while the call goes on, ${L.resume}; after the call, ${L.seeCall}`,
      `With no call, where the coach shows: calls in the web app show it above the call bar; on a cell, keep this page open, or open ${NAME} in the phone app`,
      `With no playbook yet, the coach has only what HandsFreeOS knows about the business, until an owner or admin writes one under ${NAME} → ${T.playbooks}`,
    ],
    howTo: [
      `Stop the coach on a call: ${L.stop}, on ${T.live} or on the cards above the call bar; ${L.resume} turns it back on while the call goes on (only the person on the call does either)`,
      `See the coach on a call on a cell: ${NAME} → ${T.live} on the web, or ${NAME} at the top of More in the phone app`,
      `Coach a Zoom meeting: in the meeting, open HandsFreeOS from Zoom’s Apps button, pick who the call is with (or ${Z.noCustomer}), then ${Z.start}. ${Z.notice} On a second screen, ${NAME} → ${T.live} shows the same cards`,
      `Link Zoom: the first time, the panel in Zoom asks to ${Z.connect}; the person signs in to Zoom there, then presses ${Z.connectedTryAgain}`,
      `When Zoom didn’t start listening: the host lets apps listen to the meeting in Zoom’s settings, under Realtime media streams, then ${Z.start} again; an old Zoom needs updating to its newest version first`,
    ],
    canChange: [
      'stop the coach on your own call, start it again while the call goes on, and put a card away',
    ],
    path: '',
  },
  {
    label: T.calls,
    what: 'the coached calls and written conversations, newest first, each with its write-up and score',
    where: [NAME, T.calls],
    view: 'calls',
    onScreen: [
      `Each call or conversation: the customer (or ${C.noCustomer}), where it happened (${channels}), its language, the rep (for people who see everyone’s), the playbook, when, a badge when it was won, and its ${C.score} (or ${C.live}, ${C.writing}, ${C.stopped} or ${C.failed})`,
      `Press one for its write-up: the ${C.score}; n of m stages or script steps, n of m objections answered, and You talked n% of the time; ${C.stagesTitle}, each ${C.stageDone} or ${C.stageSkipped}, with a warning when the offer came before their problem; ${C.summary}; ${C.notes}; ${C.promises} (each is a task); ${C.followUp} (copy it into a text or email; nothing was sent); ${C.objections}, each ${C.answered} or ${C.notAnswered}; ${C.tips}; ${C.said}; ${C.openConversation}`,
      `${C.delete} (the bin, on a row or a write-up), for owners and whoever has Delete coached calls`,
      'With nothing yet, when calls show: once someone on the team who’s coached takes one, and texts, chats and emails once a conversation they answered goes quiet',
    ],
    howTo: [
      `Read a call’s write-up: ${NAME} → ${T.calls}, then press the call`,
      `Send the follow-up: copy it from the write-up into a text or an email; nothing is sent on its own`,
      `Delete a coached call: ${NAME} → ${T.calls}, press the call, ${C.delete}, then ${C.deleteConfirm}. Owners do it, and whoever an owner gives Delete coached calls in Settings → Permissions; it goes for good, with what was said, the cards and the write-up, while its notes on the customer’s timeline and its tasks stay; not while the coach is still on the call or writing it up. The person does it: the Assistant never deletes one`,
    ],
    canChange: [
      'read any call’s write-up and what was said, and send its follow-up as a text or an email on a card',
    ],
    path: '',
    queryIds: { call: 'coached call' },
  },
  {
    label: T.trends,
    what: 'how coached calls are going over the last weeks against the same number of weeks before: your own, or each rep’s and the team’s for people who see everyone’s',
    where: [NAME, T.trends],
    view: 'trends',
    onScreen: [
      `${R.period(4)}, ${R.period(12)} or ${R.period(26)}`,
      `${R.team} (or ${R.mine}): ${R.coached}, ${R.score}, ${R.talk} (35 to 60% of the talking is the sweet spot), ${R.objections}, ${R.steps} and ${R.wins} (${lower(R.winsAbout).replace(/\.$/, '')}), each against the weeks before`,
      `${R.weekly}, with ${R.asTable}`,
      `Each rep (for people who see everyone’s): ${R.coached.toLowerCase()}, average score, talk time, objections answered, script steps done and wins; press a rep for their weeks`,
      `${R.skipped}: from calls with a playbook, each step and how often it was skipped, once a step has been on at least 3 calls`,
    ],
    howTo: [
      `See one rep’s weeks: ${NAME} → ${T.trends}, then press the rep`,
      'On the phone, Trends opens on the web',
    ],
    path: '',
    queryIds: { rep: 'user' },
  },
  {
    label: T.playbooks,
    what: 'the scripts, objection answers and talking points the coach says from, and what it learned from wins',
    where: [NAME, T.playbooks],
    view: 'playbooks',
    onScreen: [
      `${N.title} (owners and admins): ${N.lookAgain}; each suggestion (${N.better} or ${N.added}) with the objection, how often it won, ${N.now} and ${N.suggested}, then ${N.use} or ${N.dismiss}`,
      `${B.open}, ${P.draft} and ${P.add} (owners and admins)`,
      `Each playbook: its name, ${P.kind}, ${P.usual} or ${P.archived}, and n steps · n objections · n talking points; Edit, ${P.makeUsual}, and ${P.archive} or ${P.restore} (owners and admins); for everyone else, its steps and objection answers to read`,
      `The editor: ${P.name}, ${P.kind}, ${P.steps} (${P.stage}, ${P.step}, ${P.say}, ${P.tip}), ${P.objections} (${P.objection}, ${P.answer}), ${P.points} (${P.topic}, ${P.fact}), then ${P.save}; with the builder’s scripts, Script n of m and ${P.skip}`,
    ],
    howTo: [
      `Which playbook a call uses: the one for how the call started (a booked call, a new lead, an older lead or a cold call), else the usual one; the first one saved is the usual one until ${P.makeUsual} picks another`,
      `Build scripts that sell by asking: ${B.open}, answer its questions (or keep what it read from HandsFreeOS), tick the kinds of call under ${B.kinds}, then ${B.go}; each opens in the editor to check, then ${P.save}`,
      `Turn your own script into a playbook: ${P.draft}, paste it, pick what ${P.draftKind}, then ${P.draftGo}; check it in the editor, then ${P.save}`,
      `Use what the coach learned from wins: ${N.title} at the top of ${T.playbooks}, then ${N.use} on a suggestion; suggestions show once an objection has come up in at least 3 wins`,
    ],
    canChange: [
      'write a playbook or change one part of it, make one the usual one, archive or bring one back, draft one from what the business says or from its own script, and use or put away what the coach learned (each on a card)',
    ],
    path: '',
  },
];

/** What AI Sales Coach shows on core's pages and the phone, said outright so the Assistant names the right place. */
export const SALESCOACH_LOOK_ALIKES: readonly string[] = [
  `The coach’s cards also show above the call bar during a call in the web app and beside a HandsFreeOS video call, and the newest over the video in the phone app; ${L.dismiss}, ${L.stop} and ${L.resume} work the same there.`,
  `${W.suggest.title}: once a customer writes, AI Sales Coach suggests replies above the reply box in a conversation (Inbox, then press the conversation); pressing one puts it in the reply box to change and send, and ${W.suggest.hide} (the X) hides them on that screen only. They are on the web, not in the phone app’s message box.`,
  'A coached call’s summary and notes also go on the customer’s timeline, and each thing the rep promised is a task for them.',
  `On the phone, ${NAME} is its own row at the top of More and opens ${T.live}; ${T.calls}, ${T.trends} and ${T.playbooks} open on the web.`,
];
