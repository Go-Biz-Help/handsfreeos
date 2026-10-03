/**
 * Round six's words both apps show: a record on legal hold (board 93) and the business's check-in times (board 91).
 * Pure; the commands and queries behind them have their own tests.
 */
import { describe, expect, it } from 'vitest';
import { legalHoldBanner, legalHoldLine, safetyTimesLines, SAFETY_DEFAULTS } from '../src/index';

const year = new Date().getFullYear();
const hold = {
  placedAt: `${year}-10-01T15:00:00.000Z`,
  reason: 'Dispute over the earnest money',
  placedBy: { fullName: 'Dana Reyes' },
};

describe('a legal hold, in words', () => {
  it('says since when, why and who, as the board does', () => {
    expect(legalHoldBanner(hold, 'America/Chicago')).toEqual({
      title: 'On legal hold since Oct 1.',
      body: '“Dispute over the earnest money.” Placed by Dana Reyes. Its files and history can’t be changed or deleted until an owner or admin lifts it; new ones can be added.',
    });
    expect(legalHoldLine(hold, 'America/Chicago')).toBe(
      'Since Oct 1 · “Dispute over the earnest money.” · Dana Reyes',
    );
  });

  it('dates it where the business is, and keeps a reason’s own stop', () => {
    const late = { ...hold, placedAt: `${year}-10-02T03:00:00.000Z`, reason: 'Subpoena!' };
    expect(legalHoldBanner(late, 'America/Los_Angeles').title).toBe('On legal hold since Oct 1.');
    expect(legalHoldBanner(late, 'UTC').title).toBe('On legal hold since Oct 2.');
    expect(legalHoldLine(late, 'UTC')).toContain('“Subpoena!”');
  });

  it('leaves out what it doesn’t know', () => {
    const bare = { ...hold, reason: null, placedBy: null };
    expect(legalHoldBanner(bare, 'UTC').body).toBe(
      'Its files and history can’t be changed or deleted until an owner or admin lifts it; new ones can be added.',
    );
    expect(legalHoldLine(bare, 'UTC')).toBe('Since Oct 1');
  });
});

describe('the business’s check-in times, in words', () => {
  it('reads the defaults as My safety’s When does', () => {
    expect(safetyTimesLines(SAFETY_DEFAULTS)).toEqual([
      { label: 'Ask me after', value: '0 minutes' },
      { label: 'Then tell them after', value: '10 more minutes' },
      { label: 'Tell them again every', value: '10 minutes, for an hour' },
    ]);
  });

  it('says one minute as one', () => {
    const lines = safetyTimesLines({ askAfterMinutes: 1, alertAfterMinutes: 1, repeatMinutes: 5 });
    expect(lines.map((l) => l.value)).toEqual([
      '1 minute',
      '1 more minute',
      '5 minutes, for an hour',
    ]);
  });
});
