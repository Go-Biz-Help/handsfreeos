/**
 * The follow-up ladder's rules without a database: when the next one goes, how "Chase an offered time" moves the
 * first one sooner, which offered times a message named, and what the follow-up's turn tells the model.
 */
import { emptyTeammateConfig, type TeammateConfig } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import type { RunContext } from '../src/ai-team/context';
import {
  followsUp,
  nextFollowUpAt,
  offeredIn,
  offeredOf,
  type OfferedSlot,
  type Unanswered,
} from '../src/ai-team/nudges';
import { nudgeTurn } from '../src/ai-team/turns';

const H = 3_600_000;
const T0 = Date.parse('2026-09-22T15:00:00Z');
const config = (patch: Partial<TeammateConfig['followUp']> = {}): TeammateConfig => {
  const c = emptyTeammateConfig();
  return { ...c, followUp: { ...c.followUp, ...patch } };
};
const unanswered = (over: Partial<Unanswered> = {}): Unanswered => ({
  anchorAt: T0,
  anchorBody: 'Would Tuesday work for you?',
  sent: 0,
  neverWrote: false,
  ...over,
});
const slot = (at: number, label: string): OfferedSlot => ({
  calendarId: '00000000-0000-4000-8000-000000000001',
  startsAt: new Date(at).toISOString(),
  label,
  serviceId: null,
  durationMinutes: null,
});

describe('when follow-ups go', () => {
  it('follows the ladder from the message they didn’t answer, then monthly, then stops', () => {
    const c = config();
    expect(nextFollowUpAt(c, unanswered(), [], T0)).toBe(T0 + 4 * H);
    expect(nextFollowUpAt(c, unanswered({ sent: 1 }), [], T0)).toBe(T0 + 24 * H);
    expect(nextFollowUpAt(c, unanswered({ sent: 8 }), [], T0)).toBe(T0 + 720 * H);
    // Then monthly, six times.
    expect(nextFollowUpAt(c, unanswered({ sent: 9 }), [], T0)).toBe(T0 + (720 + 720) * H);
    expect(nextFollowUpAt(c, unanswered({ sent: 14 }), [], T0)).toBe(T0 + (720 + 6 * 720) * H);
    expect(nextFollowUpAt(c, unanswered({ sent: 15 }), [], T0)).toBeNull();
  });

  it('only starts after a question, and leaves a lead who never wrote alone when that row is off', () => {
    expect(followsUp(config(), unanswered({ anchorBody: 'Great, see you then.' }))).toBe(false);
    expect(followsUp(config(), unanswered())).toBe(true);
    expect(followsUp(config({ enabled: false }), unanswered())).toBe(false);
    expect(followsUp(config({ neverReplied: false }), unanswered({ neverWrote: true }))).toBe(
      false,
    );
    expect(followsUp(config({ neverReplied: false }), unanswered())).toBe(true);
  });

  it('chases offered times sooner: before the earliest, never within an hour of offering', () => {
    const c = config();
    // Tomorrow at 9: the 4-hour step comes first anyway.
    expect(nextFollowUpAt(c, unanswered(), [slot(T0 + 18 * H, '9:00 AM')], T0)).toBe(T0 + 4 * H);
    // In 5 hours: 3 hours before it.
    expect(nextFollowUpAt(c, unanswered(), [slot(T0 + 5 * H, '8:00 PM')], T0)).toBe(T0 + 2 * H);
    // In 2 hours: no sooner than an hour after the offer.
    expect(nextFollowUpAt(c, unanswered(), [slot(T0 + 2 * H, '5:00 PM')], T0)).toBe(T0 + H);
    // Chasing off, or not the first follow-up: the ladder as it is.
    expect(
      nextFollowUpAt(config({ chaseTimes: false }), unanswered(), [slot(T0 + 5 * H, 'x')], T0),
    ).toBe(T0 + 4 * H);
    expect(nextFollowUpAt(c, unanswered({ sent: 1 }), [slot(T0 + 5 * H, 'x')], T0)).toBe(
      T0 + 24 * H,
    );
  });

  it('keeps the times a message named, of those find_times showed', () => {
    const shown = [
      slot(T0 + 20 * H, 'Wed, Sep 23, 10:00 AM'),
      slot(T0 + 24 * H, 'Wed, Sep 23, 2:00 PM'),
      slot(T0 + 44 * H, 'Thu, Sep 24, 10:00 AM'),
    ];
    expect(offeredIn('I have Wednesday at 2 PM or 2:00 pm works too?', shown)).toEqual([shown[1]]);
    expect(offeredIn('Wednesday at 10:00 AM or 2:00 PM?', shown).map((s) => s.label)).toEqual([
      'Wed, Sep 23, 10:00 AM',
      'Wed, Sep 23, 2:00 PM',
      'Thu, Sep 24, 10:00 AM',
    ]);
    // Nothing named: all of them.
    expect(offeredIn('When suits you this week?', shown)).toHaveLength(3);
    // A payload's times, cleaned.
    expect(offeredOf([...shown, { calendarId: 1 }, 'x', null])).toEqual(shown);
    expect(offeredOf('nope')).toEqual([]);
  });
});

describe('the follow-up’s turn', () => {
  const rc = {
    workspace: { timeZone: 'America/Chicago' },
    history: [],
    lead: {
      id: 'l',
      title: 'AC install',
      stageName: 'New',
      pipelineId: 'p',
      assigneeUserId: null,
      qualification: {},
      cameInWith: 'message: Upstairs unit blowing warm air',
    },
  } as unknown as RunContext;
  const spec = {
    n: 1,
    lastAt: T0,
    total: 15,
    monthly: false,
    neverWrote: false,
    offered: [] as { label: string; startsAt: string; open: boolean }[],
  };
  const turn = (over: Partial<typeof spec>) => nudgeTurn(rc, { ...spec, ...over });

  it('says which follow-up it is, and goes light once the ladder is done', () => {
    const t = turn({});
    expect(t).toContain('follow-up 1 of 15');
    expect(t).not.toContain('no-pressure');
    expect(turn({ n: 12, monthly: true })).toContain('no-pressure');
  });

  it('writes a never-replied follow-up from what they sent', () => {
    const t = turn({ neverWrote: true });
    expect(t).toContain('<what_they_sent>');
    expect(t).toContain('Upstairs unit blowing warm air');
    expect(t).toContain('never answered your first message');
    expect(turn({})).not.toContain('<what_they_sent>');
  });

  it('offers the open times again, and never the gone ones', () => {
    const t = turn({
      offered: [
        { label: 'Wed 10:00 AM', startsAt: '', open: false },
        { label: 'Wed 2:00 PM', startsAt: '', open: true },
      ],
    });
    expect(t).toContain('Wed 10:00 AM: taken or past');
    expect(t).toContain('Wed 2:00 PM: still open');
    expect(t).toContain('Never offer a time that is taken or past');
    expect(turn({ offered: [{ label: 'Wed 10:00 AM', startsAt: '', open: false }] })).toContain(
      'Call find_times for new ones',
    );
  });
});
