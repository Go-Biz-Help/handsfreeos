/**
 * AI Social Media Content Creator: its manifest (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md,
 * docs/socialcontent.md, docs/addon-architecture.md). Browser-safe: the screens, the API, the worker and the AI all
 * read it, so it holds no server code. Everything it declares starts with its id, `socialcontent`.
 *
 * It finds creators in the business's niche and niches like it, reads their posts back 12 months through the
 * HandsFreeOS Social extension (the same one Social Outreach uses), and picks out the posts that did at least 2 times
 * better than the posts around them. The AI's notes on why, the Playbook and the ideas come next.
 *
 * It's in `development`: offered nowhere, and installable only where HandsFreeOS staff hand it out to try.
 */
import { defineAddon } from '../manifest';
import { SOCIALCONTENT_LOOK_ALIKES, SOCIALCONTENT_PLACES } from './ai-places';
import { SOCIALCONTENT_PAGES } from './words';

export const socialcontentAddon = defineAddon({
  id: 'socialcontent',
  name: 'AI Social Media Content Creator',
  summary:
    'Finds creators in your niche whose posts beat their normal, works out why, and turns it into notes and ideas for your own content.',
  description:
    'It finds creators in your niche and niches like it who have done well, reads their posts back 12 months, and picks out the ones that did much better than the posts around them. Then the AI works out why each one worked, writes down the hooks, techniques and methods, and turns them into ideas for your own posts.',
  category: 'marketing',
  version: '0.1.0',
  // One more whenever its data changes shape; the worker brings each business's data up a step at a time
  // (apps/worker/src/addons/socialcontent/index.ts, `dataMigrations`).
  dataVersion: 1,
  catalog: {
    status: 'development',
    // The words someone uses when they need it: what recommendations and the AI's search match on.
    keywords: [
      'social media content',
      'content ideas',
      'content creator',
      'content research',
      'competitor content',
      'viral posts',
      'what to post',
      'instagram content',
      'content plan',
    ],
    exampleNeeds: [
      'find out what kind of posts do well in my niche',
      'give me ideas for what to post on Instagram',
      'study the creators in my industry',
    ],
    groups: ['Social Media', 'Content Marketing'],
  },
  capabilities: [
    {
      id: 'socialcontent.use',
      label: 'Content research',
      description:
        'Creators in your niche and niches like it, and their posts that beat their normal.',
      permission: 'socialcontent.use',
    },
    {
      id: 'socialcontent.manage',
      label: 'Content research settings',
      description: 'The networks studied, and whose computer reads them.',
      permission: 'socialcontent.manage',
    },
  ],
  // Exist only while it runs in a business. Its migration registers the same list (the parity test checks).
  permissions: [
    {
      key: 'socialcontent.use',
      label: 'Use AI Social Media Content Creator',
      description:
        'See the creators, standout posts and notes, pick niches and creators to study, and ask for them to be read again.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'socialcontent.manage',
      label: 'Set up content research',
      description: 'Pick the networks studied and whose computer reads them.',
      defaultRoles: ['admin'],
      requires: ['socialcontent.use'],
    },
  ],
  tables: ['creators', 'niches', 'posts', 'settings', 'work'],
  events: {
    emits: [
      'socialcontent.settings.saved',
      'socialcontent.niche.added',
      'socialcontent.niche.decided',
      'socialcontent.niches.suggested',
      'socialcontent.creator.added',
      'socialcontent.creator.decided',
      'socialcontent.creators.found',
      'socialcontent.creator.read',
      'socialcontent.posts.saved',
      'socialcontent.work.asked',
      'socialcontent.work.taken',
      'socialcontent.work.finished',
      'socialcontent.work.stopped',
    ],
    // A niche someone added: the AI writes the words to search each network for it.
    consumes: ['socialcontent.niche.added'],
  },
  // Each studied creator read again once a week; new creators looked for once a month (decision 11).
  jobs: ['socialcontent.weekly', 'socialcontent.monthly'],
  billing: { model: 'free' },
  ui: {
    // Its pages in the side menu, which pop out from its one row (the owner's decision, 2026-10-09).
    nav: [
      { key: 'creators', label: SOCIALCONTENT_PAGES.creators, icon: 'users', path: 'creators' },
      {
        key: 'standouts',
        label: SOCIALCONTENT_PAGES.standouts,
        icon: 'trending-up',
        path: 'standouts',
      },
      // Not `settings`: that key would put the page in Settings search, which opens it on the web.
      { key: 'gear', label: SOCIALCONTENT_PAGES.gear, icon: 'settings', path: 'settings' },
    ],
  },
  ai: {
    directory:
      'social media content research: the niches searched, creators found and studied on Instagram (Facebook, LinkedIn, TikTok and YouTube later), their posts with how many times their normal each did, the standout posts, asking the reading computer to find or read now, and its settings (the networks, and whose computer reads in Chrome with the HandsFreeOS Social extension)',
    places: SOCIALCONTENT_PLACES,
    lookAlikes: SOCIALCONTENT_LOOK_ALIKES,
  },
});
