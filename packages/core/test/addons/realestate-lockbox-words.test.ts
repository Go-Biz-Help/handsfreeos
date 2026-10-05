/**
 * A listing's lockboxes in words (round seven, boards 94-95 and 98), the same on the web and the phone: each
 * lockbox's line, who opened one, and that none of it is ever the code.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCKBOX_KIND_CHOICES,
  LOCKBOX_KIND_KEYS,
  LOCKBOX_KIND_LABELS,
  LOCKBOX_WORDS,
  lockboxLine,
  openingLine,
  openingSource,
  openingWho,
} from '../../src/addons/realestate/lockbox-words';
import { LOCKBOX_KINDS } from '../../src/addons/realestate/schemas';

describe('lockboxes in words', () => {
  it('names every kind the server keeps', () => {
    expect([...LOCKBOX_KIND_KEYS]).toEqual([...LOCKBOX_KINDS]);
    for (const k of LOCKBOX_KINDS) {
      expect(LOCKBOX_KIND_LABELS[k]).toBeTruthy();
      expect(LOCKBOX_KIND_CHOICES[k]).toBeTruthy();
    }
  });

  it('words a lockbox’s line on the phone, with the code only as kept or not', () => {
    expect(
      lockboxLine({
        kindLabel: 'SentriLock',
        place: 'Front door',
        serial: '31-118204',
        hasCode: true,
      }),
    ).toEqual({ title: 'SentriLock · front door', detail: 'Serial 31-118204 · code kept locked' });
    expect(
      lockboxLine({ kindLabel: 'Combination lockbox', place: null, serial: null, hasCode: false }),
    ).toEqual({ title: 'Combination lockbox', detail: 'No code' });
  });

  it('says who opened one, and whether a showing was booked', () => {
    const ana = { openedBy: 'Ana Ruiz', company: 'Compass', booked: true };
    expect(openingWho(ana)).toBe('Ana Ruiz · Compass');
    expect(openingLine(ana)).toEqual({ who: 'Ana Ruiz', detail: 'Compass · fits a showing' });
    expect(openingLine({ openedBy: null, company: 'Keller Williams', booked: false })).toEqual({
      who: 'Keller Williams',
      detail: 'No showing booked',
    });
    expect(openingWho({ openedBy: null, company: null })).toBe('Someone');
    expect(openingSource('supra')).toBe('Supra’s email');
  });

  it('tells the phone the code never comes onto it', () => {
    expect(LOCKBOX_WORDS.phoneNever).toMatch(/never comes onto phones/);
    expect(LOCKBOX_WORDS.serialHint('SentriLock')).toBe(
      'How SentriLock’s emails are matched to this listing.',
    );
  });
});
