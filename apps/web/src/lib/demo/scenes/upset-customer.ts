import { demoId } from '../world';
import {
  conversationIn,
  firstName,
  myFirstName,
  openConversation,
  replyAsMe,
  startConversation,
} from './kit';
import type { DemoScene } from './types';

/**
 * Scene 5: an upset customer texts. The AI teammate hears it, says sorry without making excuses or promises, and
 * hands her straight to you with a note on what happened. You take it and make it right yourself.
 */
const CONVERSATION = demoId(0x50001);
const PERSON = demoId(0x50002);
const UPSET = demoId(0x50011);
const HANDOFF = demoId(0x50012);
const MINE = demoId(0x50013);
const CALMER = demoId(0x50014);

const answer = (me: string) =>
  `Linda, this is ${me}, the owner. I’m so sorry. That’s on us, and you should have had a call. I can have a plumber there at 8:00 AM tomorrow, and there’s no charge for the visit. Does that work?`;

export const upsetCustomer: DemoScene = {
  id: 'upset-customer',
  number: 5,
  title: 'An upset customer goes straight to you',
  kind: 'teammate',
  startsOn: 'inbox',
  steps: [
    {
      label: 'Open the Inbox',
      voiceover: 'Some messages need a person. Watch what happens with this one.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Linda texts, and she’s not happy',
      voiceover:
        'Linda is not happy. The plumber was due between one and three, it’s half past four, and she took the afternoon off work.',
      change: (w, at) => {
        startConversation(w, at, {
          id: CONVERSATION,
          person: {
            id: PERSON,
            firstName: 'Linda',
            lastName: 'Park',
            phone: '+15125550174',
            city: 'Leander',
            tags: ['Customer'],
            customerSince: at - 400 * 24 * 3600_000,
          },
          firstId: UPSET,
          body: 'Your plumber was supposed to come between 1 and 3 today. It’s 4:30 and nobody showed up or even called. I took the afternoon off work for this!!',
        });
      },
      live: ['conversation', 'message'],
      run: (p) => openConversation(p, CONVERSATION),
    },
    {
      label: 'It hands her straight to you',
      voiceover:
        'Your AI teammate hears that she’s upset. It doesn’t argue or make promises. It says sorry, gets you, and leaves a note on what happened.',
      change: (w, at) => {
        const c = conversationIn(w, CONVERSATION);
        c.unread = 0;
        c.messages.push({
          id: HANDOFF,
          at,
          direction: 'outbound',
          teammate: true,
          handoffLine: true,
          body: `Linda, I’m so sorry. I’ve passed this straight to ${myFirstName(w)}, and they’ll reach out to you right away.`,
        });
        c.handoff = {
          since: at,
          reason: 'frustrated',
          note: 'Linda is upset: her visit today was set for 1 to 3 PM and nobody came or called. I said sorry and told her someone will reach out right away. I didn’t promise anything else.',
        };
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.waitFor('@handling-needs-person');
        await p.point('@handoff-why');
      },
    },
    {
      label: 'Tap Take it',
      voiceover: 'Tap Take it, and you’re in the conversation.',
      change: (w) => {
        const c = conversationIn(w, CONVERSATION);
        c.handoff = null;
        c.takenOver = true;
      },
      run: async (p) => {
        await p.click('@take-it');
        await p.waitFor('@handling-person');
      },
    },
    {
      label: 'Make it right in your own words',
      voiceover:
        'You make it right in your own words: an apology, a visit first thing tomorrow, and no charge.',
      change: (w, at) => {
        conversationIn(w, CONVERSATION).messages.push({
          id: MINE,
          at,
          direction: 'outbound',
          byMe: true,
          body: answer(myFirstName(w)),
        });
      },
      run: (p) => replyAsMe(p, answer(firstName(p.me.name))),
    },
    {
      label: 'Linda calms down',
      voiceover:
        'Linda calms down. The AI caught it in seconds, and the human touch saved the customer.',
      change: (w, at) => {
        conversationIn(w, CONVERSATION).messages.push({
          id: CALMER,
          at,
          direction: 'inbound',
          body: 'Thank you for owning it. 8 tomorrow works.',
        });
      },
      live: ['message', 'conversation'],
      run: (p) => p.point(`@message-${CALMER}`),
    },
  ],
};
