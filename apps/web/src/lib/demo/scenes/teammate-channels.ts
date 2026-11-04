import { businessOf, wallTime } from '../world';
import { idsFor } from './ask-kit';
import { conversationIn, openConversation } from './kit';
import {
  APPROVED,
  approveDraft,
  customerSays,
  draftReply,
  NEW_MESSAGE,
  newPerson,
  teammateSays,
} from './teammate-kit';
import type { DemoScene } from './types';

/**
 * The AI teammate answers wherever customers write: an email from a property manager (19), a Facebook ad lead on
 * Messenger (20) and an Instagram question about prices (21). Real Messenger and Instagram messages wait on Meta's
 * approval; the scenes play now.
 */

// ---------------------------------------------------------------------------------- 19. a property manager emails

const s19 = idsFor(19);
const DIANE = s19(1);
const DIANE_EMAIL = s19(11);
const ANSWER = s19(31);
const SUBJECT = 'Quote for 3 AC units at Westpark Townhomes';

export const propertyManagerEmail: DemoScene = {
  id: 'property-manager-email',
  number: 19,
  title: 'An email from a property manager',
  kind: 'teammate',
  startsOn: 'inbox',
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Your emails land in the same inbox as your texts and calls, and your AI teammate answers those too.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Diane emails for a quote on three units',
      voiceover:
        'Diane manages a group of townhomes. Three of them need new AC systems before summer. That’s a big job, and she’s probably emailed three companies.',
      change: (w, at) => {
        w.conversations.unshift({
          id: DIANE,
          person: newPerson(s19(2), 'Diane', 'Wexler', 1906, 'Houston', 'diane.wexler@example.com'),
          channel: 'email',
          createdAt: at,
          unread: 1,
          messages: [
            {
              id: DIANE_EMAIL,
              at,
              direction: 'inbound',
              subject: SUBJECT,
              body: 'Hello,\n\nI manage Westpark Townhomes on Briar Forest Dr. Three of our units need their AC systems replaced before summer. Could you send us a quote?\n\nThanks,\nDiane Wexler\nWestpark Property Management',
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, DIANE),
    },
    {
      label: 'It answers and asks the right questions',
      voiceover:
        'Your teammate answers within a minute. It asks what you’d need to know to price it right: the size and age of the systems, where the equipment is, and when you can walk the units.',
      change: (w, at) => {
        conversationIn(w, DIANE).unread = 0;
        draftReply(w, DIANE, {
          id: ANSWER,
          at,
          inReplyTo: DIANE_EMAIL,
          subject: `Re: ${SUBJECT}`,
          body: `Hi Diane,\n\nThanks for reaching out! We’d be glad to quote all three units. A few quick questions so the numbers are right:\n\n1. What size are the current systems, and about how old are they?\n2. Are the air handlers in the attics or in closets?\n3. When could we walk the units? We have openings tomorrow at 10:00 AM or 2:00 PM.\n\nOnce we’ve seen them, we’ll send one quote that covers all three.\n\nBest,\n${w.state.teammate}\n${businessOf(w)}`,
        });
      },
      live: ['ai_teammate_draft', 'conversation'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-text');
      },
    },
    {
      label: 'Approve: the email goes out',
      voiceover: 'It reads like you wrote it. Approve, and it’s sent from your business’s email.',
      change: (w, at) => {
        approveDraft(w, DIANE, ANSWER, s19(12), at);
        conversationIn(w, DIANE).openLead = {
          id: s19(3),
          title: 'Westpark Townhomes: 3 AC replacements',
          stage: 'New',
          valueCents: 2_850_000,
        };
      },
      live: [...APPROVED, 'lead'],
      run: (p) => p.click('@draft-approve'),
    },
    {
      label: 'It’s a lead on your pipeline',
      voiceover:
        'And Diane is already on your pipeline as a new lead, worth about twenty-eight thousand dollars. A job that size doesn’t get buried in your email.',
      run: async (p) => {
        await p.waitFor('@context-open-lead');
        await p.point('@context-open-lead');
      },
    },
  ],
};

// ------------------------------------------------------------------------------- 20. a Facebook ad lead on Messenger

const s20 = idsFor(20);
const BRANDON = s20(1);

export const messengerAdLead: DemoScene = {
  id: 'messenger-ad-lead',
  number: 20,
  title: 'A Facebook ad lead on Messenger',
  kind: 'teammate',
  startsOn: 'inbox',
  setup: (w) => {
    w.teammateAutomatic = true;
  },
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'You’re running a Facebook ad for an eighty-nine dollar furnace tune-up. Ads cost money, so every message from one needs an answer fast.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Brandon taps your ad and messages you',
      voiceover: 'Brandon sees the ad, taps Send message, and asks if you have anything this week.',
      change: (w, at) => {
        w.conversations.unshift({
          id: BRANDON,
          person: newPerson(s20(2), 'Brandon', 'Cole', 2014, 'Cypress'),
          channel: 'messenger',
          social: {
            name: 'Brandon Cole',
            username: null,
            ad: {
              name: 'Furnace tune-up $89, Houston',
              campaign: 'Fall furnace tune-ups',
              headline: 'Furnace tune-up, $89',
              body: 'Get your furnace ready before the first cold snap. Book a 21-point tune-up today.',
              at: at - 60_000,
            },
          },
          createdAt: at,
          unread: 1,
          messages: [
            {
              id: s20(11),
              at,
              direction: 'inbound',
              body: 'Hi! Saw your ad for the $89 furnace tune-up. Do you have anything this week?',
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, BRANDON),
    },
    {
      label: 'It answers in seconds with two times',
      voiceover: 'Your AI teammate answers on Messenger in seconds, and offers two times.',
      change: (w, at) => {
        conversationIn(w, BRANDON).unread = 0;
        teammateSays(w, BRANDON, {
          id: s20(12),
          at,
          body: `Hi Brandon, thanks for messaging ${businessOf(w)}! Yes, the $89 tune-up is still on. We can come tomorrow at 11:00 AM or 3:00 PM. Which works for you?`,
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s20(12)}`),
    },
    {
      label: 'Brandon picks 3:00 PM',
      voiceover: 'Brandon picks the afternoon and sends his address.',
      change: (w, at) => {
        customerSays(w, BRANDON, {
          id: s20(13),
          at,
          body: '3 works. I’m at 11820 Cypress Pine Ln.',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s20(13)}`),
    },
    {
      label: 'It books him',
      voiceover: 'And it books him, right there in Messenger. He’s on your calendar.',
      change: (w, at) => {
        const c = conversationIn(w, BRANDON);
        teammateSays(w, BRANDON, {
          id: s20(14),
          at,
          body: 'You’re all set for tomorrow at 3:00 PM at 11820 Cypress Pine Ln, Brandon. Our tech will message you when they’re on the way.',
        });
        c.visits.push({
          id: s20(21),
          title: 'Furnace tune-up',
          startsAt: wallTime(at, w.state.timeZone, 1, 15),
          minutes: 60,
          bookedAt: at,
        });
        c.openLead = {
          id: s20(3),
          title: 'Furnace tune-up',
          stage: 'Scheduled',
          valueCents: 8_900,
        };
      },
      live: [...NEW_MESSAGE, 'appointment', 'activity', 'lead'],
      run: (p) => p.point(`@message-${s20(14)}`),
    },
    {
      label: 'See which ad he came from',
      voiceover:
        'And you can see exactly which ad brought him in, and which campaign. So you know what your ad money is actually buying.',
      run: async (p) => {
        await p.waitFor('@attribution-section');
        await p.point('@attribution-section');
      },
    },
  ],
};

// --------------------------------------------------------------------------- 21. an Instagram message about prices

const s21 = idsFor(21);
const NATE = s21(1);
const PRICES = s21(31);
const BOOKING_LINK = 'https://app.handsfreeos.com/book/c/bright-path';

export const instagramPrices: DemoScene = {
  id: 'instagram-prices',
  number: 21,
  title: 'An Instagram message about prices',
  kind: 'teammate',
  startsOn: 'inbox',
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Instagram messages come into the same inbox too. No more checking three different apps on your phone.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Nate asks what a tune-up costs',
      voiceover: 'Nate sends a quick question from Instagram: how much is a tune-up?',
      change: (w, at) => {
        w.conversations.unshift({
          id: NATE,
          person: newPerson(s21(2), 'Nate', 'Romero', 2128, 'The Heights'),
          channel: 'instagram',
          social: { name: 'Nate Romero', username: 'nate.romero' },
          createdAt: at,
          unread: 1,
          messages: [
            {
              id: s21(11),
              at,
              direction: 'inbound',
              body: 'hey how much for an AC tune up? and do you guys do furnaces too',
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, NATE),
    },
    {
      label: 'It answers from your price list',
      voiceover:
        'Your teammate answers from your own price list, the one you gave it, so the prices are always yours. It even says which part of your knowledge it used.',
      change: (w, at) => {
        conversationIn(w, NATE).unread = 0;
        draftReply(w, NATE, {
          id: PRICES,
          at,
          inReplyTo: s21(11),
          body: `Hey Nate! An AC tune-up is $89, and yes, we do furnaces too: a furnace tune-up is also $89, or $149 for both on the same visit. Want to grab a time? You can book here: ${BOOKING_LINK}`,
          knowledge: ['Price list'],
        });
      },
      live: ['ai_teammate_draft', 'conversation'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-knowledge');
      },
    },
    {
      label: 'Approve: Nate gets the prices and a link',
      voiceover: 'Approve, and Nate has his answer and a link to book, seconds after asking.',
      change: (w, at) => {
        approveDraft(w, NATE, PRICES, s21(12), at);
      },
      live: APPROVED,
      run: (p) => p.click('@draft-approve'),
    },
    {
      label: 'Nate books both',
      voiceover:
        'He books both. A quick question on Instagram just turned into a two-for-one visit.',
      change: (w, at) => {
        customerSays(w, NATE, { id: s21(13), at, body: 'nice, just booked both for next week 👍' });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s21(13)}`),
    },
  ],
};

export const TEAMMATE_CHANNEL_SCENES: readonly DemoScene[] = [
  propertyManagerEmail,
  messengerAdLead,
  instagramPrices,
];
