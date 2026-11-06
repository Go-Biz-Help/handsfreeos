/**
 * Where the Real Estate Agent's pages are, for the Assistant (its manifest's `ai.places`): each the way there from the
 * side menu, a click at a time, in the screens' own words, then what is on it and how to do what people ask about
 * there, above all what only the person does (uploading photos and signed forms, a lockbox's code). Said only to
 * people in a business it runs in (the worker's per-business context), never in the fixed instructions.
 *
 * Every arrow is a click: the side menu's Real Estate Agent row, then its page (the manifest's `ui.nav`), then a tab on
 * that page (Deals' views, Coordinate's tabs, Deal settings' tabs). A deal's own pages open from the deal, which
 * `then` says in words. test/addons/realestate-places.test.ts holds them to those words. Browser-safe and pure.
 */
import type { AppPlace } from '../../assistant/places-map';
import { LOCKBOX_WORDS } from './lockbox-words';
import { KEEPING_WORDS } from './keeping-words';
import { RE_DEAL_WORDS } from './phone-words-deals';
import { STAGE_LABELS } from './states';

const NAME = 'Real Estate Agent';
const P = RE_DEAL_WORDS.page;
/** A deal's own page: open the deal from Deals, then what to press on it. */
const onDeal = (what: string) => `press the deal, then ${what}`;
const DEAL = 'deals/[dealId]';

/** Its pages, in the side menu's order, and the pages inside a deal. Paths are under the add-on's own (`/a/realestate`). */
export const REALESTATE_PLACES: readonly AppPlace[] = [
  {
    label: 'Deals',
    what: 'every deal, buying or selling, with how healthy each one is',
    where: [NAME, 'Deals'],
    onScreen: [
      'Start a listing and Start a buyer deal',
      'Healthy, Needs attention, At risk and Dates to confirm (its Confirm opens Needs attention)',
      'My deals, All deals, Needs attention, Closed and Archived; Find a deal or address; Agent, Side, Stage, Closing within and Waiting on',
      'Each deal: press it to open it',
    ],
    howTo: [
      'Start a deal: Real Estate Agent → Deals, then Start a buyer deal or Start a listing',
      'Find a deal that’s over: Real Estate Agent → Deals → Closed (or Archived)',
    ],
    canChange: ['start a deal, and find one by its name, address or person'],
    path: '',
  },
  {
    label: 'A deal',
    what: 'one deal: where it stands, its duties, dates, people and money',
    where: [NAME, 'Deals'],
    then: 'press the deal',
    onScreen: [
      'At the top: Key dates, Documents, Marketing (a listing), Plan a tour (a buyer), Move to the next stage or Close the deal, and More',
      'More: Record what happened…, Add a duty…, The offer was lost…, Terminate the contract…, Report changed wiring…; on a listing Withdraw the listing…, The listing expired…, Cancel the listing… and Back on the market; on a buyer deal The buyer stopped looking…; then Reopen the deal…, Apply the newest duty list…, Export the whole transaction…, Place a legal hold…, History, and Archive or Restore',
      `The stages in a row (${STAGE_LABELS.under_contract} and the rest): press a later one to move the deal there`,
      'Risks, then Duties (Open, Done or All), each opening its drawer with its proof, due date and history',
      'A buyer deal: What they want, Homes, Tours, Buyer agreement, Financing, Client’s to-do, Offers and CMA',
      'A listing: The listing (The home’s facts, Photos, Description, Price), Offers, Open houses, Showings, Marketing, Seller’s to-do, Matching, Seller’s estimate and CMAs',
      'Beside them: Key dates, Contingencies, Linked deal, People, Commission and Client updates',
      'On the phone, every page of the deal is a row on the deal itself',
    ],
    howTo: [
      'Move a deal on: its page, Move to the next stage at the top, or press the stage in the row',
      'Close a deal: its page, Close the deal (once it’s at closing)',
      'End a listing: its page, More, then Withdraw the listing…, The listing expired… or Cancel the listing…',
      'See everything that happened on it: its page, More, then History',
      'Keep a copy of the whole file: its page, More, then Export the whole transaction…',
    ],
    canChange: [
      'move it, close, end or reopen it, record what happened, add and work its duties, its people, property, commission and linked deal, and archive or restore it',
    ],
    notHere: ['deleting a deal: it’s archived instead, and everything on it is kept'],
    path: DEAL,
  },
  {
    label: P.dates,
    what: 'a deal’s key dates and terms: what each says, where it came from, and which still wait to be confirmed',
    where: [NAME, 'Deals'],
    then: onDeal('Key dates at the top'),
    onScreen: [
      'Each date and term with where it came from; Confirm N values; Add a date or term; a conflict’s Use it',
    ],
    howTo: ['Confirm what was read from the contract: Key dates, then Confirm N values'],
    canChange: ['add, change, confirm or reject a date or term, and settle a conflict'],
    path: `${DEAL}/dates`,
  },
  {
    label: P.documents,
    what: 'a deal’s documents: each version, who signs it, and what was read from it',
    where: [NAME, 'Deals'],
    then: onDeal('Documents at the top'),
    onScreen: ['Add a document; each document with its versions, signers and More'],
    howTo: [
      'Add a signed form or any file: Documents, then Add a document and pick the file (the person picks it on their own computer or phone)',
    ],
    canChange: [
      'file one already in the deal’s files, mark it signed, pick the one that counts, send it for signing or void it',
    ],
    path: `${DEAL}/documents`,
  },
  {
    label: P.history,
    what: 'everything that happened on a deal, newest first, in words',
    where: [NAME, 'Deals'],
    then: onDeal('More, then History'),
    onScreen: ['Each change: when, who, and what it was'],
    howTo: [],
    path: `${DEAL}/history`,
  },
  {
    label: P.contingencies,
    what: 'a deal’s contingencies and how each ended',
    where: [NAME, 'Deals'],
    then: onDeal('Contingencies'),
    onScreen: ['Each contingency with its end date; Record how it ended; Add a contingency'],
    howTo: [],
    canChange: ['add one and record how it ended'],
    path: `${DEAL}/contingencies`,
  },
  {
    label: P.contract,
    what: 'a contract as it was read: its values, what moves, and what waits for a person',
    where: [NAME, 'Deals'],
    then: onDeal('the contract’s line under its risks, or the document on Documents'),
    onScreen: [
      'The document beside its values; What moves; the values to look at, each It’s right or Not right',
    ],
    howTo: [],
    canChange: ['confirm what was read, or say a value is wrong'],
    path: `${DEAL}/contract/[readId]`,
  },
  {
    label: 'A client update',
    what: 'one update to the deal’s clients, drafted for the agent to read and send',
    where: [NAME, 'Deals'],
    then: onDeal('one under Client updates'),
    onScreen: ['The words, their checks, and send or discard'],
    howTo: [],
    canChange: ['draft, change, send or discard it'],
    path: `${DEAL}/updates/[draftId]`,
  },
  // A buyer's deal.
  {
    label: P.buyer,
    what: 'what a buyer wants: their search and what they said, to confirm',
    where: [NAME, 'Deals'],
    then: onDeal('What they want'),
    onScreen: [
      'Their search; what they said to remember, each Confirm or Reject; Remember something they said',
    ],
    howTo: [],
    canChange: ['change their search, remember what they said, and confirm or reject it'],
    path: `${DEAL}/buyer`,
  },
  {
    label: P.homes,
    what: 'the homes a buyer is looking at, and how each fits',
    where: [NAME, 'Deals'],
    then: onDeal('Homes (All, or Add a home)'),
    onScreen: [
      'Add a home; each home with its fit, the client’s reactions and its tours; Their search or See them',
    ],
    howTo: [],
    canChange: ['add a home, look it up on the MLS, confirm its facts and change where it stands'],
    path: `${DEAL}/homes`,
  },
  {
    label: P.matches,
    what: 'homes from the MLS that fit a buyer’s search, for the agent to send or skip',
    where: [NAME, 'Deals'],
    then: onDeal('Homes, then See them (or Their search)'),
    onScreen: ['The search and whether it’s on; New, Sent and Skipped'],
    howTo: [],
    canChange: ['turn the search on, and send or skip a match'],
    path: `${DEAL}/matches`,
  },
  {
    label: P.tours,
    what: 'a buyer’s tours: their homes in order, on the calendar',
    where: [NAME, 'Deals'],
    then: onDeal('Plan a tour at the top, or Tours'),
    onScreen: ['Plan a tour; each tour with its stops, visits and feedback'],
    howTo: [],
    canChange: [
      'plan, move or cancel a tour, set its stops and record visits; with Approve exceptions, let one through without a signed agreement',
    ],
    path: `${DEAL}/tours`,
  },
  {
    label: P.offers,
    what: 'a deal’s offers and counters: sent for a buyer, or received on a listing, side by side',
    where: [NAME, 'Deals'],
    then: onDeal('Offers on its card (on a listing, Side by side or Open)'),
    onScreen: [
      'Each offer with its terms, counters and deadlines; on a listing, the offers side by side with the seller’s net',
    ],
    howTo: [],
    canChange: [
      'record an offer, a counter or an answer, attach its document, withdraw it and share it',
    ],
    path: `${DEAL}/offers`,
  },
  {
    label: 'An offer',
    what: 'one offer: its terms, counters and deadlines',
    where: [NAME, 'Deals'],
    then: onDeal('Offers, then press the offer'),
    onScreen: ['Its terms, each counter, its answer and its documents'],
    howTo: [],
    path: `${DEAL}/offers/[offerId]`,
  },
  {
    label: 'A CMA',
    what: 'a comparative market analysis: the home, its comps and the summary',
    where: [NAME, 'Deals'],
    then: onDeal('one under Offers and CMA (or CMAs on a listing)'),
    onScreen: ['The home; Comps from the MLS; Summary; finish or reopen it, and share it'],
    howTo: [],
    canChange: [
      'start one, add, change or remove comps, write the summary, finish, reopen and share it',
    ],
    path: `${DEAL}/cma/[cmaId]`,
  },
  {
    label: P.financing,
    what: 'a buyer’s loan, step by step, and their lender',
    where: [NAME, 'Deals'],
    then: onDeal('Open on Financing'),
    onScreen: ['Lender; each step with its date, done or not'],
    howTo: [],
    canChange: ['set the lender, and mark a step done or not done'],
    path: `${DEAL}/financing`,
  },
  {
    label: P.inspections,
    what: 'a deal’s inspections, their findings and the repair request',
    where: [NAME, 'Deals'],
    then: onDeal(
      'Inspections among its rows on the phone (the web has no button for it: give the person its link)',
    ),
    onScreen: ['Each inspection, its findings, and the repair request with the answer'],
    howTo: [],
    canChange: [
      'add an inspection and its findings, send the repair request and record the answer',
    ],
    path: `${DEAL}/inspections`,
  },
  {
    label: P.clientTasks,
    what: 'what a deal’s client (a buyer or a seller) has to do in their portal',
    where: [NAME, 'Deals'],
    then: onDeal(`All on ${P.clientTasks} (${P.sellerTasks} on a listing)`),
    onScreen: [
      'Add a task for them; each task, Mark it done for them or cancel it; invite them to the portal',
    ],
    howTo: [],
    canChange: ['add, cancel or mark a task done for them'],
    path: `${DEAL}/client-tasks`,
  },
  // A listing.
  {
    label: P.facts,
    what: 'a listing’s facts: what the MLS, the seller and the old listing say, for the agent to confirm',
    where: [NAME, 'Deals'],
    then: onDeal('The home’s facts on The listing'),
    onScreen: [
      'Each fact with where it came from; the old listing’s words to paste; the seller’s questionnaire',
    ],
    howTo: [],
    canChange: ['paste the old listing, ask the seller’s questionnaire and confirm the facts'],
    path: `${DEAL}/facts`,
  },
  {
    label: P.photos,
    what: 'a listing’s photos, in order, with which the public page shows',
    where: [NAME, 'Deals'],
    then: onDeal('Photos on The listing'),
    onScreen: [
      'Upload photos and Add from the deal’s files',
      'Each photo: its caption, On the public page, Move earlier, Move later and Take it off the listing',
    ],
    howTo: [
      'Add photos: Photos, then Upload photos and pick them (the person picks them on their own computer or phone)',
    ],
    canChange: [
      'add one from the deal’s files, put them in order, caption them, show or hide them, and take one off',
    ],
    path: `${DEAL}/photos`,
  },
  {
    label: P.description,
    what: 'a listing’s description: the one in use and the one being worked on, with its checks',
    where: [NAME, 'Deals'],
    then: onDeal('Description on The listing'),
    onScreen: [
      'The description in use; the one being worked on, its fair housing checks, and send it to the seller to sign off',
    ],
    howTo: [],
    canChange: [
      'draft it, change it, keep flagged words with a reason, send it to the seller, and (with Approve exceptions) use it without the portal with a reason',
    ],
    path: `${DEAL}/description`,
  },
  {
    label: P.price,
    what: 'a listing’s price and the changes the seller signs off',
    where: [NAME, 'Deals'],
    then: onDeal('Price on The listing'),
    onScreen: [
      'The price now; a change waiting on the seller; Signed on paper? Use it with a reason',
    ],
    howTo: [],
    canChange: [
      'propose a change, withdraw it, and (with Approve exceptions) use one signed on paper',
    ],
    path: `${DEAL}/price`,
  },
  {
    label: P.marketing,
    what: 'a listing’s marketing: live on the MLS, its public page, emails and texts to contacts, and social posts',
    where: [NAME, 'Deals'],
    then: onDeal('Marketing at the top'),
    onScreen: [
      'Mark it live on the MLS, or Print the flyer once it is',
      'Public page: its link and Copy link, Publish (or Put it back up) and Take it down',
      'Email or text to your contacts: tags or stages, and Start a campaign',
      'Social posts',
    ],
    howTo: ['Print the flyer: Marketing, then Print the flyer'],
    canChange: [
      'mark it live, put the page up or down, start an email or text to contacts (it waits in Campaigns for approval) and draft posts',
    ],
    path: `${DEAL}/marketing`,
  },
  {
    label: 'Flyer',
    what: 'a listing’s printable flyer, with the QR code to its page',
    where: [NAME, 'Deals'],
    then: onDeal('Marketing, then Print the flyer'),
    onScreen: ['The flyer as it prints'],
    howTo: [],
    path: `${DEAL}/flyer`,
  },
  {
    label: P.showings,
    what: 'a listing’s showings, buyers’ feedback and its lockboxes',
    where: [NAME, 'Deals'],
    then: onDeal('Open on Showings'),
    onScreen: [
      'Copy the request link; Add a showing; each showing, It’s right or its answer; What buyers said',
      `${LOCKBOX_WORDS.title}: ${LOCKBOX_WORDS.add}, ${LOCKBOX_WORDS.edit} and ${LOCKBOX_WORDS.remove}`,
    ],
    howTo: [
      `Set or change a lockbox’s code: Showings, then ${LOCKBOX_WORDS.add} (or ${LOCKBOX_WORDS.edit} beside it) and type the code there; it’s locked as it’s saved, and it never goes through the Assistant`,
    ],
    canChange: [
      'add a showing and answer it, record and share feedback, and add, describe or remove a lockbox without its code',
    ],
    notHere: [
      'reading or sending a lockbox’s code: only the access email to the confirmed agent carries it',
    ],
    path: `${DEAL}/showings`,
  },
  {
    label: P.openHouses,
    what: 'a listing’s open houses and their sign-in sheets',
    where: [NAME, 'Deals'],
    then: onDeal('Open on Open houses'),
    onScreen: [
      'Plan an open house; each one with Print the sign-in sheet (its QR code) and Cancel it',
    ],
    howTo: ['Print the sign-in sheet: Open houses, then Print the sign-in sheet on the open house'],
    canChange: ['plan, cancel and follow up on one'],
    path: `${DEAL}/open-houses`,
  },
  {
    label: P.netSheet,
    what: 'the seller’s estimate: what they’d take home at the list price and at each offer',
    where: [NAME, 'Deals'],
    then: onDeal('Open on Seller’s estimate'),
    onScreen: ['The costs; At the list price; each offer’s net'],
    howTo: [],
    canChange: ['change the costs, and share the comparison'],
    path: `${DEAL}/net-sheet`,
  },
  {
    label: 'My duties',
    what: 'the duties a person answers for, across their deals',
    where: [NAME, 'My duties'],
    onScreen: ['Mine or Everyone’s; each duty with its deal, its due date and its drawer'],
    howTo: [],
    canChange: ['work a duty: finish it, add proof, assign it, set its date, waive or cancel it'],
    path: 'duties',
  },
  {
    label: 'Coordinate',
    what: 'the coordinator’s views across every deal',
    where: [NAME, 'Coordinate'],
    onScreen: [
      'Today (At risk, Overdue, Due today), Exceptions (Read values to confirm, Dates or terms that disagree, Contingencies past their end, Nobody accountable, Due soon without proof, Blocked past its review time), Waiting room and Workload',
    ],
    howTo: [],
    path: 'coordinate',
  },
  {
    label: 'Vendors',
    what: 'the inspectors, lenders and others the business’s deals use',
    where: [NAME, 'Vendors'],
    onScreen: ['Add a vendor; each vendor with Approve, Change and Archive'],
    howTo: [],
    canChange: ['add, change, approve or archive a vendor, and pick one for a duty'],
    path: 'vendors',
  },
  {
    label: 'Deal settings',
    what: 'how the business’s deals run (owners and admins)',
    where: [NAME, 'Deal settings'],
    onScreen: [
      `Duty list, Alerts & dates (with the calendar tours go on), Connections (the MLS feed and e-signing), ${KEEPING_WORDS.tab}, Versions and Support access`,
    ],
    howTo: [
      'Pick the calendar tours go on: Real Estate Agent → Deal settings → Alerts & dates',
      'Connect the MLS feed or e-signing: Real Estate Agent → Deal settings → Connections, then sign in there (the person does it)',
      'Change and publish the duty list: Real Estate Agent → Deal settings → Duty list',
    ],
    canChange: ['change the duty list and publish it, and the alerts and dates'],
    path: 'settings',
  },
];

/**
 * The same word somewhere else in HandsFreeOS, said while the Real Estate Agent runs, so "settings" or "duties" goes to
 * the right page.
 */
export const REALESTATE_LOOK_ALIKES: readonly string[] = [
  'Settings: the Real Estate Agent’s own are Real Estate Agent → Deal settings; the business’s calendars and booking site are core Settings → Calendars.',
  'Duties: a deal’s duties are on the deal and on Real Estate Agent → My duties; Tasks in the side menu are the business’s own to-do list.',
  'Campaigns: an email or text about a listing, started from its Marketing, waits in Campaigns for someone to approve it.',
];
