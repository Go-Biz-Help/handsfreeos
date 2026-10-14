/**
 * What Sales Coach's screens say, once, for the web and the phone (docs/salescoach.md). Browser-safe.
 */
import type { CardKind } from './coach';

export const SALESCOACH_VIEWS = ['live', 'calls', 'playbooks'] as const;
export type SalescoachView = (typeof SALESCOACH_VIEWS)[number];

export const SALESCOACH_WORDS = {
  title: 'AI Sales Coach',
  pageAbout:
    'While you’re on a call, the coach listens and shows you what to say next from your playbook. After it, you get notes, a follow-up and a score.',
  tabs: { live: 'Live call', calls: 'Coached calls', playbooks: 'Playbooks' } as Record<
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
  cardKinds: {
    objection: 'Objection',
    fact: 'They asked',
    step: 'Next step',
    question: 'Ask this',
  } as Record<CardKind, string>,
  calls: {
    none: 'No coached calls yet. Once someone on the team who’s coached takes a call, it shows here.',
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
  suggest: {
    title: 'Suggested replies',
    hide: 'Hide suggestions',
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
