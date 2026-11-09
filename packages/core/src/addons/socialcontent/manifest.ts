/**
 * AI Social Media Content Creator: its manifest (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md,
 * docs/socialcontent.md, docs/addon-architecture.md). Browser-safe: the screens, the API, the worker and the AI all
 * read it, so it holds no server code. Everything it declares starts with its id, `socialcontent`.
 *
 * It finds creators in the business's niche and niches like it, reads their posts back 12 months through the
 * HandsFreeOS Social extension (the same one Social Outreach uses), and picks out the posts that did at least 2 times
 * better than the posts around them. The AI notes why each one worked (and, when an owner turns it on, watches the
 * videos), writes the Playbook from its notes, and suggests ideas for the business's own posts.
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
      description:
        'The networks studied, whose computer reads them, and whether the AI watches standout videos.',
      permission: 'socialcontent.manage',
    },
  ],
  // Exist only while it runs in a business. Its migration registers the same list (the parity test checks).
  permissions: [
    {
      key: 'socialcontent.use',
      label: 'Use AI Social Media Content Creator',
      description:
        'See the creators, standout posts, the AI’s notes, the Playbook and content ideas, pick niches and creators to study, and ask for them to be read again.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'socialcontent.manage',
      label: 'Set up content research',
      description:
        'Pick the networks studied, whose computer reads them, and whether the AI watches standout videos.',
      defaultRoles: ['admin'],
      requires: ['socialcontent.use'],
    },
  ],
  tables: ['creators', 'ideas', 'niches', 'playbook', 'posts', 'settings', 'work'],
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
      'socialcontent.work.progressed',
      'socialcontent.work.stopped',
      'socialcontent.post.noted',
      'socialcontent.post.watched',
      'socialcontent.playbook.written',
      'socialcontent.ideas.added',
      'socialcontent.idea.decided',
    ],
    // A niche someone added: the AI writes the words to search each network for it. Posts saved with new
    // standouts: the AI notes them, and the Playbook and ideas follow.
    consumes: ['socialcontent.niche.added', 'socialcontent.posts.saved'],
  },
  // Each studied creator read again once a week; new creators looked for once a month (decision 11); the AI's
  // notes on new standouts, a few at a time.
  jobs: ['socialcontent.weekly', 'socialcontent.monthly', 'socialcontent.notes'],
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
      { key: 'playbook', label: SOCIALCONTENT_PAGES.playbook, icon: 'book-open', path: 'playbook' },
      { key: 'ideas', label: SOCIALCONTENT_PAGES.ideas, icon: 'lightbulb', path: 'ideas' },
      // Not `settings`: that key would put the page in Settings search, which opens it on the web.
      { key: 'gear', label: SOCIALCONTENT_PAGES.gear, icon: 'settings', path: 'settings' },
    ],
    // On the phone too (part 5): its first screen lists the pages, and Standouts keeps to a network or a creator.
    phone: [
      { path: '' },
      { path: 'creators' },
      { path: 'standouts', query: ['network', 'creator'] },
      { path: 'playbook' },
      { path: 'ideas' },
      { path: 'settings' },
    ],
  },
  ai: {
    directory:
      'social media content research: the niches searched, creators found and studied on Instagram, Facebook and LinkedIn (TikTok and YouTube later), their posts with how many times their normal each did, the standout posts with the AI’s notes on why each worked (and what it saw and heard watching Instagram videos), the Playbook of what works, content ideas to save, use or skip, asking the reading computer to find, read or try watching now, and its settings (the networks, whose computer reads in Chrome with the HandsFreeOS Social extension, and watching videos, which uses more AI)',
    places: SOCIALCONTENT_PLACES,
    lookAlikes: SOCIALCONTENT_LOOK_ALIKES,
  },
});
