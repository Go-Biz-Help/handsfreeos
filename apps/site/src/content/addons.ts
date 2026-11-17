/**
 * The add-ons on /add-ons, in early access (the owner, 17 November 2026: "All four" on the website changes).
 *
 * In the product each of these is still offered to nobody on its own (`development`, or `beta` for Real Estate, in
 * packages/core/src/addons/<id>/manifest.ts): HandsFreeOS staff hand one to a business from Admin → Businesses
 * (docs/addon-architecture.md, "Handing one out to try"). So the page offers early access that a person asks for,
 * never a button that installs one, and never says an add-on is included in the plan. Each card says what it costs a
 * month once it's out of early access (`addonPrices` in ./site.ts, the owner's picks of 2026-11-17).
 *
 * Every line is something the add-on does today. Keep them to what its doc says is built (docs/outreach.md,
 * docs/socialcontent.md, docs/salescoach.md, docs/realestate.md), and when one becomes `available`, change how it's
 * offered here too.
 */

import { addonPrices, addonTrialDays } from './site';

export type AddonCard = {
  /** The add-on's id in the product, and the anchor on the page. */
  readonly id: 'outreach' | 'socialcontent' | 'salescoach' | 'realestate';
  readonly name: string;
  /** Who it's for, in a few words. */
  readonly who: string;
  readonly summary: string;
  readonly points: readonly string[];
};

export const addonCards: readonly AddonCard[] = [
  {
    id: 'outreach',
    name: 'Social Outreach',
    who: 'For anyone who finds customers on social media',
    summary:
      'Finds the people you want to work with on Facebook, Instagram, LinkedIn, Alignable, Threads and X, warms them up, and starts real conversations for you.',
    points: [
      'Builds each day’s list of people who fit who you’re looking for, from the groups you’re in and what they post.',
      'Warms them up first, with a like, a follow or a helpful comment, before any message goes.',
      'Opens with a short, friendly introduction, not a pitch, then keeps the conversation going.',
      'Spots posts where someone asks for a recommendation, and points them to you or a good contact.',
      'Catches every reply, and offers real open times from your calendar when someone wants to talk.',
      'You OK the day’s list each morning, or turn on Autopilot.',
      'Finds partners too: people whose audience is the customers you want.',
      'Works through a Chrome extension you install once. Every person and chat lands in HandsFreeOS, on the web and the phone.',
    ],
  },
  {
    id: 'socialcontent',
    name: 'AI Social Media Content Creator',
    who: 'For any business that should be posting and isn’t',
    summary:
      'Finds the posts in your line of work that did far better than usual, works out why, and writes your own posts, with their pictures, two weeks ahead.',
    points: [
      'Finds creators in your niche and niches like it, and the posts that beat the posts around them.',
      'The AI works out why each one worked, the hook, the format and the idea, and keeps it in a playbook.',
      'Writes your posts for Facebook, Instagram, LinkedIn, Threads and X, each in that network’s own style.',
      'Makes the picture for each post, designed or photo-style, or uses your own photos and videos.',
      'Every post waits for your OK, one at a time or the whole week at once.',
      'Posts them for you at the right time, and learns from how your own posts do.',
    ],
  },
  {
    id: 'salescoach',
    name: 'AI Sales Coach',
    who: 'For anyone on your team who sells on the phone or on video',
    summary:
      'Listens to sales calls and tells your team what to say next, then writes the notes, the follow-up and a score.',
    points: [
      'Works on phone calls and HandsFreeOS video calls.',
      'Shows where the call is and the next question to ask, from your own scripts.',
      'Gives an answer the moment an objection comes up.',
      'Builds your scripts for you from a few questions about your business.',
      'On a video call it floats under your camera, so you never look like you’re reading.',
      'After the call: notes, a follow-up to send, tasks for what was promised, and a score.',
      'Shows each person’s trends over time, and lessons from the calls you win. Works in Spanish too.',
    ],
  },
  {
    id: 'realestate',
    name: 'Real Estate Agent',
    who: 'For real estate agents',
    summary:
      'Runs buyer and listing deals from the first meeting to the keys, with every duty, deadline and proof tracked.',
    points: [
      'Works out every deadline from the contract’s own dates, and warns you before anything slips.',
      'Keeps the proof that each duty was done, and the signed documents.',
      'Tours, offers side by side, inspections, repairs and financing, in one place.',
      'Listings with their own page, flyer, posts and open houses.',
      'A portal where buyers and sellers see where things stand.',
      'Ask the Assistant what could stop a closing.',
    ],
  },
];

/** What one add-on costs once it's out of early access, as its card says it. */
export const addonPriceLine = (id: AddonCard['id']): string =>
  `$${addonPrices[id]} a month after early access`;

/** How early access works, said once for every card. */
export const earlyAccess = {
  who: 'Founding members',
  price: 'Free while it’s in early access',
  later: `Once one is out of early access, it’s the monthly price on its card, for your whole business, with ${addonTrialDays} days free the first time you add it. We’ll tell you before anything changes.`,
  usage: 'The AI and texts they use come out of your usage balance, like everything else.',
} as const;
