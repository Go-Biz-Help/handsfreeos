/**
 * Real Estate Agent's rules in words (step 11): what the duty editor, the duty drawer and the Assistant say about when
 * a duty is due, what finishes it, what brings it and its reminders, for every duty on the list.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, resolveDuty } from '../../src/addons/realestate/catalog';
import {
  dayWords,
  dueRuleWords,
  dueWords,
  factsWords,
  proofRuleWords,
  remindersWords,
  trackerName,
  triggerWords,
} from '../../src/addons/realestate/rule-words';
import { dealHistoryWords, dutyLogWords } from '../../src/addons/realestate/history-words';

describe('Rules in words', () => {
  it('say when a duty is due', () => {
    expect(dueRuleWords({ kind: 'relative', to: 'closing', businessDays: -5 })).toBe(
      '5 business days before closing',
    );
    expect(dueRuleWords({ kind: 'relative', to: 'inspection_end', days: 0 })).toBe(
      'On inspection period ends',
    );
    expect(dueRuleWords({ kind: 'relative', to: 'closing', days: 1, at: '17:00' })).toBe(
      '1 day after closing at 5:00 PM',
    );
    expect(dueRuleWords({ kind: 'after_start', hours: 24 })).toBe('Within 24 hours of it starting');
    expect(dueRuleWords({ kind: 'every', days: 7 })).toBe('Every 7 days');
    expect(
      dueRuleWords({
        kind: 'earliest',
        of: [
          { kind: 'relative', to: 'closing', days: -3 },
          { kind: 'after_start', days: 10 },
        ],
      }),
    ).toBe('The earlier of 3 days before closing or within 10 days of it starting');
  });

  it('say what finishes it and what brings it', () => {
    expect(proofRuleWords(null)).toBe('Saying it’s done');
    expect(
      proofRuleWords({
        mode: 'all',
        items: [{ kind: 'document', documents: ['invoice'] }, { kind: 'note' }],
      }),
    ).toBe('An Invoice and a note of what was done');
    expect(triggerWords({ on: 'stage', stage: 'under_contract' })).toBe(
      'When the deal reaches Under contract',
    );
    expect(triggerWords({ on: 'dates', key: 'closing' })).toBe('When closing is confirmed');
    expect(remindersWords([1, 7, 3])).toBe('7, 3 and 1 days before');
    expect(remindersWords([])).toBe('No reminders');
    expect(factsWords(['hoa'])).toBe('Only when: has an HOA or condo association');
  });

  it('have words for every duty on the list', () => {
    for (const def of CATALOG) {
      const d = resolveDuty(def);
      expect(dueRuleWords(d.due), d.id).toMatch(/\S/);
      expect(proofRuleWords(d.proof), d.id).toMatch(/\S/);
      expect(trackerName(d.tracker), d.id).not.toBe(d.tracker);
    }
  });
});

describe('Due in words', () => {
  const tz = 'America/Chicago';
  const now = Date.parse('2026-09-30T15:00:00Z'); // Wed Sep 30, 10 am in Chicago
  it('say how soon, from where the business is', () => {
    expect(dueWords(null, tz, { now })).toBe('No deadline');
    expect(dueWords('2026-10-01T04:59:00Z', tz, { now })).toBe('due today');
    expect(dueWords('2026-10-02T04:59:00Z', tz, { now })).toBe('due tomorrow');
    expect(dueWords('2026-10-03T04:59:00Z', tz, { now })).toBe('due Fri');
    expect(dueWords('2026-10-15T04:59:00Z', tz, { now })).toBe('due Oct 14');
    expect(dueWords('2026-09-30T14:00:00Z', tz, { now })).toBe('overdue today');
    expect(dueWords('2026-09-28T04:59:00Z', tz, { now })).toBe('3 days overdue');
    expect(dueWords('2026-09-28T04:59:00Z', tz, { now, open: false })).toBe('due Sep 27');
    expect(dayWords('2027-01-04', tz, now)).toBe('Jan 4, 2027');
  });
});

describe('History in words', () => {
  it('say what changed on a deal and a duty', () => {
    expect(
      dealHistoryWords('stage', { stage: 'offer' }, { stage: 'under_contract', passed: [] }),
    ).toBe('Moved it from Offer to Under contract');
    expect(
      dealHistoryWords('term_confirmed', null, { key: 'closing', value: 'Oct 14, 2026' }),
    ).toBe('Confirmed closing: Oct 14, 2026');
    expect(dealHistoryWords('event', null, { events: ['inspection_report'] })).toBe(
      'Recorded that the inspection report is in',
    );
    expect(dutyLogWords('status', { status: 'not_started' }, { status: 'waiting_external' })).toBe(
      'Marked waiting on someone',
    );
    expect(dutyLogWords('completed_with_exception', null, null)).toBe(
      'Marked done without its proof',
    );
  });
});
