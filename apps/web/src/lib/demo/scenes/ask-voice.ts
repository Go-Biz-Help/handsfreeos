import { businessOf, fullName, type DemoAnswer, type DemoWorld } from '../world';
import {
  askScene,
  customer,
  idsFor,
  lastCard,
  pageOf,
  PREPARING,
  ran,
  rangeWords,
  reply,
  textCard,
  textsSent,
} from './ask-kit';
import { answered, clock, myFirstName } from './kit';
import type { DemoScene } from './types';

/**
 * Scene 22: talk to it from the truck. You ask out loud what's next, it reads the answer back, and a spoken yes
 * sends the text it wrote. The player says the presenter's lines (`p.say`), so nothing is recorded.
 */

const MIN = 60_000;
const s22 = idsFor(22);
const WALT = customer(s22(1), 'Walt', 'Fisher', 2201, 'Pearland');
const QUESTION = 'What’s next today?';
const YES = 'Yes, send it.';
const HALF_HOUR = 30 * MIN;
/** His visit: the next half hour at least 40 minutes away, so there's time to drive there. */
const visitAt = (at: number) => Math.ceil((at + 40 * MIN) / HALF_HOUR) * HALF_HOUR;
const onMyWay = (w: DemoWorld, at: number) =>
  `Hi Walt, it’s ${myFirstName(w)} from ${businessOf(w)}. I’m on my way and should be there about ${clock(visitAt(at), w.state.timeZone)} for your water heater flush.`;

const answer = (w: DemoWorld, at: number): DemoAnswer => {
  const tz = w.state.timeZone;
  const start = visitAt(at);
  return {
    steps: ran('Looking at today', PREPARING),
    shows: [
      {
        type: 'appointment',
        appointmentId: s22(0x21),
        what: 'Water heater flush',
        customer: fullName(WALT),
        when: rangeWords(start, 60, tz),
        with: w.state.me.name,
        status: 'scheduled',
        href: pageOf(w, 'calendar'),
      },
    ],
    text: `Next is Walt Fisher’s water heater flush at ${clock(start, tz)}, in Pearland. Here’s a text telling him you’re on your way.`,
    cards: [textCard(s22(0x11), WALT, onMyWay(w, at))],
  };
};

export const talkFromTheTruck: DemoScene = askScene({
  id: 'talk-from-the-truck',
  number: 22,
  title: 'Talk to it from the truck',
  open: 'Hands on the wheel, between jobs. Open Ask HandsFreeOS. You don’t need to type a thing.',
  beats: [
    {
      step: {
        label: 'Say: what’s next today?',
        voiceover:
          'Tap the microphone and ask out loud what’s next. It finds your next job, reads it back to you, and writes the text to say you’re coming.',
        change: (w, at) => {
          const a = answer(w, at);
          for (const c of a.cards ?? []) w.cards[c.toolCallId] = c;
          w.answer = a;
          w.chat.push({ question: QUESTION, answer: a, at });
        },
        run: async (p) => {
          await p.say(QUESTION);
          await answered(p);
          await p.point(lastCard('confirm'));
        },
      },
    },
    {
      step: {
        label: 'Say yes',
        voiceover:
          'It asks if it should go ahead. Say yes, and the text is on its way. Your eyes never left the road.',
        change: (w, at) => {
          const waiting = (w.answer?.cards ?? []).map((c) => c.toolCallId);
          w.answer = null;
          w.confirmed.push(...waiting.filter((id) => !w.confirmed.includes(id)));
          textsSent(w, at, [
            { conversation: s22(0x31), message: s22(0x32), person: WALT, body: onMyWay(w, at) },
          ]);
        },
        live: ['conversation'],
        run: async (p) => {
          await p.say(YES);
          await p.point(`${lastCard('confirm')}[data-status="confirmed"]`);
        },
      },
    },
    reply({
      label: 'Walt writes back',
      voiceover: 'Walt writes back. The whole thing took one sentence and one word.',
      conversation: s22(0x31),
      message: s22(0x33),
      body: 'Great, thanks! I’ll leave the garage open for you.',
    }),
  ],
});
