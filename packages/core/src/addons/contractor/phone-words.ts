/**
 * Contractor Operations on the phone (docs/contractor.md, "On the phone"): the words only its phone screens say.
 * What the web says too (a status, a material's counts, a note) is in `words.ts`, and the phone reads it from
 * there, so both say the same thing. Browser-safe and pure.
 */
import { photosWords } from './notes';
import { CONTRACTOR_NAME } from './words';

/** "1 change waits on this phone and will send on its own" · "3 changes wait … on their own". */
const waitsWords = (n: number) =>
  n === 1
    ? '1 change waits on this phone and will send on its own'
    : `${n} changes wait on this phone and will send on their own`;

/** "1:05", for a recording's length. */
export function clockOfSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const CONTRACTOR_PHONE_WORDS = {
  more: {
    section: CONTRACTOR_NAME,
    jobs: 'Jobs',
    /** "4 open · 2 visits for you today". */
    detail: (open: number, today: number) =>
      [
        `${open} open`,
        today === 0
          ? null
          : today === 1
            ? '1 visit for you today'
            : `${today} visits for you today`,
      ]
        .filter(Boolean)
        .join(' · '),
    onTheWeb: 'Dispatch, estimates, costs and settings are on the web.',
  },
  kept: {
    noSignal: 'No signal. This is what’s kept on this phone.',
    keptAt: (time: string) => `No signal. Kept on this phone as of ${time}.`,
    waiting: (n: number) => `No signal. ${waitsWords(n)}.`,
    waitingToSend: 'Waiting to send',
    needsSignal: 'Needs signal',
    refused: 'That didn’t go through. Try again in a minute.',
  },
  jobs: {
    today: 'My visits today',
    noVisits: 'No visits for you today.',
    whose: 'Which jobs',
    filters: { mine: 'My jobs', all: 'All', late: 'Late' },
    closedToo: 'Done and cancelled too',
    none: {
      mine: 'No open jobs are yours. All shows the business’s jobs.',
      all: 'No open jobs. New jobs are started on the web.',
      late: 'Nothing is late.',
    },
    noMatch: (q: string) => `No jobs match “${q}”. Try another search.`,
    truncated: (n: number) => `Showing the first ${n} jobs. Search to find another.`,
    openJob: (name: string) => `Open ${name}`,
    openVisit: (name: string) => `Open the work order for ${name}`,
    nextVisit: (when: string) => `Next visit ${when}`,
    percentDone: (p: number) => `${p}% done`,
    due: (day: string) => `Due ${day}`,
    phases: (done: number, count: number) => `${done} of ${count} phases done`,
  },
  job: {
    gone: 'This job isn’t on this phone. It may have been archived, or finished more than a month ago. Open it on the web with signal.',
    backToJobs: 'Back to Jobs',
    about: 'About the job',
    progress: 'Progress',
    changeStatus: 'Change status',
    statusNeedsSignal:
      'Changing a job’s status needs signal: it’s checked against every visit’s checklist.',
    statusTitle: 'Change the job’s status',
    reasonNeeded: (status: string) => `Say why it’s ${status.toLowerCase()}.`,
    percentTitle: 'How far along is it?',
    percentOf: (p: number) => `${p}%`,
    phaseTitle: (name: string) => `Where does “${name}” stand?`,
    phaseSaved: (name: string, status: string) => `“${name}” is ${status.toLowerCase()}.`,
    onTheWeb: 'Its estimate, costs and budget are on the web.',
    call: (name: string) => `Call ${name}`,
    callShort: 'Call',
    why: (reason: string) => `Why: ${reason}`,
  },
  visit: {
    gone: 'This visit’s work order isn’t on this phone yet. It arrives a moment after the visit is booked on a job. With signal, pull down to refresh.',
    where: 'Where',
    directions: 'Directions',
    /** Its row on the visit's page in Calendar. */
    panel: 'Work order',
    panelDetail: (job: string) => `The checklist, materials and notes for ${job}`,
    takePhoto: 'Take the photo',
    retakePhoto: 'Take it again',
    photoKept: 'Photo kept. It uploads on its own.',
    photoWaiting: 'Photo waiting to upload',
    noCamera:
      'HandsFreeOS can’t use the camera. Allow it in your phone’s Settings → HandsFreeOS → Camera, then try again.',
  },
  materials: {
    count: (name: string) => `Count ${name}`,
    countTitle: (name: string) => `What happened to the ${name}?`,
    countHint:
      'Add what you used, wasted or sent back just now. It adds to what’s counted already.',
    add: 'Add to the count',
    nothing: 'Enter an amount first.',
    notANumber: 'Enter a number, like 2 or 0.5.',
    counts: (used: string, left: string) => `${used} used · ${left} left`,
  },
  time: {
    yours: (kind: string, since: string) => `You: ${kind.toLowerCase()} since ${since}`,
    notOnClock: 'Your time starts on its own when the visit is marked On my way or Started.',
    totals: (work: string, travel: string, breaks: string) =>
      `Work ${work} · Travel ${travel} · Breaks ${breaks}`,
    fixOnTheWeb: 'An owner or admin fixes time on the web.',
  },
  notes: {
    type: 'Type a note',
    photo: 'Photo',
    voice: 'Voice note',
    typeTitle: 'Add a note',
    empty: 'Type something first.',
    voiceTitle: 'Voice note',
    voiceAt: (job: string, clock: string) => `${job} · ${clock}`,
    recording: 'Recording. Say what you see.',
    stop: 'Stop',
    keepIt: 'Keep it',
    recordAgain: 'Record again',
    recordedOnline: 'Recorded. Its words follow in a moment.',
    recordedOffline:
      'Recorded. No signal: it stays on this phone and sends on its own, and its words follow then.',
    noMicrophone:
      'HandsFreeOS can’t use the microphone. Allow it in your phone’s Settings → HandsFreeOS → Microphone, then try again.',
    recordFailed: 'That didn’t record. Try again.',
    heard: 'Voice note kept.',
    photoKept: 'Photo kept with a note.',
    photosWaiting: (n: number) => `${photosWords(n)} waiting to upload`,
    photos: photosWords,
    removeNeedsSignal: 'Removing a note needs signal.',
    by: (name: string | null, when: string) => `${name ?? 'Someone who’s left'} · ${when}`,
  },
} as const;
