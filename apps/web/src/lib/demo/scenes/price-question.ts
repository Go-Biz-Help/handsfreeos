import { demoId } from '../world';
import { conversationIn, myFirstName, openConversation, replyAsMe, startConversation } from './kit';
import type { DemoScene } from './types';

/**
 * Scene 4: a customer asks for a price that isn't in the business's Knowledge. The AI teammate doesn't guess: it
 * tells him someone will get back to him, and hands the conversation to you with a note. You take it and answer.
 */
const CONVERSATION = demoId(0x40001);
const PERSON = demoId(0x40002);
const ASKED = demoId(0x40011);
const HANDOFF = demoId(0x40012);
const MINE = demoId(0x40013);
const THANKS = demoId(0x40014);

const ANSWER =
  'Hi Tom, for your house a tankless water heater installed is $3,850. That includes the permit and hauling away the old tank. Want me to send you an estimate?';

export const priceQuestion: DemoScene = {
  id: 'price-question',
  number: 4,
  title: 'A price question goes to you',
  kind: 'teammate',
  startsOn: 'inbox',
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Not every question should be answered by an AI. Here’s one it knows to hand to you.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Tom asks what a tankless water heater costs',
      voiceover:
        'Tom, a customer you’ve worked for before, wants a price on a big job: swapping his old tank water heater for a tankless one.',
      change: (w, at) => {
        startConversation(w, at, {
          id: CONVERSATION,
          person: {
            id: PERSON,
            firstName: 'Tom',
            lastName: 'Alvarez',
            phone: '+15125550129',
            city: 'Georgetown',
            tags: ['Customer'],
            customerSince: at - 2 * 365 * 24 * 3600_000,
          },
          firstId: ASKED,
          body: 'Hey, how much would it be to swap my old tank water heater for a tankless one?',
        });
      },
      live: ['conversation', 'message'],
      run: (p) => openConversation(p, CONVERSATION),
    },
    {
      label: 'It doesn’t guess: it hands it to you',
      voiceover:
        'Your price list doesn’t cover that, so your teammate won’t make a number up. It tells Tom you’ll get back to him shortly, and leaves you a note saying why.',
      change: (w, at) => {
        const c = conversationIn(w, CONVERSATION);
        c.unread = 0;
        c.messages.push({
          id: HANDOFF,
          at,
          direction: 'outbound',
          teammate: true,
          handoffLine: true,
          body: `Good question, Tom! Price depends on your setup, so I’ve asked ${myFirstName(w)} to get you an exact number. You’ll hear back shortly.`,
        });
        c.handoff = {
          since: at,
          reason: 'cant_answer',
          note: 'Tom wants a price to replace his tank water heater with a tankless one. Your Knowledge has no price for that, so I didn’t guess.',
        };
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.waitFor('@handling-needs-person');
        await p.point('@handoff-note');
      },
    },
    {
      label: 'Tap Take it',
      voiceover: 'Tap Take it, and the conversation is yours.',
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
      label: 'Text Tom the price yourself',
      voiceover:
        'You text Tom the price in your own words. Your teammate stays quiet until you hand it back.',
      change: (w, at) => {
        conversationIn(w, CONVERSATION).messages.push({
          id: MINE,
          at,
          direction: 'outbound',
          byMe: true,
          body: ANSWER,
        });
      },
      run: (p) => replyAsMe(p, ANSWER),
    },
    {
      label: 'Tom says yes',
      voiceover:
        'Tom says yes. The AI handled the easy part, and the money conversation stayed with you.',
      change: (w, at) => {
        conversationIn(w, CONVERSATION).messages.push({
          id: THANKS,
          at,
          direction: 'inbound',
          body: 'Yes please, send it over. Thanks for getting back so quick!',
        });
      },
      live: ['message', 'conversation'],
      run: (p) => p.point(`@message-${THANKS}`),
    },
  ],
};
