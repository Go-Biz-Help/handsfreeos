/**
 * Someone hot after a webinar on Home (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 5), without a database: a card
 * when the poll puts its hot ones on Home, or when the AI teammate couldn't text them; gone once someone writes or
 * calls, and after three days. It names the webinar and the points, and its button reaches the person.
 */
import { describe, expect, it } from 'vitest';
import {
  chipText,
  defaultAttentionSettings,
  DETECTORS,
  handleButtonOf,
  letHandleModeOf,
  letHandleRefusal,
  mayTakeAttentionAction,
  WEBINAR_HOT_DAYS,
  type WebinarHotFacts,
} from '../src/attention/index';
import { business, DAY, HOUR, NOW, ago, uid } from './attention-fixtures';

const settings = defaultAttentionSettings();
const d = DETECTORS.webinar_hot;
const facts = (over: Partial<WebinarHotFacts['lead']> = {}): WebinarHotFacts => ({
  business,
  lead: {
    id: uid(41),
    label: 'hot',
    followUp: 'home',
    outcome: null,
    scoredAt: ago(2 * HOUR),
    points: 42,
    what: 'Roofing webinar',
    contactedAt: null,
    personArchived: false,
    ...over,
  },
  openLead: null,
  assigneeUserId: null,
});

describe('webinar_hot', () => {
  it('asks someone to reach a hot one the poll puts on Home, or the AI teammate couldn’t text', () => {
    const found = d.detect(facts(), settings, NOW)!;
    expect(found).not.toBeNull();
    expect(found.urgentFrom).toBeNull();
    expect(
      chipText(
        found.reasons.find((c) => c.code === 'webinar')!,
        NOW,
      ),
    ).toBe('Roofing webinar · 42 points');
    expect(d.detect(facts({ followUp: 'text', outcome: 'card' }), settings, NOW)).not.toBeNull();
    // The AI teammate texted them, a text waits for an OK, or they couldn't be reached: no card.
    for (const outcome of ['sent', 'drafted', 'skipped', null] as const)
      expect(d.detect(facts({ followUp: 'text', outcome }), settings, NOW), String(outcome)).toBe(
        null,
      );
    expect(d.detect(facts({ followUp: 'list' }), settings, NOW)).toBeNull();
  });

  it('is only for hot ones, and goes once someone writes or calls, they’re archived, or three days pass', () => {
    expect(d.detect(facts({ label: 'warm' }), settings, NOW)).toBeNull();
    expect(d.detect(facts({ contactedAt: ago(HOUR) }), settings, NOW)).toBeNull();
    expect(d.detect(facts({ personArchived: true }), settings, NOW)).toBeNull();
    expect(WEBINAR_HOT_DAYS).toBe(3);
    const near = d.detect(facts({ scoredAt: ago(WEBINAR_HOT_DAYS * DAY - HOUR) }), settings, NOW)!;
    expect(near.recheckAt).toBe(ago(-HOUR));
    expect(d.detect(facts({ scoredAt: ago(WEBINAR_HOT_DAYS * DAY) }), settings, NOW)).toBeNull();
  });

  it('reaches them from Home, by a person, never handed to HandsFreeOS', () => {
    const item = {
      kind: 'webinar_hot' as const,
      title: 'Ann Lopez · Hot after Roofing webinar',
      reach: null,
      personId: uid(2),
      conversationId: null,
      reasons: [],
      callable: true,
    };
    expect(handleButtonOf(item, true)).toEqual({ label: 'Call Ann', icon: 'phone' });
    expect(handleButtonOf({ ...item, reach: 'email' as const }, false)).toEqual({
      label: 'Email Ann',
      icon: 'mail',
    });
    expect(letHandleModeOf('webinar_hot')).toBe('none');
    expect(letHandleRefusal('webinar_hot')).toBe(
      'Someone hot from your webinar hears from a person on the team.',
    );
    const member = { role: 'member' as const, permissions: null };
    for (const action of ['handle', 'assign', 'snooze', 'dismiss'] as const)
      expect(mayTakeAttentionAction(member, 'webinar_hot', action)).toBe(true);
    expect(mayTakeAttentionAction(member, 'webinar_hot', 'let_handle')).toBe(false);
  });
});
