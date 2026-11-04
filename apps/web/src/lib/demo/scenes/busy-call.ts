import { businessOf, demoId, wallTime } from '../world';
import { conversationIn, dayName, daysUntil, openConversation, startConversation } from './kit';
import type { DemoScene } from './types';

/**
 * Scene 2: a call comes in while you're on a job. The AI teammate answers, gets the address, books Thursday and
 * texts the details; afterwards you read what was said and see the visit on the calendar.
 */
const CONVERSATION = demoId(0x20001);
const PERSON = demoId(0x20002);
const CALL = demoId(0x20011);
const CONFIRM = demoId(0x20012);
const VISIT = demoId(0x20031);

/** Thursday at 10:00 AM where the business is: the next one, never today. */
const thursday = (at: number, timeZone: string) =>
  wallTime(at, timeZone, daysUntil(at, timeZone, 4), 10);

export const busyCall: DemoScene = {
  id: 'busy-call',
  number: 2,
  title: 'A call comes in while you’re busy',
  kind: 'teammate',
  startsOn: 'inbox',
  // Past its training: it answers on its own, at any hour.
  setup: (w) => {
    w.teammateAutomatic = true;
  },
  steps: [
    {
      label: 'Open the Inbox',
      say: 'You’re under a sink across town. Your hands are full, and your phone is ringing.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Marcus calls about a leak',
      say: 'A new customer. Normally this goes to voicemail, and he calls the next plumber on Google.',
      change: (w, at) => {
        startConversation(w, at, {
          id: CONVERSATION,
          person: {
            id: PERSON,
            firstName: 'Marcus',
            lastName: 'Reed',
            phone: '+15125550163',
            city: 'Pflugerville',
            tags: [],
            customerSince: null,
          },
          firstId: CALL,
          body: '',
          call: { status: 'ringing', answeredByAi: true, seconds: null, transcript: null },
        });
      },
      live: ['conversation', 'message', 'call'],
      run: (p) => openConversation(p, CONVERSATION),
    },
    {
      label: 'Your AI teammate answers',
      say: 'It picks up on the second ring, in your business’s name.',
      change: (w) => {
        const c = conversationIn(w, CONVERSATION);
        c.unread = 0;
        c.messages[0]!.call!.status = 'in_progress';
      },
      live: ['message', 'call', 'conversation'],
      run: (p) => p.point(`@call-${CALL}`),
    },
    {
      label: 'It gets the address and books Thursday',
      say: 'It asked what’s wrong, took the address, and booked the first opening on your calendar.',
      change: (w, at) => {
        const c = conversationIn(w, CONVERSATION);
        const starts = thursday(at, w.state.timeZone);
        const call = c.messages[0]!.call!;
        call.status = 'completed';
        call.seconds = 167;
        call.transcript = [
          `${w.state.teammate}: Thanks for calling ${businessOf(w)}, this is ${w.state.teammate}. How can I help?`,
          'Marcus: Hi, the pipe under my kitchen sink is dripping. There’s a bucket under it, but it’s getting worse.',
          `${w.state.teammate}: Sorry to hear that. Is it a slow drip, or is water spraying?`,
          'Marcus: Just a steady drip.',
          `${w.state.teammate}: Okay, good. What’s the address?`,
          'Marcus: 418 Live Oak Lane, Pflugerville.',
          `${w.state.teammate}: Thanks. I can get a plumber out ${dayName(starts, w.state.timeZone)} at 10:00 AM. Does that work?`,
          'Marcus: Thursday at ten is perfect.',
          `${w.state.teammate}: You’re booked. I’ll text you the details now. Anything else?`,
          'Marcus: No, that’s it. Thanks!',
        ].join('\n');
        c.visits.push({
          id: VISIT,
          title: 'Kitchen sink leak',
          startsAt: starts,
          minutes: 90,
          bookedAt: at,
        });
      },
      live: ['message', 'call', 'conversation', 'appointment', 'activity'],
      run: async (p) => {
        await p.waitFor('@call-record-toggle');
        await p.point('@context-panel');
      },
    },
    {
      label: 'It texts Marcus the details',
      change: (w, at) => {
        const c = conversationIn(w, CONVERSATION);
        const starts = c.visits[0]!.startsAt;
        c.messages.push({
          id: CONFIRM,
          at,
          direction: 'outbound',
          teammate: true,
          body: `Hi Marcus, it’s ${w.state.teammate} with ${businessOf(w)}. You’re booked for ${dayName(starts, w.state.timeZone)} at 10:00 AM for the leak under your kitchen sink at 418 Live Oak Lane. Your plumber will text when they’re on the way.`,
        });
      },
      live: ['message', 'conversation'],
      run: (p) => p.point(`@message-${CONFIRM}`),
    },
    {
      label: 'Read what was said on the call',
      say: 'Every word of the call is kept, and the visit is already on your calendar. You never put down your wrench.',
      run: (p) => p.click('@call-record-toggle'),
    },
  ],
};
