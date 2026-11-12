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
    'Finds creators in your niche whose posts beat their normal, works out why, and writes your own posts on a content calendar.',
  description:
    'It finds creators in your niche and niches like it who have done well, reads their posts back 12 months, and picks out the ones that did much better than the posts around them. Then the AI works out why each one worked, writes down the hooks, techniques and methods, and turns them into ideas for your own posts. Then it writes your posts, with their pictures, on a calendar two weeks ahead, each waiting for your OK.',
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
      'content calendar',
      'write my posts',
      'social media posts',
    ],
    exampleNeeds: [
      'find out what kind of posts do well in my niche',
      'give me ideas for what to post on Instagram',
      'study the creators in my industry',
      'write my social media posts for the next two weeks',
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
      id: 'socialcontent.posts',
      label: 'Your posts',
      description:
        'Your own posts, written by the AI with their pictures, on a calendar two weeks ahead, each waiting for your OK.',
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
        'See the creators, standout posts, the AI’s notes, the Playbook and content ideas, pick niches and creators to study, ask for them to be read again, and write, change and OK the business’s own posts.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: 'socialcontent.manage',
      label: 'Set up content research',
      description:
        'Pick the networks studied, whose computer reads them, whether the AI watches standout videos, and the calendar’s plan.',
      defaultRoles: ['admin'],
      requires: ['socialcontent.use'],
    },
  ],
  // Each of the business's own posts is a Social post record (part 8): its pictures are core files on it, and its
  // timeline, tasks and search work unchanged. Its migration makes the kind where the add-on was already on.
  recordKinds: [
    {
      key: 'socialcontent_post',
      singular: 'Social post',
      plural: 'Social posts',
      nameLabel: 'Title',
      icon: 'file',
      writePermission: 'socialcontent.use',
    },
  ],
  tables: ['content', 'creators', 'ideas', 'niches', 'playbook', 'posts', 'settings', 'work'],
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
      'socialcontent.content.written',
      'socialcontent.content.saved',
      'socialcontent.content.approved',
      'socialcontent.content.skipped',
      'socialcontent.content.pictured',
      'socialcontent.content.posting',
      'socialcontent.content.posted',
      'socialcontent.content.failed',
      'socialcontent.content.done_well',
      'socialcontent.content.read',
      'socialcontent.content.moved',
      'socialcontent.calendar.filled',
      'socialcontent.creators.picked',
    ],
    // A niche someone added: the AI writes the words to search each network for it. Posts saved with new
    // standouts: the AI notes them, and the Playbook and ideas follow. One of the business's own posts that did
    // well (part 11): the Playbook is written again with it. Fill on its own turned back on: the calendar fills now.
    // The main offer put live: the calendar fills now, since nothing is written until it is (pick 7b). Its own
    // posts' numbers read: AI picks learns the hours again, and moves the posts not up yet (decisions 25 to 27).
    // Setting up on its own (decisions 28 to 32) goes on when a search or profile read ends, the Playbook is
    // written, or the main offer's lists for content are saved.
    consumes: [
      'socialcontent.settings.saved',
      'socialcontent.niche.added',
      'socialcontent.posts.saved',
      'socialcontent.content.done_well',
      'socialcontent.content.read',
      'socialcontent.work.finished',
      'socialcontent.playbook.written',
      'main_offer.published',
      'main_offer.list_saved',
    ],
  },
  // Each studied creator read again once a week; new creators looked for once a month (decision 11); the AI's
  // notes on new standouts, a few at a time.
  // The calendar topped up once a week from the first fill (decision 18), and each post's pictures made. AI picks'
  // posts moved to the hours it learned (decision 27). Setting itself up, step by step, until it writes (decision 28).
  jobs: [
    'socialcontent.weekly',
    'socialcontent.monthly',
    'socialcontent.notes',
    'socialcontent.calendar',
    'socialcontent.pictures',
    'socialcontent.times',
    'socialcontent.setup',
  ],
  billing: { model: 'free' },
  // The business's main offer and its lists for content (docs/main-offer.md, "For your content"): every post and idea
  // is written from them, and none until the offer is live (the owner's picks, 11 Nov 2026).
  uses: ['main_offer'],
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
      {
        key: 'calendar',
        label: SOCIALCONTENT_PAGES.calendar,
        icon: 'calendar',
        path: 'calendar',
      },
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
      { path: 'calendar', query: ['post'] },
      { path: 'settings' },
    ],
  },
  ai: {
    directory:
      'social media content research: the niches searched, creators found and studied on Instagram, Facebook and LinkedIn (TikTok and YouTube later), their posts with how many times their normal each did, the standout posts with the AI’s notes on why each worked (and what it saw and heard watching Instagram videos), the Playbook of what works (for the creators and for the business’s own posts that did best), content ideas to save, use or skip, the business’s own posts on a content calendar two weeks ahead (written by the AI from the Playbook and saved ideas, with pictures designed by the AI or photo-style from the AI or the person’s own; each waits for an OK, or the week is OK’d in one go; a video post needs the person’s own video added; OK’d posts go up at their times on Facebook (profile and Page), LinkedIn and Instagram from the reading computer in Chrome with the extension, or now with Post it now; how each did about 2 and 7 days after it went up, and the ones that did well against the business’s own others in the Playbook), the calendar’s plan (posts a week on Instagram, Facebook and LinkedIn and the time), asking the reading computer to find, read or try watching now, and its settings (the networks, whose computer reads in Chrome with the HandsFreeOS Social extension, and watching videos, which uses more AI, the calendar’s plan, the Facebook Page and where Facebook posts go)',
    places: SOCIALCONTENT_PLACES,
    lookAlikes: SOCIALCONTENT_LOOK_ALIKES,
  },
});
