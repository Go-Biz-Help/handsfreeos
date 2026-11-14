/**
 * Find a workspace for HandsFreeOS staff (support/business-words.ts): every business is searched only once there's
 * enough to search by, their own businesses aren't listed twice, and the Admin area is offered when more matched.
 */
import { describe, expect, it } from 'vitest';
import {
  SWITCHER_STAFF_SHOWN,
  SWITCHER_STAFF_WORDS,
  switcherStaffMatches,
  switcherStaffSearch,
} from '../src/index';

const row = (n: number) => ({ workspaceId: `ws-${n}`, name: `Business ${n}` });

describe('switcherStaffSearch', () => {
  it('searches every business from two letters, trimmed', () => {
    expect(switcherStaffSearch('')).toBeNull();
    expect(switcherStaffSearch('  b ')).toBeNull();
    expect(switcherStaffSearch(' bay ')).toBe('bay');
  });
});

describe('switcherStaffMatches', () => {
  it('leaves out the businesses already listed as theirs', () => {
    const out = switcherStaffMatches([row(1), row(2), row(3)], new Set(['ws-2']));
    expect(out.rows.map((r) => r.workspaceId)).toEqual(['ws-1', 'ws-3']);
    expect(out.more).toBe(false);
  });

  it('shows at most a handful, and says when the directory had more', () => {
    const found = Array.from({ length: SWITCHER_STAFF_SHOWN + 1 }, (_, i) => row(i));
    const out = switcherStaffMatches(found, new Set());
    expect(out.rows).toHaveLength(SWITCHER_STAFF_SHOWN);
    expect(out.more).toBe(true);
  });
});

describe('SWITCHER_STAFF_WORDS.line', () => {
  it('names the agency and how many people are in it', () => {
    expect(SWITCHER_STAFF_WORDS.line({ organizationName: 'Lone Star Group', memberCount: 1 })).toBe(
      'Lone Star Group · 1 person',
    );
    expect(SWITCHER_STAFF_WORDS.line({ organizationName: '', memberCount: 3 })).toBe('3 people');
  });
});
