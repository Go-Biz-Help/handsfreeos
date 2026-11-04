import { businessOf, demoId, wallTime, type DemoConversation, type DemoWorld } from '../world';
import type { DemoScene } from './types';

/**
 * Scene 1: a new customer texts in the evening. The AI teammate answers in seconds with two times, you tap
 * Approve (it's still in training, so it asks first), she picks one, and it books the visit.
 */
const CONVERSATION = demoId(0x10001);
const PERSON = demoId(0x10002);
const FIRST_TEXT = demoId(0x10011);
const OFFER = demoId(0x10021);
const OFFER_SENT = demoId(0x10012);
const PICKED = demoId(0x10013);
const BOOK = demoId(0x10022);
const BOOK_SENT = demoId(0x10014);
const VISIT = demoId(0x10031);

const dana = (w: DemoWorld): DemoConversation => {
  const c = w.conversations.find((x) => x.id === CONVERSATION);
  if (!c) throw new Error('Dana’s conversation is missing.');
  return c;
};

export const leadText: DemoScene = {
  id: 'lead-text',
  number: 1,
  title: 'A new lead texts after hours',
  kind: 'teammate',
  startsOn: 'inbox',
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'It’s evening. You’ve closed up for the day and you’re at dinner with your family. This is your HandsFreeOS inbox, where every text, call and chat lands.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Dana texts: her water heater is leaking',
      voiceover:
        'A text comes in from someone you’ve never worked with. Her water heater is leaking all over the garage, and nobody at the shop is there to answer.',
      change: (w, at) => {
        w.conversations.unshift({
          id: CONVERSATION,
          person: {
            id: PERSON,
            firstName: 'Dana',
            lastName: 'Whitfield',
            phone: '+15125550142',
            city: 'Round Rock',
            tags: [],
            customerSince: null,
          },
          createdAt: at,
          unread: 1,
          messages: [
            {
              id: FIRST_TEXT,
              at,
              direction: 'inbound',
              body: 'Hi, my water heater is leaking all over the garage floor. Can someone come out tomorrow? This is Dana on Oak Hollow Dr.',
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.point(`@conversation-row-${CONVERSATION}`);
      },
    },
    {
      label: 'Open Dana’s text',
      voiceover:
        'Normally a text like this waits until morning. By then, she’s called someone else.',
      change: (w) => {
        dana(w).unread = 0;
      },
      run: async (p) => {
        await p.click(`@conversation-row-${CONVERSATION}`);
        await p.waitFor('@conversation');
      },
    },
    {
      label: 'The AI teammate writes back with two times',
      voiceover:
        'Your AI teammate has already written back. It tells her how to shut the water off and offers two real times from your calendar. While it’s still learning your business, it asks you before anything goes out.',
      change: (w, at) => {
        dana(w).drafts.push({
          id: OFFER,
          at,
          status: 'pending',
          inReplyTo: FIRST_TEXT,
          body: `Hi Dana, this is ${w.state.teammate} with ${businessOf(w)}. So sorry about the leak! If you can, turn the cold water valve on top of the heater to off. We can be there tomorrow at 9:00 AM or 1:00 PM. Which works better?`,
        });
      },
      live: ['ai_teammate_draft'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-approve');
      },
    },
    {
      label: 'Tap Approve: the text goes to Dana',
      voiceover: 'One tap from your phone, and the text is on its way to Dana.',
      change: (w, at) => {
        const c = dana(w);
        const d = c.drafts.find((x) => x.id === OFFER)!;
        d.status = 'approved';
        d.decidedAt = at;
        c.messages.push({
          id: OFFER_SENT,
          at,
          direction: 'outbound',
          body: d.body,
          teammate: true,
          approved: true,
          draftId: d.id,
        });
      },
      live: ['ai_teammate_draft', 'message', 'conversation'],
      run: (p) => p.click('@draft-approve'),
    },
    {
      label: 'Dana picks 9:00 AM',
      voiceover:
        'A minute later, Dana writes back. Nine o’clock works, and she’s shut the valve off.',
      change: (w, at) => {
        dana(w).messages.push({
          id: PICKED,
          at,
          direction: 'inbound',
          body: '9 works! Thank you so much. I shut the valve off.',
        });
      },
      live: ['message', 'conversation'],
    },
    {
      label: 'It books the visit, and asks you first',
      voiceover:
        'Your teammate writes the confirmation. The line above the text says what approving does: it books the visit on your calendar.',
      change: (w, at) => {
        dana(w).drafts.push({
          id: BOOK,
          at,
          status: 'pending',
          inReplyTo: PICKED,
          body: 'You’re all set for tomorrow at 9:00 AM, Dana. Our tech will text you when they’re on the way. Thanks for shutting the valve off!',
          book: {
            startsAt: wallTime(at, w.state.timeZone, 1, 9),
            minutes: 120,
            summary: 'Book a water heater repair, tomorrow at 9:00 AM',
          },
        });
      },
      live: ['ai_teammate_draft'],
      run: async (p) => {
        await p.waitFor('@draft-action');
        await p.point('@draft-action');
      },
    },
    {
      label: 'Approve: the visit is booked and Dana gets the text',
      voiceover:
        'Approve, and it’s done. The visit is on your calendar and on her record, and Dana knows exactly when you’re coming. All of that happened while you were at dinner.',
      change: (w, at) => {
        const c = dana(w);
        const d = c.drafts.find((x) => x.id === BOOK)!;
        d.status = 'approved';
        d.decidedAt = at;
        c.messages.push({
          id: BOOK_SENT,
          at,
          direction: 'outbound',
          body: d.body,
          teammate: true,
          approved: true,
          draftId: d.id,
        });
        c.visits.push({
          id: VISIT,
          title: 'Water heater repair',
          startsAt: d.book!.startsAt,
          minutes: d.book!.minutes,
          bookedAt: at,
        });
      },
      live: ['ai_teammate_draft', 'message', 'conversation', 'appointment', 'activity'],
      run: (p) => p.click('@draft-approve'),
    },
  ],
};
