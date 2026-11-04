import { businessOf, demoId, wallTime } from '../world';
import { conversationIn, openConversation, startConversation } from './kit';
import type { DemoScene } from './types';

/**
 * Scene 3: late at night, someone starts a chat on the business's website. The AI teammate answers in the chat,
 * gets her name and number, offers two times and books the one she picks, all while the shop is closed.
 */
const CONVERSATION = demoId(0x30001);
const PERSON = demoId(0x30002);
const VISITOR = demoId(0x30003);
const FIRST = demoId(0x30011);
const ASK = demoId(0x30012);
const GAVE = demoId(0x30013);
const OFFER = demoId(0x30014);
const PICKED = demoId(0x30015);
const BOOKED = demoId(0x30016);
const VISIT = demoId(0x30031);

const priya = (w: Parameters<typeof conversationIn>[0]) => conversationIn(w, CONVERSATION);

/** The business's website for the chat's header: its name as a plain .com, as a widget's site reads. */
const siteOf = (business: string) =>
  `${business
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')}.com`;

export const websiteChat: DemoScene = {
  id: 'website-chat',
  number: 3,
  title: 'A late-night website chat becomes a booked job',
  kind: 'teammate',
  startsOn: 'inbox',
  // Past its training: it answers on its own, at any hour.
  setup: (w) => {
    w.teammateAutomatic = true;
  },
  steps: [
    {
      label: 'Open the Inbox',
      voiceover: 'It’s twenty to midnight. The shop is dark, but your website is still working.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Someone starts a chat on your website',
      voiceover: 'A visitor on your drain cleaning page opens the chat and types a question.',
      change: (w, at) => {
        startConversation(w, at, {
          id: CONVERSATION,
          channel: 'chat',
          known: false,
          visitor: {
            id: VISITOR,
            name: 'Priya',
            site: siteOf(businessOf(w)),
            pagePath: '/services/drain-cleaning',
          },
          person: {
            id: PERSON,
            firstName: 'Priya',
            lastName: 'Shah',
            phone: '+15125550187',
            city: 'Cedar Park',
            tags: [],
            customerSince: null,
          },
          firstId: FIRST,
          body: 'Hi, my shower drain is backing up really bad. Do you guys do drain cleaning?',
        });
      },
      live: ['conversation', 'message'],
      run: (p) => openConversation(p, CONVERSATION),
    },
    {
      label: 'The AI teammate answers in seconds',
      voiceover:
        'No “we’ll get back to you in the morning.” Your AI teammate answers in seconds, while she’s still on your site, and asks for her name and number.',
      change: (w, at) => {
        const c = priya(w);
        c.unread = 0;
        c.messages.push({
          id: ASK,
          at,
          direction: 'outbound',
          teammate: true,
          body: `Hi! This is ${w.state.teammate} with ${businessOf(w)}. Yes, we clear shower drains. Sorry it’s backing up! What’s your name, and the best number to text you?`,
        });
      },
      live: ['message', 'conversation'],
      run: (p) => p.point(`@message-${ASK}`),
    },
    {
      label: 'Priya gives her name and number',
      voiceover: 'She gives her name and number, and asks if someone can come tomorrow morning.',
      change: (w, at) => {
        const c = priya(w);
        c.known = true;
        c.messages.push({
          id: GAVE,
          at,
          direction: 'inbound',
          body: 'Priya Shah, 512-555-0187. Could someone come tomorrow morning?',
        });
      },
      live: ['message', 'conversation', 'person'],
      run: (p) => p.point(`@message-${GAVE}`),
    },
    {
      label: 'It offers two times',
      voiceover: 'It checks your calendar and only offers times you really have open.',
      change: (w, at) => {
        priya(w).messages.push({
          id: OFFER,
          at,
          direction: 'outbound',
          teammate: true,
          body: 'Thanks, Priya! Tomorrow I have 8:00 AM or 10:30 AM. Which works better?',
        });
      },
      live: ['message', 'conversation'],
      run: (p) => p.point(`@message-${OFFER}`),
    },
    {
      label: 'She picks 8:00 AM',
      voiceover: 'She picks eight o’clock.',
      change: (w, at) => {
        priya(w).messages.push({ id: PICKED, at, direction: 'inbound', body: '8 please!' });
      },
      live: ['message', 'conversation'],
    },
    {
      label: 'It books the visit and texts her the details',
      voiceover:
        'It books the visit and texts her the details. Booked before midnight, and in the morning it’s just there on your calendar.',
      change: (w, at) => {
        const c = priya(w);
        const starts = wallTime(at, w.state.timeZone, 1, 8);
        c.messages.push({
          id: BOOKED,
          at,
          direction: 'outbound',
          teammate: true,
          body: 'You’re all set for tomorrow at 8:00 AM, Priya. We’ll text 512-555-0187 when your plumber is on the way. Good night!',
        });
        c.visits.push({
          id: VISIT,
          title: 'Drain cleaning',
          startsAt: starts,
          minutes: 60,
          bookedAt: at,
        });
      },
      live: ['message', 'conversation', 'appointment', 'activity'],
      run: async (p) => {
        await p.waitFor(`@message-${BOOKED}`);
        await p.point('@context-panel');
      },
    },
  ],
};
