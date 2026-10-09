/**
 * Social Outreach: its manifest (docs/outreach.md, docs/addon-architecture.md). Browser-safe: the screens, the API,
 * the worker, the extension and the AI all read it, so it holds no server code. Everything it declares starts with
 * its id, `outreach`.
 *
 * It's in `development`: offered nowhere, and installable only where HandsFreeOS staff hand it out to try. The
 * browser extension (apps/extension) connects only to businesses where it runs and the person holds `outreach.use`.
 */
import { defineAddon } from '../manifest';

export const outreachAddon = defineAddon({
  id: 'outreach',
  name: 'Social Outreach',
  summary:
    'Find and follow up with prospects on Facebook from a browser extension, with every person, chat and step kept in HandsFreeOS.',
  description:
    'A browser extension works beside you on Facebook: it saves the people you find and your chats with them to Contacts, and your playbooks say who you’re looking for, how you sound and which of your tags to use.',
  category: 'sales',
  version: '0.3.0',
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
    ],
  },
  // Its own tables, in `addon_outreach` (packages/core/src/addons/outreach/tables.ts mirrors them).
  tables: [
    'file_chats',
    'file_people',
    'friends',
    'groups',
    'imports',
    'playbooks',
    'profiles',
    'threads',
    'touches',
  ],
  ui: {
    // Its place in the side menu, shown only while it runs and to people who may open it.
    nav: [{ key: 'outreach', label: 'Social Outreach', icon: 'handshake', path: '' }],
    // A customer's Facebook profile and the chats saved with them.
    slots: [{ slot: 'person.panels', permission: 'outreach.use' }],
  },
  ai: {
    directory:
      'saves people and chats from facebook to contacts with a browser extension, guided by playbooks',
  },
});
