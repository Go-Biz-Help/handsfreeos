/**
 * AI Sales Coach: its manifest (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, docs/salescoach.md,
 * docs/addon-architecture.md). Browser-safe: the screens, the API, the worker and the AI all read it, so it holds no
 * server code. Everything it declares starts with its id, `salescoach`.
 *
 * It hears a business's phone calls as they happen (`liveCalls`), shows the person on the call what to say next from
 * the business's own playbooks, and after the call writes the notes, a follow-up and a score. It took in the planned
 * Live Sales Assist (`salesassist`, retired, 2026-10-14). Its written conversations come next, then Zoom.
 *
 * It's in `development`: offered nowhere, and installable only where HandsFreeOS staff hand it out to try.
 */
import { defineAddon } from '../manifest';

export const salescoachAddon = defineAddon({
  id: 'salescoach',
  name: 'AI Sales Coach',
  summary:
    'Coaches your team live on calls: what to say next, answers to objections, and notes, follow-ups and scores after.',
  description:
    'While someone on your team is on a call, the coach listens and shows them, from your own scripts, what to say next, how to answer an objection and the facts the customer just asked about. After the call it writes the notes, a follow-up to send, tasks for what they promised, and a score.',
  category: 'sales',
  version: '0.1.0',
  // One more whenever its data changes shape; the worker brings each business's data up a step at a time
  // (apps/worker/src/addons/salescoach/index.ts, `dataMigrations`).
  dataVersion: 1,
  catalog: {
    status: 'development',
    // The words someone uses when they need it: what recommendations and the AI's search match on.
    keywords: [
      'sales coach',
      'sales coaching',
      'call coaching',
      'objection handling',
      'sales scripts',
      'talking points',
      'live call assist',
      'call scoring',
    ],
    exampleNeeds: [
      'tell my reps what to say when a customer says it’s too expensive',
      'coach my team while they’re on sales calls',
      'score our sales calls',
    ],
    groups: ['Sales Enablement', 'Voice & Calling'],
  },
  capabilities: [
    {
      id: 'salescoach.use',
      label: 'Live call coaching',
      description:
        'What to say next, answers to objections and the facts asked about, on screen during a call.',
      permission: 'salescoach.use',
    },
    {
      id: 'salescoach.playbooks',
      label: 'Sales playbooks',
      description: 'The scripts, objection answers and talking points the coach uses.',
      permission: 'salescoach.manage',
    },
    {
      id: 'salescoach.review',
      label: 'Call scores',
      description: 'Every rep’s coached calls, notes and scores.',
      permission: 'salescoach.review',
    },
  ],
  // Exist only while it runs in a business. Its migration registers the same list (the parity test checks).
  permissions: [
    {
      key: 'salescoach.use',
      label: 'Be coached on calls',
      description:
        'Get live coaching on your own calls, and see your own coached calls, notes and scores.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'salescoach.review',
      label: 'See everyone’s coached calls',
      description: 'See every rep’s coached calls, notes and scores.',
      defaultRoles: ['admin'],
      requires: ['salescoach.use'],
    },
    {
      key: 'salescoach.manage',
      label: 'Write the playbooks',
      description:
        'Write and change the scripts, objection answers and talking points the coach uses.',
      defaultRoles: ['admin'],
      requires: ['salescoach.use'],
    },
  ],
  tables: ['playbooks', 'calls', 'cards', 'suggestions'],
  events: {
    emits: [
      'salescoach.playbook.saved',
      'salescoach.playbook.archived',
      'salescoach.call.started',
      'salescoach.card.added',
      'salescoach.card.dismissed',
      'salescoach.call.ended',
      'salescoach.call.stopped',
      'salescoach.call.finished',
      'salescoach.suggestions.ready',
      'salescoach.conversation.finished',
    ],
    // A customer wrote: replies to suggest (round two).
    consumes: ['message.received'],
  },
  // After a call: the notes, the follow-up, the tasks and the score. After a customer writes: replies to suggest.
  // A written conversation that went quiet: its write-up.
  jobs: ['salescoach.after_call', 'salescoach.suggest', 'salescoach.conversation_quiet'],
  // It hears the calls of people who may be coached.
  liveCalls: { permission: 'salescoach.use' },
  billing: { model: 'free' },
  ui: {
    // One row in the side menu: the page has the live call, the coached calls and the playbooks (`?view=`).
    nav: [{ key: 'salescoach', label: 'AI Sales Coach', icon: 'headset', path: '' }],
    // The cards above the web's call bar while someone is on a call,
    // and the replies it suggests above the message box in a written conversation.
    slots: [
      { slot: 'call.panels', permission: 'salescoach.use' },
      { slot: 'composer.suggestions', permission: 'salescoach.use' },
    ],
    // On the phone: the live call (a cell call can't show a bar), from the push or under More.
    phone: [{ path: '', query: ['view'], web: { view: ['calls', 'playbooks'] } }],
  },
  ai: {
    directory:
      'live sales coaching on calls: the business’s sales playbooks (scripts, objection answers, talking points) and coached calls with their notes and scores',
  },
});
