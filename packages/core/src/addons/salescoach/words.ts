/**
 * What Sales Coach's screens say, once, for the web and the phone (docs/salescoach.md). Browser-safe.
 */
import type { CardKind } from './coach';

export const SALESCOACH_VIEWS = ['live', 'calls', 'trends', 'playbooks'] as const;
export type SalescoachView = (typeof SALESCOACH_VIEWS)[number];
/** The tabs, and the panel HandsFreeOS's app inside Zoom opens (`zoom`, no tab of its own). */
export const SALESCOACH_PAGE_VIEWS = [...SALESCOACH_VIEWS, 'zoom'] as const;
export type SalescoachPageView = (typeof SALESCOACH_PAGE_VIEWS)[number];

export const SALESCOACH_WORDS = {
  title: 'AI Sales Coach',
  pageAbout:
    'While you’re on a call, the coach listens and shows you what to say next from your playbook. After it, you get notes, a follow-up and a score.',
  tabs: { live: 'Live call', calls: 'Coached', trends: 'Trends', playbooks: 'Playbooks' } as Record<
    SalescoachView,
    string
  >,
  live: {
    listening: 'Listening',
    writing: 'Writing up the call…',
    ended: 'Call ended',
    waiting: 'The coach is listening. Cards show here when there’s something worth saying.',
    none: 'No call right now. When you answer or place a call, the coach listens and shows what to say here.',
    noneHow:
      'Calls in the web app show the coach above the call bar. On your cell, keep this page open, or open AI Sales Coach in the phone app.',
    noPlaybook:
      'There’s no playbook yet, so the coach only has what HandsFreeOS knows about the business. Ask an owner to add one under AI Sales Coach → Playbooks.',
    step: 'Where you are',
    dismiss: 'Got it',
    stop: 'Stop coaching this call',
    stopped: 'Coach stopped for this call',
    seeCall: 'See the write-up',
    heard: 'They said',
  },
  /** HandsFreeOS's app inside a Zoom meeting (round three): `?view=zoom`. */
  zoom: {
    title: 'Coach in this Zoom meeting',
    outside:
      'This is the coach for Zoom meetings. In a meeting, open HandsFreeOS from Zoom’s Apps button and it shows here.',
    outsideHow:
      'On a second screen, keep AI Sales Coach → Live call open: the same cards show there while a meeting is coached.',
    notInMeeting: 'Start or join a Zoom meeting, then open HandsFreeOS from Apps.',
    connecting: 'Getting this meeting ready…',
    whoWith: 'Who is this call with?',
    whoWithHelp:
      'Pick the customer, so the notes, the follow-up and any tasks land on their record.',
    noCustomer: 'Coach without a customer',
    withWhom: (name: string) => `With ${name}`,
    change: 'Change',
    start: 'Start coaching',
    starting: 'Starting…',
    waiting: 'Zoom is starting to listen. Cards show here when there’s something worth saying.',
    stop: 'Stop coaching',
    stopping: 'Stopping…',
    off: 'The coach isn’t listening to this meeting.',
    notice: 'Zoom shows everyone in the meeting that an app is listening.',
    startFailed:
      'Zoom didn’t start listening. If you’re not the host, ask the host to let apps listen to the meeting (in Zoom’s settings, under Realtime media streams). Then press Start coaching again.',
    zoomOld: 'Update Zoom to its newest version, then open HandsFreeOS again.',
    connect: 'Connect Zoom',
    connectedTryAgain: 'I’ve connected. Try again',
  },
  cardKinds: {
    objection: 'Objection',
    fact: 'They asked',
    step: 'Next step',
    question: 'Ask this',
  } as Record<CardKind, string>,
  calls: {
    none: 'Nothing coached yet. Calls show here once someone on the team who’s coached takes one, and texts, chats and emails once a conversation they answered goes quiet.',
    /** Where it happened: a call, or a written conversation's channel. */
    channels: {
      call: 'Call',
      sms: 'Texts',
      email: 'Email',
      chat: 'Website chat',
      portal: 'Portal',
      messenger: 'Messenger',
      instagram: 'Instagram',
    } as Record<string, string>,
    score: 'Score',
    summary: 'Summary',
    notes: 'Notes',
    promises: 'What you promised',
    promisesAbout: 'Each is a task for you, about the customer.',
    followUp: 'Follow-up to send',
    followUpAbout: 'Copy it into a text or email. Nothing was sent.',
    objections: 'Objections',
    answered: 'Answered',
    notAnswered: 'Not answered',
    tips: 'Next time',
    said: 'What was said',
    you: 'Rep',
    customer: 'Customer',
    steps: (covered: number, of: number) => `${covered} of ${of} script steps`,
    objectionCount: (answered: number, of: number) =>
      of === 0 ? 'No objections' : `${answered} of ${of} objections answered`,
    talk: (share: number) => `You talked ${share}% of the time`,
    writing: 'Being written up',
    failed: 'No write-up',
    stopped: 'Coach stopped',
    live: 'On the call now',
    noCustomer: 'A caller nobody knows yet',
    openConversation: 'Open the conversation',
  },
  /** How coached calls are going over time (round four, ./trends.ts): a rep's own, and the owner's view. */
  trends: {
    team: 'Your team',
    teamAbout:
      'Every rep’s coached calls and conversations, against the same number of weeks before. Pick a rep to see their weeks.',
    mine: 'Your coached calls',
    mineAbout:
      'How your coached calls and conversations are going, against the same number of weeks before.',
    repAbout: (name: string) =>
      `How ${name}’s coached calls and conversations are going, against the same number of weeks before.`,
    everyone: 'Everyone',
    period: (weeks: number) => `${weeks} weeks`,
    none: 'Nothing to show yet. Trends start once calls or conversations have been coached and written up.',
    noneHere: 'Nothing coached in these weeks.',
    coached: 'Coached',
    score: 'Average score',
    talk: 'Talk time',
    talkAbout: 'Your share of the talking on calls and meetings. 35 to 60% is the sweet spot.',
    objections: 'Objections answered',
    steps: 'Script steps done',
    wins: 'Wins',
    winsAbout: 'A job booked, an estimate accepted, a payment or a deal won within a week.',
    rep: 'Rep',
    weekly: 'Score by week',
    weeklyAbout: 'The average score of each week’s coached calls. Weeks with none are left out.',
    weekOf: (date: string) => `Week of ${date}`,
    week: 'Week',
    asTable: 'See as a table',
    skipped: 'Steps skipped most',
    skippedAbout: 'From calls with a playbook. Practice these, or move them in the script.',
    skippedLine: (skipped: number, of: number) => `Skipped on ${skipped} of ${of} calls`,
    noSkipped: 'No step is skipped often. Steps show here after at least 3 calls with them.',
    before: (v: string) => `was ${v}`,
    beforeNone: 'nothing before',
    percent: (v: number | null) => (v === null ? '—' : `${v}%`),
    ofCount: (part: number, of: number) => (of === 0 ? '—' : `${part} of ${of}`),
  },
  suggest: {
    title: 'Suggested replies',
    hide: 'Hide suggestions',
  },
  learn: {
    title: 'What’s working',
    about:
      'Once a week the coach compares how your reps answered objections on calls and in messages that ended in a win (a job booked, an estimate accepted, a payment, a deal won), and suggests better answers. Nothing changes until you use one.',
    none: 'Nothing new yet. Suggestions show here once an objection has come up in at least 3 wins.',
    lookAgain: 'Look again now',
    looking: 'Looking…',
    found: (n: number) =>
      n === 0
        ? 'Nothing new to suggest yet.'
        : `${n} new ${n === 1 ? 'suggestion' : 'suggestions'}.`,
    better: 'Better answer',
    added: 'New objection',
    now: 'Now',
    suggested: 'Suggested',
    use: 'Use it',
    dismiss: 'Not now',
    used: 'Playbook updated.',
    inPlaybook: (name: string) => `In “${name}”`,
  },
  playbooks: {
    about:
      'The coach says only what’s here and what HandsFreeOS knows about the business. The usual playbook is the one calls use.',
    none: 'No playbooks yet. Write one, or let the AI draft one from your business or your own script.',
    readOnly: 'Owners and admins write the playbooks.',
    add: 'New playbook',
    draft: 'Draft one with AI',
    draftAbout:
      'Paste your own script to turn it into steps and objection answers, or leave it empty to start from what HandsFreeOS knows about your business.',
    draftScript: 'Your script (optional)',
    drafting: 'Drafting…',
    usual: 'Usual',
    makeUsual: 'Make it the usual one',
    archive: 'Archive',
    restore: 'Bring back',
    archived: 'Archived',
    name: 'Name',
    kind: 'Kind of call',
    steps: 'Script steps',
    stepsAbout: 'In order. What to do, and the words to say if you like.',
    step: 'What to do',
    say: 'Words to say',
    objections: 'Objections',
    objectionsAbout: 'What customers push back with, and your answer.',
    objection: 'They say',
    answer: 'You answer',
    points: 'Talking points',
    pointsAbout: 'Facts the rep can lean on: warranty, what’s included, how soon you can come.',
    topic: 'Topic',
    fact: 'Fact',
    addStep: 'Add a step',
    addObjection: 'Add an objection',
    addPoint: 'Add a talking point',
    remove: 'Remove',
    save: 'Save playbook',
    saved: 'Playbook saved.',
    cancel: 'Cancel',
  },
} as const;
