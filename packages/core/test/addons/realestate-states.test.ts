/**
 * Where a deal and a duty stand (step 7), without a database: a deal moves forward to any later stage of its side and
 * back only through a named event; a listing ends as withdrawn, expired or cancelled and comes back on the market;
 * a duty's moves are the ones the plan names, and overdue is worked out, never stored.
 */
import { describe, expect, it } from 'vitest';
import {
  canMoveDuty,
  isOverdue,
  stageAfterEvent,
  stageMove,
  stagesBetween,
  stagesOf,
  underContract,
} from '../../src/addons/realestate/states';

describe('a deal’s stages', () => {
  it('runs each side in the specification’s order', () => {
    expect(stagesOf('buyer')).toHaveLength(15);
    expect(stagesOf('listing')).toHaveLength(19);
    expect(underContract('buyer', 'appraisal')).toBe(true);
    expect(underContract('buyer', 'possession')).toBe(false);
    expect(underContract('listing', 'offers')).toBe(false);
  });

  it('moves forward freely, and back only through an event', () => {
    expect(stageMove('buyer', 'lead', 'touring')).toBe('forward');
    expect(stageMove('buyer', 'touring', 'searching')).toBe('needs_event');
    expect(stageMove('buyer', 'lead', 'active')).toBe('invalid');
    expect(stageAfterEvent('buyer', 'offer_lost', 'negotiation')).toBe('touring');
    expect(stageAfterEvent('buyer', 'terminated', 'appraisal')).toBe('searching');
    expect(stageAfterEvent('buyer', 'terminated', 'searching')).toBeNull();
    expect(stageAfterEvent('listing', 'terminated', 'closing')).toBe('active');
    expect(stageAfterEvent('listing', 'expired', 'active')).toBe('expired');
    expect(stageAfterEvent('listing', 'back_on_market', 'expired')).toBe('active');
    expect(stageMove('listing', 'expired', 'active')).toBe('needs_event');
  });

  it('passes through every stage between two, so skipped stages still bring their duties', () => {
    expect(stagesBetween('buyer', 'searching', 'offer')).toEqual(['searching', 'touring', 'offer']);
  });
});

describe('a duty’s status', () => {
  it('moves only as the plan says, and reopens a finished one', () => {
    expect(canMoveDuty('draft', 'not_started')).toBe(true);
    expect(canMoveDuty('draft', 'completed')).toBe(false);
    expect(canMoveDuty('blocked', 'completed')).toBe(true);
    expect(canMoveDuty('completed', 'in_progress')).toBe(true);
    expect(canMoveDuty('cancelled', 'completed')).toBe(false);
  });

  it('is overdue only while open and past its due time', () => {
    const now = Date.parse('2026-10-30T15:00:00Z');
    const due = '2026-10-30T14:59:00Z';
    expect(isOverdue({ status: 'in_progress', dueAt: due }, now)).toBe(true);
    expect(isOverdue({ status: 'draft', dueAt: due }, now)).toBe(false);
    expect(isOverdue({ status: 'completed', dueAt: due }, now)).toBe(false);
    expect(isOverdue({ status: 'blocked', dueAt: null }, now)).toBe(false);
  });
});
