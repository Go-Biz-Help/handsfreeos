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
  version: '0.11.0',
  // One more whenever its data changes shape; the worker brings each business's data up a step at a time
  // (apps/worker/src/addons/outreach/index.ts, `dataMigrations`). 2: a playbook's questions have answers, and it
  // has a pace. 3: a playbook has a niche inside the main offer, its problem and proof, and something useful to send.
  // 4: a playbook's follow-ups are 5 to 7, each with its quiet days (no longer one number), and it has a video link.
  // 5: a playbook has its short video's script. 6: a partner playbook says which kinds of partner it looks for.
  // 7: a playbook runs on its own networks only; a customers' playbook saved before gets Facebook and LinkedIn, as it
  // ran on both. 8: a playbook has each network's own words (hashtags on Instagram, LinkedIn's post searches, kinds of
  // business on Alignable), whether it works with clients online, and which networks' words the AI wrote; empty on one
  // saved before.
  dataVersion: 8,
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
  // The business's main offer, built in core so other add-ons share it (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md).
  uses: ['main_offer', 'partners'],
  events: {
    emits: [
      'outreach.playbook.saved',
      'outreach.playbook.archived',
      'outreach.playbook.words_written',
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
      'outreach.lists.saved',
      'outreach.computer.renamed',
      'outreach.computer.removed',
      'outreach.need.noted',
      'outreach.need.cleared',
      'outreach.request.set_aside',
      'outreach.ask.made',
      'outreach.ask.started',
      'outreach.ask.progressed',
      'outreach.ask.replied',
      'outreach.ask.coded',
      'outreach.ask.cancelled',
      'outreach.ask.ended',
      'outreach.setup.saved',
      'outreach.readiness.saved',
      'outreach.check.looked',
      'outreach.check.saved',
      'outreach.checks.again',
      'outreach.stage.marked',
      'outreach.group.looked',
      'outreach.group.checked',
      'outreach.join.noted',
      'outreach.helpful.asked',
      'outreach.helpful.drafted',
      'outreach.helpful.oked',
      'outreach.helpful.skipped',
      'outreach.helpful.posted',
      'outreach.helpful.engaged',
      'outreach.engaged.saved',
      'outreach.country.unskipped',
      'outreach.country.decided',
      'outreach.partner.looked',
      'outreach.partner.saved',
      'outreach.partner.marked',
      'outreach.client.marked',
      'outreach.finds.saved',
      'outreach.later.marked',
      'outreach.friend.accepted',
      'outreach.lead.wanted',
      'outreach.lead.opened',
      'outreach.demo.decided',
    ],
    // The last part of a download, and chats read in Messenger, start the AI's read of the chats
    // (apps/worker/src/addons/outreach/chats.ts); group posts worth a look start its check of them (./posts.ts), and
    // friends and people chatted with, read off their pages, its check of whether they fit (./checks.ts), and a
    // group's About page, rules and posts its check of whether the business's people are there (./group-checks.ts).
    // A reply seen, or one handed over to the person (decision 27), pushes to their phone, and a change to the settings
    // moves the morning push (./alerts.ts) and the weekly report (./weekly.ts); a booking through a demo link counts as a demo (./demos.ts).
    // A Facebook warning pushes to the person's phone, and what the extension tells the app keeps the feed's pruning
    // armed (decision 41, ./live.ts). A message waiting for the person's OK, and a step the extension needs them for,
    // reach their phone as their pushes setting says (decision 40, ./waiting.ts). An ask that first needs the person
    // pushes to them at once (decision 43, ./asks.ts), and one waiting on a code from their email keeps a notification
    // up till the code comes, it ends, or the code runs out (decision 82). A post asking for what the business offers pushes to the person
    // who found it at once (decision 49, ./posts.ts). A helpful post asked for is written by the AI (decision 50,
    // ./helpful.ts). People found in a group or asking to be friends, and a change to the country setting, have the AI
    // work out where they live when the setting skips anyone (decision 61, ./countries.ts). Starting the day, or
    // saving one's settings, arms the day's report, and a new main offer tells whoever OK'd their messages against an
    // older one (decision 70, ./tracking.ts). Someone who could partner, read off their profile, waits for the AI's
    // partner check (decision 81, ./partners.ts). A playbook saved, a network turned on and the day started have the AI
    // write each network's own words for a customers' playbook that has none yet (decision 92, ./words.ts). Someone
    // accepting the person's friend request pushes to their phone, when they switched that on (decision 101, ./alerts.ts).
    // Someone who wants a demo, or answered the playbook's questions, goes in the main pipeline (decision 105, ./leads.ts);
    // once they came to the demo, their lead moves on and waits for the person's won or lost (decision 106).
    consumes: [
      'outreach.download.saved',
      'outreach.chats.collected',
      'outreach.posts.saved',
      'outreach.post.checked',
      'outreach.check.looked',
      'outreach.group.looked',
      'outreach.helpful.asked',
      'outreach.reply.seen',
      'outreach.send.queued',
      'addon.settings_saved',
      'appointment.booked',
      'outreach.warning.seen',
      'outreach.live.changed',
      'outreach.need.noted',
      'outreach.ask.progressed',
      'outreach.ask.coded',
      'outreach.ask.ended',
      'outreach.ask.cancelled',
      'outreach.group.saved',
      'outreach.friends.saved',
      'outreach.day.started',
      'outreach.automation.saved',
      'main_offer.published',
      'outreach.partner.looked',
      'outreach.playbook.saved',
      'outreach.friend.accepted',
      'outreach.lead.wanted',
      'appointment.completed',
    ],
  },
  jobs: [
    'outreach.read_chats',
    'outreach.check_posts',
    'outreach.check_people',
    'outreach.check_groups',
    'outreach.draft_helpful',
    'outreach.morning',
    'outreach.weekly',
    'outreach.live_prune',
    'outreach.waiting_push',
    'outreach.guess_countries',
    'outreach.day_report',
    'outreach.review',
    'outreach.check_partners',
    'outreach.write_words',
  ],
  // Who from the chats brought in goes in Contacts (./chat-read.ts), how long a sent request waits, the hour of the
  // morning push, the weekly report, and which countries it reaches: Social Outreach → Settings → General, For your
  // team, with each network's page for its own say.
  settings: { version: 1, permission: 'outreach.manage', workspace: OutreachSettingsSchema },
  // Its own tables, in `addon_outreach` (packages/core/src/addons/outreach/tables.ts mirrors them).
  tables: [
    'ask_codes',
    'asks',
    'automation',
    'checks',
    'computers',
    'days',
    'demos',
    'engagements',
    'file_chats',
    'file_people',
    'finds',
    'follow_ups',
    'friend_ends',
    'friends',
    'group_people',
    'groups',
    'helpful',
    'imports',
    'joins',
    'list_saves',
    'live_steps',
    'my_groups',
    'needs',
    'network_starts',
    'opener_uses',
    'partner_leads',
    'partner_searches',
    'partners',
    'playbooks',
    'posts',
    'profiles',
    'replies',
    'reviews',
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
    // A customer's Facebook profile and the chats saved with them; and how the main offer's live version is doing.
    slots: [
      { slot: 'person.panels', permission: 'outreach.use' },
      { slot: 'main_offer.panels', permission: 'outreach.use' },
    ],
    // The whole add-on on the phone, under More (decision 44): one page with the web's tabs (`?view=`), so the pushes'
    // links (`?view=waiting`, `live`, `today`) open the phone's screens; Settings' part (`?part=`, decision 73) and the
    // network shown (`?net=`) with them; the code an ask waits on (`?view=code&ask=`, decision 82); a group's own page
    // (`?view=groups&group=`, decision 103); and a playbook. The activity and friends stay on the web, and their links
    // open it.
    phone: [
      {
        path: '',
        query: ['view', 'part', 'for', 'net', 'show', 'tag', 'q', 'ask', 'group'],
        web: { view: ['activity', 'friends'] },
      },
      { path: 'playbooks/:playbookId' },
    ],
  },
  // Its tools are everything a person does on its screens (each operation's `ai`); what the browser extension and
  // the worker send in stays theirs (docs/outreach.md, "The Assistant").
  ai: {
    directory:
      'Facebook, LinkedIn and Instagram outreach with a browser extension: today’s list, messages to OK, friends, chats, groups, the pipeline, helpful posts, partners, playbooks and its settings. A yes to the first message gets the playbook’s short video, then the booking link; with no video, the link straight away',
  },
});
