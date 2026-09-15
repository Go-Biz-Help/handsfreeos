import { describe, expect, it } from 'vitest';
import {
  cameInToday,
  nextLocalMidnight,
  readyToBook,
  repeatCustomer,
} from '../src/attention/index';
import { at, TZ } from './attention-fixtures';

/** What customers really write when they want to go ahead. */
const READY = [
  'Hi, can I book a tune-up for next week?',
  "I'd like to schedule an AC repair",
  'I’d like to book a duct cleaning',
  'How soon can someone come out? Our AC quit last night',
  'Are you available tomorrow morning?',
  'Can you guys come out today? House is 85 degrees',
  'Need someone to look at my furnace asap',
  "What's your earliest opening?",
  'Could I get a quote on a new 3 ton system?',
  'Looking for an estimate to replace our water heater',
  'When can you get someone over here?',
  'Do you have any openings this week?',
  'My AC is blowing warm air, need it fixed ASAP',
  'Can someone come by Thursday afternoon?',
  "Yes let's go ahead and set up a time",
  'Please send a tech, the unit is leaking water everywhere',
  'How much would it cost to replace the capacitor?',
  'Can we schedule the install for Monday?',
  'Is there any availability Saturday?',
  "I'm ready to move forward with the new system",
  "Can you fit me in tonight? Heat's out and we have a newborn",
  'hey do u have time tmrw to check my ac',
  'Want to get on the schedule for a maintenance visit',
  'Need a price for duct cleaning',
  'What times do you have open tomorrow?',
  'Can I get an appt this afternoon?',
  "We're interested in getting a new furnace installed before winter",
  'Our water heater needs to be replaced, when could someone come?',
  "Do you do same day service? It's really hot in here",
  'Can someone swing by and take a look at the thermostat?',
  'Sign me up for the maintenance plan',
  'Ok sounds good, lets get it scheduled',
];

/** What they write when they aren't ready, are already sorted, or are talking about something else. */
const NOT_READY = [
  'Thanks for the info!',
  'Do you service Georgetown?',
  'What brands do you carry?',
  'Not ready to schedule yet, just gathering info',
  'We went with another company, thanks anyway',
  'No need to come out, it started working again',
  "I'll call you tomorrow",
  'See you tomorrow!',
  'Can you send me a copy of my invoice?',
  'How much do I owe for the last visit?',
  'Stop texting me',
  'Who is this?',
  'Ok thanks',
  'My neighbor recommended you guys',
  'I already booked with someone else',
  'Is the technician still coming today?',
  'Never mind, we got it fixed',
  'Do you offer financing?',
  'Just curious what SEER rating the Trane units are',
  "Can't do tomorrow, I'll reach out next week",
  'The tech was great today, thank you!',
  'What are your hours?',
  'Please remove me from your list',
  'Got your voicemail, what is this about?',
  'Can you text my husband instead? His number is 512-555-0101',
  "It's working fine now, thanks for checking",
  'Can you email me the receipt?',
  'Is the Trane XR16 available in 4 ton?',
  'Feel free to call me tomorrow',
  'I booked for Thursday already, just confirming the time',
  "Don't need an estimate anymore, sold the house",
];

describe('readyToBook', () => {
  it('has a corpus of at least 30 each way', () => {
    expect(READY.length).toBeGreaterThanOrEqual(30);
    expect(NOT_READY.length).toBeGreaterThanOrEqual(30);
  });

  it.each(READY)('hears "%s" as ready to book', (text) => {
    expect(readyToBook(text)).toBe(true);
  });

  it.each(NOT_READY)('doesn’t hear "%s" as ready to book', (text) => {
    expect(readyToBook(text)).toBe(false);
  });

  it('reads nothing into nothing', () => {
    expect(readyToBook('')).toBe(false);
    expect(readyToBook('   ')).toBe(false);
    expect(readyToBook(null)).toBe(false);
    expect(readyToBook(undefined)).toBe(false);
  });
});

describe('repeatCustomer', () => {
  it('counts an earlier win or visit', () => {
    expect(repeatCustomer({ otherWonLeads: 0, pastVisits: 0 })).toBe(false);
    expect(repeatCustomer({ otherWonLeads: 1, pastVisits: 0 })).toBe(true);
    expect(repeatCustomer({ otherWonLeads: 0, pastVisits: 2 })).toBe(true);
  });
});

describe('cameInToday', () => {
  const morning = at('2026-09-15', '10:00');

  it('goes by the business’s calendar day, not UTC’s', () => {
    expect(cameInToday(at('2026-09-15', '00:10').toISOString(), TZ, morning)).toBe(true);
    // 9 PM in Chicago on the 14th is already the 15th in UTC.
    expect(cameInToday(at('2026-09-14', '21:00').toISOString(), TZ, morning)).toBe(false);
    expect(cameInToday(at('2026-09-14', '23:59').toISOString(), TZ, morning)).toBe(false);
  });

  it('stops counting at the next local midnight', () => {
    expect(nextLocalMidnight(morning, TZ)).toBe(at('2026-09-16', '00:00').getTime());
  });
});
