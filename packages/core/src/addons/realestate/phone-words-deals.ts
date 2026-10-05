/**
 * Real Estate's words on the phone for Deals, My duties, Coordinate, Vendors, a deal and its duty, dates,
 * contingencies, the contract as read, documents, history and a client update (round six, boards 76–81 and 93's first
 * panels). The words more than one group says are in `phone-words.ts`; the web's own words for the same things come
 * from the modules they're imported from (rule-words, contingencies, keeping-words…). Browser-safe.
 */
import { fmtMonthDay } from '../../calendar/when';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
/** "Three", for a heading; 10 and up as digits. */
export const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/** Deals (board 76). */
export const RE_DEALS_WORDS = {
  title: 'Deals',
  subtitle: (open: number, business: string) => `${open} open · ${business}`,
  everySubtitle: (business: string) => `Every deal · ${business}`,
  mine: (n: number) => `Mine · ${n}`,
  every: (n: number) => `Every deal · ${n}`,
  whose: 'Whose deals',
  chips: {
    open: 'Open',
    buyers: 'Buyers',
    listings: 'Listings',
    atRisk: (n: number) => (n > 0 ? `At risk · ${n}` : 'At risk'),
    closingThisMonth: 'Closing this month',
  },
  sorts: { needs: 'Needs you', closing: 'Closing', newest: 'Newest' },
  ended: { closed: 'Closed', ended: 'Ended', archived: 'Archived', all: 'Every deal' },
  filterTitle: 'Show deals',
  side: 'Side',
  sides: { both: 'Both', buyer: 'Buyers', listing: 'Listings' },
  doing: 'How they’re doing',
  health: { red: 'At risk', yellow: 'Something due soon', green: 'On track' },
  stage: 'Stage',
  anyStage: 'Any stage',
  agent: 'Agent',
  anyone: 'Anyone',
  sortBy: 'Sort by',
  show: (n: number) => (n === 1 ? 'Show 1 deal' : `Show ${n} deals`),
  clear: 'Clear',
  search: 'Find a deal or address',
  searchLabel: 'Find a deal',
  filtersLabel: 'Filters',
  someonesDeal: (name: string) => `${name}’s deal`,
  /** "3 things could stop this closing", or "2 things need attention" when none of them is red. */
  couldStop: (reds: number, all: number) =>
    reds > 0
      ? `${plural(reds, 'thing', 'things')} could stop this closing`
      : all > 0
        ? `${plural(all, 'thing needs', 'things need')} attention`
        : null,
  closing: (day: string) => `closing ${day}`,
  datesToConfirm: (n: number) => plural(n, 'date to confirm', 'dates to confirm'),
  onTrack: 'On track',
  waitingOn: (who: string) => `Waiting on ${who}`,
  emptyMine: 'You’re not on any open deals yet.',
  emptyEvery: 'No open deals yet.',
  emptyMatch: 'No deal matches that.',
  emptyBody:
    'Start a buyer deal or a listing on the web. Its duties and deadlines are added for you.',
  noMatchBody: 'Clear the filters to see every deal again.',
} as const;

/** My duties (board 77). */
export const RE_DUTIES_WORDS = {
  title: 'My duties',
  subtitle: (open: number, late: number) =>
    late > 0 ? `${open} open · ${late} late` : `${open} open`,
  mine: (n: number) => `Mine · ${n}`,
  watching: (n: number) => `I’m watching · ${n}`,
  team: 'Team',
  whose: 'Whose duties',
  groups: {
    late: 'Late',
    today: 'Today',
    week: 'This week',
    later: 'Later',
    none: 'No deadline',
    waiting: 'Waiting on someone',
    blocked: 'Blocked',
  },
  yesterday: 'Yesterday',
  today: 'Today',
  open: (title: string) => `Open ${title}`,
  emptyMine: 'Nothing to do. New duties show here as your deals move.',
  emptyWatching: 'Nothing on your deals is waiting on someone else.',
  emptyTeam: 'Nothing open on the team’s deals.',
} as const;

/** Coordinate (board 77): Today, Exceptions, the Waiting room and Team workload. */
export const RE_COORDINATE_WORDS = {
  title: 'Coordinate',
  subtitle: (business: string, person: string) => `${business} · ${person}`,
  tabs: {
    today: (n: number) => `Today · ${n}`,
    exceptions: (n: number) => `Exceptions · ${n}`,
    waiting: (n: number) => `Waiting · ${n}`,
    workload: 'Workload',
  },
  open: 'Open',
  acknowledge: 'Acknowledge',
  acknowledged: 'Acknowledged. Its alerts stop climbing.',
  escalated: 'Escalated',
  dueToday: 'Due today',
  nobody: 'Nobody accountable',
  todayEmpty: 'Nothing at risk, overdue or due today. New work shows here as deals move.',
  exceptionsEmpty:
    'Nothing disagrees, is missing or has passed. Anything that does shows here until it’s fixed.',
  waitingEmpty: 'Nothing is waiting on anyone outside, and nothing is blocked.',
  workloadEmpty: 'Nobody on the team has deals yet.',
  fixNeedsSignal: 'Fixing it needs signal',
  readsTitle: 'Values to confirm',
  readsLine: (title: string, n: number) =>
    `${title}: ${plural(n, 'value waits', 'values wait')} for a person.`,
  readScan: 'Read from a scan, so check each value closely against its page.',
  readText: 'Read from the PDF’s text. Nothing counts until a person confirms it.',
  checkThem: 'Check them',
  disagreeTitle: 'Dates don’t agree',
  linkedTitle: 'Linked deal moved',
  contingencyTitle: 'Contingency passed',
  contingencyLine: (label: string, ended: string) =>
    `The ${label} contingency ended ${ended} and nothing is recorded. Record whether it was satisfied, waived or expired.`,
  recordIt: 'Record it',
  nobodyTitle: 'Nobody accountable',
  nobodyLine: (title: string) => `${title}: nobody answers for it. Pick who has it now.`,
  noProofTitle: 'Due soon without proof',
  noProofLine: (title: string, due: string) => `${title}: ${due}. Its proof isn’t attached yet.`,
  blockedTitle: 'Blocked past its review',
  blockedLine: (blocker: string, owner: string | null, review: string) =>
    `Blocked: ${blocker}${owner ? `, ${owner} to clear it` : ''}; it was to be looked at again ${review}.`,
  partial:
    'Contract reads, contingencies and proof on deals you’re not on are checked with signal, on the web.',
  waitingSince: (who: string, since: string) => `Waiting on ${who} since ${since}.`,
  blockedSince: (blocker: string, since: string) => `Blocked: ${blocker}, since ${since}.`,
  chase: (day: string) => `Chase ${day}`,
  review: (day: string) => `Review ${day}`,
  byPerson: 'Open duties by person',
  personLine: (open: number, late: number, soon: number) =>
    `${open} open · ${late} late · ${soon} due in 2 days`,
} as const;

/** Vendors (board 89's third panel). */
export const RE_VENDORS_WORDS = {
  title: 'Vendors',
  approved: 'Approved',
  waiting: 'Waiting for approval',
  archived: 'Archived',
  add: 'Add a vendor',
  addTitle: 'Add a vendor',
  addAbout:
    'They go in Contacts as a company. An owner or admin approves them before duties offer them.',
  addAboutManager: 'They go in Contacts as a company. Approve them so duties offer them.',
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  services: 'What they do',
  areas: 'Where they work',
  areasHint: 'Towns or ZIP codes, with commas between them. Leave it empty for anywhere.',
  disclosure: 'Anything to disclose',
  disclosureHint: 'Owned in part by someone here, a referral fee… Said wherever they’re shown.',
  save: 'Add them',
  added: (name: string) => `${name} added. It sends when there’s signal.`,
  approve: 'Approve',
  approvedDone: (name: string) => `${name} is approved. Duties offer them now.`,
  anywhere: 'Anywhere',
  footer: 'Adding works with no signal; approving one needs an owner or admin with signal.',
  footerOthers: 'An owner or admin approves a vendor before duties offer them.',
  empty:
    'No vendors yet. Add the inspectors, contractors and lenders your deals use; each is a company in Contacts.',
  usesPartial: 'How often deals used each counts the deals on this phone; the rest with signal.',
  call: (name: string) => `Call ${name}`,
  pickService: 'Pick at least one thing they do.',
  needName: 'Enter the vendor’s name.',
} as const;

/** A deal (board 78) and its More sheet. */
export const RE_DEAL_WORDS = {
  buyerDeal: 'Buyer deal',
  listing: 'Listing',
  closing: (day: string) => `closing ${day}`,
  inStage: (stage: string, days: number) =>
    days < 1 ? `${stage} today` : `${stage} ${plural(days, 'day', 'days')}`,
  call: 'Call',
  text: 'Text',
  note: 'Note',
  noPhone: 'There’s no number for the client on this deal. Add one on their customer page.',
  noThread: 'No text thread with them yet. Start one from the Inbox.',
  noClient: 'This deal has no client yet. Add them on the web.',
  noteTitle: 'A note on this deal',
  notePlaceholder: 'What happened, what was said…',
  noteSave: 'Add the note',
  noteAdded: 'Note added. It sends when there’s signal.',
  tabs: {
    overview: 'Overview',
    duties: (n: number) => `Duties · ${n}`,
    dates: 'Dates',
    documents: 'Documents',
    people: 'People',
    history: 'History',
  },
  couldStop: (reds: number) =>
    `${numberWord(reds)} ${reds === 1 ? 'thing' : 'things'} could stop this closing`,
  needAttention: (n: number) =>
    `${numberWord(n)} ${n === 1 ? 'thing needs' : 'things need'} attention`,
  nothingInTheWay: 'Nothing stands in the way',
  nothingInTheWayLine: 'Every duty that matters is on time, and its dates are confirmed.',
  owner: (name: string) => `Owner: ${name}`,
  next: (words: string) => `Next: ${words}`,
  showAll: (n: number) => `Show all ${n}`,
  showFewer: 'Show fewer',
  nextTitle: 'Next',
  keyDates: 'Key dates',
  people: 'People',
  pages: 'This deal’s pages',
  theListing: 'The listing',
  dutiesOpen: (n: number) => `Open · ${n}`,
  dutiesDone: (n: number) => `Done · ${n}`,
  noDutiesOpen: 'Nothing open. Every duty so far is finished.',
  stillNeeds: (what: string) => `Still needs ${what}`,
  proof: (what: string) => `Proof: ${what}`,
  waitingFor: 'Waiting for dates',
  blocked: (what: string | null) => (what ? `Blocked · ${what}` : 'Blocked'),
  page: {
    dates: 'Key dates',
    contingencies: 'Contingencies',
    contract: 'The contract as read',
    documents: 'Documents',
    history: 'History',
    buyer: 'What they want',
    homes: 'Homes',
    tours: 'Tours',
    offers: 'Offers',
    financing: 'Financing',
    inspections: 'Inspections',
    clientTasks: 'Client’s to-do',
    sellerTasks: 'Seller’s to-do',
    walkthrough: 'Walkthrough',
    matches: 'Matches',
    facts: 'Facts',
    photos: 'Photos',
    description: 'Description',
    price: 'Price',
    marketing: 'Marketing',
    openHouses: 'Open houses',
    netSheet: 'Net sheet',
    showings: 'Showings',
  },
  pageLine: {
    facts: 'from the MLS, the seller and you',
    contract: (waiting: number) =>
      waiting > 0
        ? `${plural(waiting, 'value waits', 'values wait')} for a person`
        : 'Every value decided',
    contingencies: (open: number) => (open > 0 ? `${open} open` : 'None open'),
    documents: (n: number) => plural(n, 'document', 'documents'),
  },
  clients: 'Clients',
  client: 'Client',
  portal: (words: string) => `portal: ${words}`,
  portalStates: {
    signed_in: 'signed in',
    invited: 'invited',
    revoked: 'access taken back',
  } as Readonly<Record<string, string>>,
  team: {
    agent: 'Main agent',
    co_agent: 'Co-agent',
    coordinator: 'Coordinator',
    assistant: 'Assistant',
  } as Readonly<Record<string, string>>,
  archived: 'Archived. Nothing on it changes until it’s restored.',
  ended: (how: string, day: string | null, reason: string | null) =>
    `${how}${day ? ` ${day}` : ''}${reason ? `: ${reason}` : '.'}`,
  more: 'More for this deal',
  moreTitle: (name: string) => name,
  writeUpdate: 'Write a client update',
  writeUpdateLine: 'The AI drafts; you check and send',
  writeUpdateWhy: 'Writing a draft needs signal (the AI). Try again when you have signal.',
  writing: 'Writing it now. It opens here when it’s ready.',
  nextStage: 'Move to the next stage',
  movedTo: (stage: string) => `Moved to ${stage}.`,
  movedToWaits: (stage: string) => `Moved to ${stage}. It sends when there’s signal.`,
  closeOnWeb: 'Close the deal',
  closeOnWebLine: 'With the final price and commission, on the web',
  exportLine: 'Every document, date and decision in one file',
  holdTitle: 'Put on legal hold',
  holdLine: 'Owners and admins',
  liftTitle: 'Lift the legal hold',
  openOnWeb: 'Open on the web',
  openOnWebLine: 'Deal settings and the rest of the web',
  moreFooter: 'Export and holds need signal. The rest works with no signal and sends later.',
  holdWhy: 'Placing a hold needs signal: HandsFreeOS keeps its files from then on.',
  liftWhy: 'Lifting a hold needs signal.',
  notNow: 'Not now',
  holdReason: 'Why',
  holdReasonPlaceholder: 'Dispute over the earnest money',
} as const;

/** Exporting the whole transaction, on the phone (board 93). */
export const RE_EXPORT_PHONE_WORDS = {
  share: 'Share or save',
  sharing: 'Getting the file…',
  noSharing: 'This phone can’t save or share files.',
  notOnPhone: 'The file isn’t on this phone. Open the deal’s Documents on the web to download it.',
  failed: 'The file couldn’t be fetched. Try again in a minute.',
} as const;

/** A duty (board 79). */
export const RE_DUTY_WORDS = {
  title: 'Duty',
  doneBy: (who: string) => who,
  youTrack: 'you track',
  /** "the buyers, you track". */
  performers: (who: readonly string[], tracking: boolean) =>
    [who.join(' and '), tracking ? 'you track' : null].filter(Boolean).join(', '),
  due: (words: string) => words,
  dueToday: 'Due today',
  late: 'Late',
  waitingOn: (who: string) => `Waiting on ${who}`,
  blocked: (what: string) => `Blocked: ${what}`,
  done: 'Done',
  doneWaiting: 'Done · waiting to send',
  waived: 'Waived',
  cancelled: 'Cancelled',
  exception: 'Done without its proof',
  draft: 'Waiting for dates',
  whatCounts: 'What counts as done',
  nothingNeeded: 'Saying it’s done is enough. No proof needed.',
  turnsOn: 'Mark done turns on once each proof is there.',
  anyOne: 'Any one of these finishes it.',
  allIn: 'All its proof is in.',
  waitingToSend: 'waiting to send',
  addPhoto: 'Add a photo',
  addFileOrNote: 'Add a file or note',
  markDone: 'Mark done',
  doneWaits: 'Done · waits to send',
  markedDone: 'Marked done.',
  markedDoneWaits:
    'Marked done. It counts at HandsFreeOS when it arrives, with the time you did it.',
  withoutProof: 'Mark done without its proof',
  withoutProofAbout:
    'An owner or admin can, with a reason that’s kept. HandsFreeOS checks it before it counts, so it needs signal.',
  withoutProofOthers:
    'Only an owner or admin can mark it done without its proof. Ask one of them, or add the proof.',
  reasonPlaceholder: 'Why it’s done without its proof',
  keepForLater: 'Keep it for later',
  keepForLaterLine: 'Keep it for later saves your reason here; send it when you have signal.',
  kept: 'Kept on this phone. Send it from here when you have signal.',
  keptReason: 'Your reason, kept on this phone',
  sendKept: 'Send it now',
  markedWithReason: 'Marked done, with your reason.',
  photoAdded: 'Photo added. It uploads when there’s signal.',
  noCamera: 'HandsFreeOS can’t use the camera. Allow it in Settings, then try again.',
  takePhoto: 'Take a photo',
  pickPhoto: 'Choose from your photos',
  fileOrNoteTitle: 'Add a file or note',
  writeNote: 'Write a note',
  sayYouDid: (words: string) => `Say “${words}”`,
  pickDocument: 'Use one of the deal’s documents',
  noteLabel: 'What was done',
  notePlaceholder: 'Emailed it to Jo at 10:51',
  noteAbout:
    'A note shows what happened. When this duty needs a document or a file, a note alone doesn’t finish it.',
  addNote: 'Add the note',
  attestAbout: 'Kept with your name, as your word that it happened.',
  attest: 'Give your word',
  noteAdded: 'Note added.',
  attested: 'Added, with your name.',
  documentAdded: 'Document added as proof.',
  noDocuments: 'This deal has no documents on this phone yet.',
  summaryProof:
    'This duty’s proof loads with signal, because you’re not on its deal. Its due date and who has it are here.',
  notHere: 'This duty isn’t on this phone. Its deal may have ended, or you may no longer be on it.',
  whyDue: 'Why then',
  waitsOn: 'Waits on',
  waitingOnThis: 'Waiting on this',
  log: 'What happened',
  item: {
    document: 'A photo or a file',
    file: 'A photo or a file',
    note: 'Write what was done',
    attestation: 'Their email, or say you did',
    appointment: 'On the calendar',
    message: 'Their email, or a text',
    dates: 'Confirmed on Key dates',
    deal_field: 'Filled in on the deal',
  },
} as const;

/** Key dates, contingencies and the contract as read (board 80). */
export const RE_DATES_WORDS = {
  title: 'Key dates',
  comingUp: 'Coming up',
  done: 'Done',
  today: 'Today',
  footer:
    'Dates come from the contract and the duty list’s rules, and are worked out on the phone, business days and holidays too.',
  amended: (on: string, from: string | null) => `Amended ${on}${from ? ` from ${from}` : ''}`,
  notConfirmed: 'not confirmed yet',
  disagree: 'Two values disagree',
  empty:
    'No dates entered yet. They come from the contract once it’s read, or typed in on the web.',
  dueTitle: (title: string) => title,
} as const;

export const RE_CONTINGENCY_WORDS = {
  title: 'Contingencies',
  ends: (day: string) => `Ends ${day}`,
  endsIn: (day: string, n: number) =>
    `Ends ${day} · ${n === 0 ? 'today' : plural(n, 'day', 'days')}`,
  ended: (day: string) => `Ended ${day}`,
  noEnd: 'No end date',
  resolve: 'Resolve…',
  resolveTitle: (label: string) => `Resolve the ${label} contingency`,
  how: 'How did it end?',
  hows: {
    satisfied: 'Satisfied: it’s met, and the deal goes ahead',
    waived: 'Waived: the deal goes ahead without it',
    expired: 'Expired: it ran out with nothing done',
  },
  proof: 'Proof',
  pickForm: 'Pick the signed form',
  photoForm: 'Take a photo of the signed form',
  photoTaken: (name: string) => `${name} · photo`,
  noForm: 'No form yet? An owner or admin can record it without one, with signal, on the web.',
  save: 'Save',
  saved: 'Saved. The dates and duties that depend on it move when it sends.',
  savesOffline: 'Saves with no signal; the dates and duties that depend on it move when it sends.',
  needForm: 'Pick the signed form, or take a photo of it.',
  from: {
    offer: 'From the accepted offer',
    contract: 'From the contract',
    typed: 'Added on this deal',
  },
  resolvedBy: (name: string) => `by ${name}`,
  empty: 'No contingencies on this deal yet. They come from the accepted offer and the contract.',
  openInspections: 'Open inspections',
  openFinancing: 'Open financing',
  summary:
    'This deal’s contingencies load with signal, because you’re not on it. Try again when you have signal.',
} as const;

export const RE_CONTRACT_WORDS = {
  title: 'The contract as read',
  subtitle: (file: string, version: number) => (version > 1 ? `${file} · v${version}` : file),
  scan: 'Read from a scan',
  text: 'Read from the text',
  confirmed: (n: number, of: number) => `${n} of ${of} confirmed`,
  page: (page: number | null, clause: string | null) =>
    [page ? `Page ${page}` : null, clause].filter(Boolean).join(' · '),
  amended: 'amended',
  waiting: 'Waits for a person',
  rejected: 'Set aside',
  needsPerson: 'Needs a person',
  footer: 'Confirming or changing a term needs signal: it moves the deal’s dates and duties.',
  confirmAll: (n: number) => (n === 1 ? 'Confirm the value' : `Confirm all ${n}`),
  confirmedDone: (n: number) =>
    n === 1
      ? 'Confirmed. Its dates and duties moved.'
      : `${n} confirmed. Their dates and duties moved.`,
  reading: 'Still being read. It shows here when it’s done.',
  failed: (why: string | null) => why ?? 'It couldn’t be read. Try reading it again on the web.',
  notHere: 'This reading isn’t on this phone. It may be of a document since removed.',
  dropped: (n: number) => `${plural(n, 'value', 'values')} couldn’t be placed and were left out.`,
} as const;

/** Documents (board 81). */
export const RE_DOCUMENTS_WORDS = {
  title: 'Documents',
  subtitle: (deal: string, n: number) => `${deal} · ${plural(n, 'document', 'documents')}`,
  signed: 'Signed',
  outForSigning: 'Out for signing',
  notSigned: 'Not signed',
  voided: 'Voided',
  signedOn: (day: string) => `Signed ${day}`,
  versionSigned: (v: number, day: string) => `v${v} · signed ${day}`,
  counts: 'the one that counts',
  signing: 'Signing',
  waiting: 'Waiting',
  waitingToSend: 'Waiting to send · from this phone',
  sentForSigning: 'Sent for signing',
  add: 'Add a document',
  addTitle: 'Add a document',
  addAbout: 'A photo of a paper adds it to the deal’s documents. It works with no signal.',
  kind: 'What it is',
  name: 'Name',
  namePlaceholder: 'Repair amendment',
  photo: 'Take the photo',
  pick: 'Choose from your photos',
  added: (title: string) => `${title} added. It uploads when there’s signal.`,
  openNeedsSignal: (size: string | null) =>
    `Opening it needs signal.${size ? ` It’s ${size} and` : ' It'} stays at HandsFreeOS, not on this phone.`,
  open: 'Open it',
  opening: 'Opening…',
  cantOpen: 'It couldn’t be opened. Try again in a minute.',
  knows: 'What this phone knows',
  signedRow: 'Signed',
  versionRow: 'Version',
  versionOf: (v: number, of: number, counts: boolean) =>
    `${v} of ${of}${counts ? ' · the one that counts' : ''}`,
  lockedRow: 'Locked',
  locked: 'Can’t be deleted or renamed',
  notLocked: 'Not locked',
  kindRow: 'Kind',
  esignRow: 'Signing',
  empty: 'No documents on this deal yet. Add a photo of a paper, or add files on the web.',
  summary:
    'This deal’s documents load with signal, because you’re not on it. Try again when you have signal.',
  exports: 'Exports',
} as const;

/** History (board 81). */
export const RE_HISTORY_WORDS = {
  title: 'History',
  empty: 'Nothing has happened on this deal yet.',
  by: (name: string) => `by ${name}`,
  handsfree: 'HandsFreeOS',
  ai: 'The AI',
  client: 'The client',
  summary:
    'This deal’s history loads with signal, because you’re not on it. Try again when you have signal.',
  more: 'Show older',
} as const;

/** A client update (board 81). */
export const RE_UPDATE_WORDS = {
  title: 'Client update',
  subtitle: (deal: string, status: string) => `${deal} · ${status}`,
  status: {
    drafting: 'drafting',
    ready: 'draft',
    sent: 'sent',
    discarded: 'thrown away',
    failed: 'couldn’t be written',
  } as Readonly<Record<string, string>>,
  to: (name: string) => `To ${name}`,
  fairHousing: 'Fair housing: checks with signal',
  ok: 'OK, send it',
  okWaits: 'OK’d. It goes when there’s signal; after 30 minutes it asks you first.',
  sent: 'Sent.',
  edit: 'Edit',
  save: 'Save',
  saved: 'Saved. Its words are checked again when it arrives.',
  subject: 'Subject',
  body: 'The email',
  stillSend: 'Still send?',
  stillSendAbout: (to: string, ago: string) =>
    `You OK’d this update to ${to} ${ago}, with no signal. Anything to a client that waits more than 30 minutes checks with you first.`,
  sendNow: 'Send now',
  editInstead: 'Not sent. Change it, then OK it again.',
  drafting: 'The AI is writing it. It shows here when it’s ready.',
  sentOn: (day: string) => `Sent ${day}.`,
  discarded: 'This update was thrown away.',
  failed: 'The AI couldn’t write this one. Ask for another from the deal’s More.',
  notHere:
    'This update isn’t on this phone. Its deal may have ended, or you may no longer be on it.',
  waitingToSend: 'OK’d · waiting to send',
  writeNeedsSignal:
    'Writing a draft needs signal (the AI). Checking and OK’ing one works anywhere.',
} as const;

/** "Sep 24", with the year when it isn't this one. */
export const shortDay = (date: string, thisYear?: number) => fmtMonthDay(date, thisYear);

/** "Ann & Bill Smith" when they share a last name; "Linh Nguyen and Sam Park" when they don't (the web's words). */
export function clientNames(names: readonly string[]): string {
  const parts = names.map((n) => n.trim().split(/\s+/));
  const last = parts.map((p) => (p.length > 1 ? p.at(-1) : ''));
  if (names.length > 1 && last[0] && last.every((l) => l === last[0]))
    return `${parts.map((p) => p.slice(0, -1).join(' ')).join(' & ')} ${last[0]}`;
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : (names[0] ?? '');
}
