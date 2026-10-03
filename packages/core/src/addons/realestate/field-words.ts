/**
 * Round six's words for what happens in the field (boards 89 and 90): a deal's field notes and its final walkthrough,
 * as both apps list them. Browser-safe; the notes and the list are ops/field.ts and walkthrough.ts.
 */
import type { FIELD_NOTE_ABOUT } from './schemas';

type About = (typeof FIELD_NOTE_ABOUT)[number];
type ItemSource = 'repair' | 'included' | 'excluded' | 'finding' | 'room' | 'added';
type ItemState = 'unchecked' | 'ok' | 'not_ok' | 'unsure';

/** What a note was taken about, under it. */
export const FIELD_NOTE_ABOUT_WORDS: Readonly<Record<About, string>> = {
  deal: 'On the deal',
  home: 'About a home',
  tour_stop: 'At a tour stop',
  showing: 'At a showing',
  open_house: 'At an open house',
  walkthrough: 'At the walkthrough',
};

export const FIELD_NOTE_WORDS = {
  title: 'Field notes',
  about:
    'Typed, said or photographed on the phone at a showing, a tour or the walkthrough. Notes are added from the phone app.',
  said: 'Said',
  recording: 'Play the recording',
  waiting: 'Turning the recording into words…',
  failed: 'The recording couldn’t be turned into words. Play it to hear it.',
  photos: (n: number) => (n === 1 ? '1 photo' : `${n} photos`),
  more: (n: number) => `Show all ${n}`,
  fewer: 'Show fewer',
} as const;

/** The walkthrough's list, grouped as it's walked. */
export const WALKTHROUGH_SOURCE_WORDS: Readonly<Record<ItemSource, string>> = {
  repair: 'Repairs agreed',
  included: 'Items that stay',
  excluded: 'Items that go',
  finding: 'From the inspection',
  room: 'Rooms',
  added: 'Added on the day',
};

/** How each thing on it was. */
export const WALKTHROUGH_ITEM_WORDS: Readonly<Record<ItemState, string>> = {
  ok: 'OK',
  not_ok: 'Not right',
  unsure: 'Not sure',
  unchecked: 'Not checked',
};

export const WALKTHROUGH_WORDS = {
  title: 'Final walkthrough',
  states: { planned: 'Planned', started: 'Under way', done: 'Done' },
  dutyAdded: 'A duty to fix it before closing',
  clientsAgreed: 'The clients said it’s as agreed',
  checkedOnPhone: 'Checked on the phone, with or without signal.',
  all: (n: number) => `Show all ${n}`,
  fewer: 'Show fewer',
} as const;
