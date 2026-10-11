/**
 * Social Outreach: its manifest (docs/outreach.md, docs/addon-architecture.md). Browser-safe: the screens, the API,
 * the worker, the extension and the AI all read it, so it holds no server code. Everything it declares starts with
 * its id, `outreach`.
 *
 * It's in `development`: offered nowhere, and installable only where HandsFreeOS staff hand it out to try. The
 * browser extension (apps/extension) connects only to businesses where it runs and the person holds `outreach.use`.
 */
import { defineAddon } from '../manifest';
import { OutreachSettingsSchema } from './chat-read';

export const outreachAddon = defineAddon({
  id: 'outreach',
  name: 'Social Outreach',
  summary:
    'Find and follow up with prospects on Facebook from a browser extension, with every person, chat and step kept in HandsFreeOS.',
  description:
    'A browser extension works beside you on Facebook: it saves the people you find and your chats with them to Contacts, and your playbooks say who you’re looking for, how you sound and which of your tags to use.',
  category: 'sales',
  version: '0.7.0',
  // One more whenever its data changes shape; the worker brings each business's data up a step at a time
  // (apps/worker/src/addons/outreach/index.ts, `dataMigrations`). 2: a playbook's questions have answers, and it
  // has a pace.
  dataVersion: 2,
  catalog: {
    status: 'development',
    // The words someone uses when they need it: what recommendations and the AI's search match on.
    keywords: [
      'outreach',
      'facebook',
      'social media',
      'prospecting',
      'friend requests',
      'messenger',
    ],
  },
  capabilities: [
    {
      id: 'outreach.use',
      label: 'Social Outreach',
      description:
        'Save people and chats from Facebook to Contacts with the browser extension, guided by your playbooks.',
      permission: 'outreach.use',
    },
    {
      id: 'outreach.playbooks',
      label: 'Outreach playbooks',
      description:
        'Write who you’re looking for on social media, how you sound and which tags to use.',
      permission: 'outreach.manage',
    },
  ],
  // Exist only while it runs in a business. Its migration registers the same list (the parity test checks).
  permissions: [
    {
      key: 'outreach.use',
      label: 'Use Social Outreach',
      description:
        'Save people and chats from Facebook with the browser extension, and see the playbooks.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'outreach.manage',
      label: 'Run Social Outreach',
      description: 'Write the playbooks: the goal, who it’s for, the words and the tags.',
      defaultRoles: ['admin'],
      requires: ['outreach.use'],
    },
  ],
  billing: { model: 'free' },
  events: {
    emits: [
      'outreach.playbook.saved',
      'outreach.playbook.archived',
      'outreach.profile.saved',
      'outreach.chat.saved',
      'outreach.touch.saved',
      'outreach.friend.answered',
      'outreach.friends.saved',
      'outreach.friend.marked',
      'outreach.download.saved',
      'outreach.chat.read',
      'outreach.chats.collected',
      'outreach.groups.saved',
      'outreach.group.saved',
      'outreach.friend.ended',
      'outreach.warning.seen',
      'outreach.posts.saved',
      'outreach.post.checked',
      'outreach.post.skipped',
      'outreach.reply.seen',
      'outreach.opener.used',
      'outreach.demo.marked',
      'outreach.demo.booked',
      'outreach.automation.saved',
      'outreach.warm_up.missed',
      'outreach.send.queued',
      'outreach.send.approved',
      'outreach.send.skipped',
      'outreach.send.done',
      'outreach.wheels.ended',
      'outreach.live.changed',
      'outreach.day.started',
      'outreach.day.stopped',
      'outreach.computer.renamed',
      'outreach.need.noted',
      'outreach.need.cleared',
      'outreach.request.set_aside',
      'outreach.ask.made',
      'outreach.ask.started',
      'outreach.ask.progressed',
      'outreach.ask.replied',
      'outreach.ask.cancelled',
      'outreach.ask.ended',
      'outreach.setup.saved',
      'outreach.check.looked',
      'outreach.check.saved',
      'outreach.stage.marked',
    ],
    // The last part of a download, and chats read in Messenger, start the AI's read of the chats
    // (apps/worker/src/addons/outreach/chats.ts); group posts worth a look start its check of them (./posts.ts), and
    // friends and people chatted with, read off their pages, its check of whether they fit (./checks.ts).
    // A reply seen, or one handed over to the person (decision 27), pushes to their phone, and a change to the settings
    // moves the morning push (./alerts.ts) and the weekly report (./weekly.ts); a booking through a demo link counts as a demo (./demos.ts).
    // A Facebook warning pushes to the person's phone, and what the extension tells the app keeps the feed's pruning
    // armed (decision 41, ./live.ts). A message waiting for the person's OK, and a step the extension needs them for,
    // reach their phone as their pushes setting says (decision 40, ./waiting.ts). An ask that first needs the person
    // pushes to them at once (decision 43, ./asks.ts).
    consumes: [
      'outreach.download.saved',
      'outreach.chats.collected',
      'outreach.posts.saved',
      'outreach.check.looked',
      'outreach.reply.seen',
      'outreach.send.queued',
      'addon.settings_saved',
      'appointment.booked',
      'outreach.warning.seen',
      'outreach.live.changed',
      'outreach.need.noted',
      'outreach.ask.progressed',
    ],
  },
  jobs: [
    'outreach.read_chats',
    'outreach.check_posts',
    'outreach.check_people',
    'outreach.morning',
    'outreach.weekly',
    'outreach.live_prune',
    'outreach.waiting_push',
  ],
  // Who from the chats brought in goes in Contacts (./chat-read.ts), how long a sent request waits, the hour of the
  // morning push, and the weekly report: Social Outreach → Settings → Business settings.
  settings: { version: 1, permission: 'outreach.manage', workspace: OutreachSettingsSchema },
  // Its own tables, in `addon_outreach` (packages/core/src/addons/outreach/tables.ts mirrors them).
  tables: [
    'asks',
    'automation',
    'checks',
    'computers',
    'days',
    'demos',
    'file_chats',
    'file_people',
    'friend_ends',
    'friends',
    'group_people',
    'groups',
    'imports',
    'live_steps',
    'my_groups',
    'needs',
    'opener_uses',
    'playbooks',
    'posts',
    'profiles',
    'replies',
    'sends',
    'setup',
    'stages',
    'threads',
    'touches',
    'waiting_pushes',
    'warnings',
  ],
  // What phones keep with no signal (decision 44, owner answer 19b): each person's messages waiting for their OK,
  // theirs alone, so OK, change, skip and Approve all work on the phone with none. Its migration registers the same
  // (20261027001800, `private.addon_phone_own_table`).
  offline: {
    permission: 'outreach.use',
    tables: [
      {
        table: 'sends',
        owner: 'user_id',
        keep: { column: 'state', values: ['waiting'] },
        columns: [
          'user_id',
          'profile_id',
          'kind',
          'thread_key',
          'text',
          'state',
          'handed_over',
          'needs_you',
          'name',
          'profile_url',
          'created_at',
          'updated_at',
        ],
      },
    ],
  },
  ui: {
    // Its place in the side menu, shown only while it runs and to people who may open it.
    nav: [{ key: 'outreach', label: 'Social Outreach', icon: 'handshake', path: '' }],
    // A customer's Facebook profile and the chats saved with them.
    slots: [{ slot: 'person.panels', permission: 'outreach.use' }],
    // The whole add-on on the phone, under More (decision 44): one page with the web's tabs (`?view=`), so the pushes'
    // links (`?view=waiting`, `live`, `today`) open the phone's screens; and a playbook. The activity and friends stay
    // on the web, and their links open it.
    phone: [
      {
        path: '',
        query: ['view', 'for', 'show', 'tag', 'q'],
        web: { view: ['activity', 'friends'] },
      },
      { path: 'playbooks/:playbookId' },
    ],
  },
  ai: {
    directory:
      'saves people and chats from facebook to contacts with a browser extension, guided by playbooks',
  },
});
