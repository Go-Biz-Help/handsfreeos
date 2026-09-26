/**
 * The trigger picker shows each event under one heading. It once grouped them by name and left seven out — the
 * AI teammate's hand-off, the money events and form answers — so a workflow could not be started from them by
 * hand, and a recipe that started from one showed an empty picker.
 */
import { describe, expect, it } from 'vitest';
import { TRIGGER_EVENT_GROUPS, TRIGGER_EVENT_KEYS } from '../src';

describe('the trigger picker’s headings', () => {
  it('put every event under exactly one heading', () => {
    const listed = TRIGGER_EVENT_GROUPS.flatMap((g) => g.events);
    expect(new Set(listed).size, 'an event is under two headings').toBe(listed.length);
    expect([...listed].sort()).toEqual([...TRIGGER_EVENT_KEYS].sort());
  });

  it('offers the money, form and hand-off events', () => {
    const listed = TRIGGER_EVENT_GROUPS.flatMap((g) => g.events);
    for (const e of [
      'ai_teammate.handed_off',
      'estimate.sent',
      'estimate.accepted',
      'estimate.declined',
      'invoice.paid',
      'invoice.overdue',
      'form.submitted',
    ] as const)
      expect(listed).toContain(e);
  });
});
