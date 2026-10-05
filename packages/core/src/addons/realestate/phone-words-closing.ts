/**
 * Real Estate's words on the phone for the closing side (round six, boards 85 and 86): the loan's steps, the
 * inspection's findings, the client's to-do and the final walkthrough. What the web already says comes from core's own
 * words (`closing.ts`, `client-words.ts`, `field-words.ts`, `walkthrough.ts`), so both apps say the same; these are
 * the phone's own. Browser-safe.
 */
import { joinAnd } from '../../attention/home-words';

/** "Ann and Bill": the first names of a deal's clients. */
export const firstNamesOf = (names: readonly string[]): string =>
  joinAnd(names.map((n) => n.trim().split(/\s+/)[0] ?? '').filter(Boolean), 4);

/** Board 85, first panel: the loan's steps from the lender. */
export const RE_FINANCING_WORDS = {
  title: 'Financing',
  /** On a listing it's the buyers' loan the deal waits on. */
  titleListing: 'The buyer’s loan',
  steps: 'Steps',
  noLender: 'No lender yet. Add the lender on the web, under Financing.',
  call: (name: string | null) => (name ? `Call ${name.split(/\s+/)[0]}` : 'Call'),
  text: 'Text',
  loan: (amount: string) => `${amount} loan`,
  locked: (day: string) => `rate locked to ${day}`,
  /** The sheet that marks a step done. */
  doneTitle: (label: string) => `${label} is done`,
  doneAbout:
    'Pick its proof: the lender’s letter or email, or one of the deal’s documents. It waits on this phone with no signal.',
  proof: 'Proof',
  photoProof: 'Take a photo of the letter',
  photoTaken: 'Photo of the letter',
  noProof: 'Nothing on the deal yet. Take a photo of the lender’s letter.',
  doneOn: 'Done on',
  today: 'Today',
  yesterday: 'Yesterday',
  markDone: 'Mark done',
  marked: (label: string) => `${label} marked done.`,
  doneLine: (line: string) => line,
} as const;

/** "Today 4:00 PM", "Tomorrow 4:00 PM", "Thu, Oct 8 · 4:00 PM": when something on a deal is. */
export const RE_WHEN_WORDS = {
  today: (time: string) => `Today ${time}`,
  tomorrow: (time: string) => `Tomorrow ${time}`,
  day: (day: string, time: string) => `${day} · ${time}`,
} as const;

/** Photos taken on the spot, on any of these pages. */
export const RE_PHOTO_WORDS = {
  noCamera: 'HandsFreeOS needs the camera to take a photo. Turn it on in Settings.',
  waiting: 'Waiting',
  waitingToUpload: (n: number) => `${n} waiting to upload`,
  camera: 'Take a photo',
  library: 'Choose from your photos',
} as const;

/** Board 85, second and third panels: the inspection and what it found. */
export const RE_INSPECTION_WORDS = {
  title: 'Inspections',
  reportIn: 'Report in',
  notBooked: 'Not booked',
  findings: 'Findings',
  findingCount: (n: number) => (n === 1 ? '1 finding' : `${n} findings`),
  periodEnds: (day: string) => `period ends ${day}`,
  none: 'No inspections yet. Add the inspection on the web, with its inspector and day; its findings are added here, at the home.',
  noFindings: 'Nothing found yet. Add each thing as the inspector points it out.',
  askFor: (ask: string) => `ask for ${ask.toLowerCase()}`,
  addFinding: 'Add a finding',
  /** The sheet, at the inspection. */
  what: 'What',
  whatHint: 'Garage door won’t close all the way',
  where: 'Where',
  whereHint: 'Garage',
  howSerious: 'How serious',
  add: 'Add',
  added: 'Added.',
  photos: (n: number) => (n === 1 ? '1 photo' : `${n} photos`),
  photo: (n: number) => `Photo ${n}`,
  waiting: 'Photos upload when there’s signal.',
  sayWhat: 'Say what was found.',
  /** The repair request, from the findings. */
  draft: 'Draft the repair request',
  draftAbout:
    'Drafted from the findings, must-fixes first. Edit it to say exactly what you’re sending.',
  draftWhy: 'Sending the repair request needs signal.',
  send: 'Send the request',
  sent: 'Sent.',
  nothingToAsk: 'Nothing to ask for yet. Say what to ask for on each finding first.',
} as const;

/** Board 85, last panel: what the clients still have to do, as their portal shows it. */
export const RE_CLIENT_TODO_WORDS = {
  title: 'Client to-do',
  /** "Ann and Bill’s to-do". */
  label: (who: string) => (who ? `${who}’s to-do` : 'Their to-do'),
  open: (n: number) => `${n} open`,
  dueToday: 'Due today',
  noDate: 'No date',
  done: (day: string, inPortal: boolean) =>
    `Done${day ? ` ${day}` : ''}${inPortal ? ' in the portal' : ''}`,
  canceled: 'Canceled',
  none: (who: string) =>
    `Nothing asked of ${who || 'the clients'} yet. Ask for their preapproval letter or ID, and they do it in their portal.`,
  add: 'Add one for them',
  reaches:
    'A new one reaches their portal; with no signal it waits and asks again after 30 minutes.',
  /** Adding one. */
  addTitle: 'Add one for them',
  somethingElse: 'Something else',
  taskTitle: 'What they do',
  forWhom: 'For',
  everyone: 'Every client',
  due: 'Due',
  inAWeek: 'In a week',
  today: 'Today',
  tomorrow: 'Tomorrow',
  addIt: 'Add',
  addedIt: (who: string) => `Added. It’s on ${who || 'their'} to-do in their portal.`,
  sayWhat: 'Say what they do.',
  /** Marking one done for a client who did it another way. */
  markTitle: (title: string) => `Mark “${title}” done`,
  markFor: 'Done by',
  how: 'How it was done',
  howHint: 'They emailed it to me',
  markDone: 'Mark done',
  markWhy: 'Marking it done for them needs signal.',
  marked: 'Marked done.',
  theirOwn: 'Only they can do this one, in their portal.',
  /** The portal: who's in it, and asking someone in (`?invite=1`). */
  notIn: (first: string) => `${first} isn’t in the portal yet`,
  invite: 'Invite',
  inviteTitle: (first: string, again: boolean) =>
    again ? `Send ${first} the link again?` : `Invite ${first} to the portal?`,
  inviteAbout: (email: string, first: string) =>
    `We’ll email ${email} a private link. The first time ${first} opens it on a device, they type a 6-digit code we email them. No password.`,
  inviteSees: (agent: string) =>
    `They’ll see where the deal stands, its key dates, their to-do, the homes and tours, and can message ${agent}. They won’t see your notes, duties or other clients.`,
  noEmail: (name: string) =>
    `${name} has no email address, so there’s nowhere to send the link or the code. Add their email on their page first.`,
  send: (again: boolean) => (again ? 'Send it again' : 'Send the invite'),
  sendWhy: 'Inviting someone to the portal needs signal.',
  sentTo: (email: string) => `Sent to ${email}.`,
} as const;

/** Board 86: the final walkthrough, checked on the phone with no signal. */
export const RE_WALKTHROUGH_WORDS = {
  title: 'Walkthrough',
  card: 'Final walkthrough',
  with: (who: string) => `with ${who}`,
  closing: (day: string) => `closing ${day}`,
  /** Before it's planned: building the list needs the deal as HandsFreeOS has it. */
  none: 'No walkthrough yet. Build its list from the deal: the repairs agreed, what the contract says stays and goes, the inspection and each room.',
  plan: 'Build the walkthrough list',
  planWhy:
    'Building the list needs signal. Once it’s on the phone, the whole walkthrough works with no signal.',
  planned: (n: number) => `The list is ready: ${n === 1 ? '1 thing' : `${n} things`} to check.`,
  /** Before it starts: the list, built from the deal. */
  builtFrom: 'The list, built from the deal',
  groups: {
    repair: (n: number) => (n === 1 ? '1 repair agreed' : `${n} repairs agreed`),
    included: (n: number) => (n === 1 ? '1 item that stays' : `${n} items that stay`),
    excluded: (n: number) => (n === 1 ? '1 item that goes' : `${n} items that go`),
    finding: (n: number) =>
      n === 1 ? '1 thing from the inspection' : `${n} things from the inspection`,
    room: (n: number) => (n === 1 ? '1 room to check' : `${n} rooms to check`),
    added: (n: number) => (n === 1 ? '1 added on the day' : `${n} added on the day`),
  },
  groupLines: {
    repair: 'From the repair amendment, with the inspector’s photos',
    included: (items: string) => `From the contract: ${items}`,
    excluded: (items: string) => items,
    finding: 'Safety issues and repairs nobody asked to fix',
    room: 'Against the listing photos',
    added: 'Added on the phone',
  },
  start: 'Start the walkthrough',
  addItem: 'Add an item',
  onPhone: 'The list is on the phone before you go; the whole walkthrough works with no signal.',
  /** Checking. */
  ofCount: (done: number, all: number) => `${done} of ${all}`,
  checkIt: 'Check it',
  /** The repairs' own words for how each was. */
  repairStates: { ok: 'Fixed', not_ok: 'Not fixed', unsure: 'Not sure' },
  note: 'Note',
  noteHint: 'Stops a foot short; sensor not replaced.',
  save: 'Save',
  fixDuty: (title: string) =>
    `Finishing adds a duty: “Fix before closing: ${title.charAt(0).toLowerCase()}${title.slice(1)}.”`,
  addPhoto: 'Add a photo',
  finish: 'Finish the walkthrough',
  finishTitle: 'Finish the walkthrough?',
  finishAbout: (summary: string) =>
    `${summary}. Each thing that isn’t right becomes a duty before closing.`,
  agreed: (who: string) => `${who || 'The clients'} agree it’s as agreed`,
  finished: 'Walkthrough done.',
  /** Adding something the list doesn't have. */
  addTitle: 'Add an item',
  what: 'What to check',
  whatHint: 'Sprinklers run',
  detail: 'Detail',
  sayWhat: 'Say what to check.',
  /** Done. */
  done: 'Walkthrough done',
  okCount: (ok: number, all: number) => `${ok} of ${all} OK`,
  doneLine: (time: string, who: string | null, photos: number) =>
    [
      who ? `${time} with ${who}` : time,
      photos ? (photos === 1 ? '1 photo' : `${photos} photos`) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  toFix: (n: number) => (n === 1 ? '1 to fix before closing:' : `${n} to fix before closing:`),
  fixItem: (title: string, who: string | null, due: string | null) =>
    `${title.charAt(0).toLowerCase()}${title.slice(1)}${
      who || due
        ? ` (duty${who ? ` for ${who}` : ''}${due ? `${who ? ',' : ''} due ${due}` : ''})`
        : ''
    }`,
  proof: 'Proof',
  proofDone: 'Final walkthrough · done',
  proofDoneLine: 'Checklist, photos and the time, as the duty’s proof',
  agreedLine: (time: string) => `Ticked on this phone at ${time}`,
  notAgreed: 'Not ticked',
} as const;
