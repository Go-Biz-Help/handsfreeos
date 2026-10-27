/**
 * Social Outreach's shared words (src/addons/outreach/words.ts), which the web and the phone both say: the parts the
 * web links or shows on their own read the same as the phone's whole sentence, and where Today's Open goes
 * (src/addons/outreach/network-words.ts). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { todayOpenOf } from '../../src/addons/outreach/network-words';
import { sameNamePeople, OUTREACH_WORDS as W } from '../../src/addons/outreach/words';

describe('Social Outreach’s shared words', () => {
  it('says how fast only for the steps a playbook takes', () => {
    expect(W.pace(2, 6)).toBe(
      'First message 2 days after they accept. 6 follow-ups until they answer, then a check-in each month.',
    );
    expect(W.pace(0, null)).toBe('First message the day they accept.');
    expect(W.pace(null, 5)).toBe('5 follow-ups until they answer, then a check-in each month.');
    expect(W.pace(null, null)).toBe('');
  });

  it('puts the note on sending together from the parts the web links', () => {
    expect(W.sendingOff(true)).toBe(`${W.sendingOffNote} ${W.changeThatIn} ${W.rows.settings}.`);
    expect(W.sendingOff(false)).toBe(`${W.sendingOffNote} ${W.askToSend}`);
    // An owner or admin, when the business allows only Off: where they allow it, never "ask an owner".
    expect(W.sendingOff(false, true)).toBe(
      `${W.sendingOffNote} ${W.allowForTeamIn} ${W.settingsGeneral}.`,
    );
    expect(W.sendingOff(true, true)).toBe(W.sendingOff(true));
  });

  it('says the same of a team member’s computer and of a group, everywhere', () => {
    expect(W.teamComputer(null, null)).toBe('No computer yet');
    expect(W.teamComputer('Dana’s laptop', '2:14 PM')).toBe('Dana’s laptop · 2:14 PM');
    expect(W.teamNone).toBe(`${W.teamNoneTitle}.`);
    expect(W.groupLine(1200, 1, true)).toBe(
      `${W.groupMembers(1200)} · ${W.peopleSaved(1)} · ${W.joined}`,
    );
    expect(W.peopleSaved(1)).toBe('1 person saved');
    expect(W.countOf(1200, 2000)).toBe('1,200 of 2,000');
  });

  it('offers first only the same-named customers without a profile of their own, told apart', () => {
    const person = (n: number, hasProfile: boolean, email: string | null) => ({
      personId: `00000000-0000-4000-8000-00000000000${n}`,
      name: 'Dana Reyes',
      email,
      phone: n === 2 ? '(512) 555-0100' : null,
      source: 'Website',
      createdAt: '2026-03-02T15:00:00.000Z',
      hasProfile,
    });
    const found = {
      sameName: [
        {
          people: [
            person(1, false, 'dana@example.com'),
            person(2, false, null),
            person(3, true, null),
          ],
        },
      ],
    };
    expect(sameNamePeople(found, { withoutProfile: true })).toEqual([
      {
        personId: person(1, false, null).personId,
        name: 'Dana Reyes',
        detail: 'dana@example.com · Website · added Mar 2, 2026',
      },
      {
        personId: person(2, false, null).personId,
        name: 'Dana Reyes',
        detail: '(512) 555-0100 · Website · added Mar 2, 2026',
      },
    ]);
    expect(sameNamePeople(found, { withoutProfile: false })).toHaveLength(3);
    expect(sameNamePeople({ sameName: [] }, { withoutProfile: true })).toEqual([]);
  });

  it('opens someone on Today on the post first, then their chat, then their page', () => {
    const item = {
      postUrl: null,
      threadKey: null,
      profileUrl: 'https://www.linkedin.com/in/made-up-1/',
    };
    expect(todayOpenOf(item, 'linkedin')).toEqual({
      url: 'https://www.linkedin.com/in/made-up-1/',
      words: 'Open on LinkedIn',
    });
    const chat = { ...item, threadKey: '2-abc=' };
    expect(todayOpenOf(chat, 'linkedin')).toEqual({
      url: 'https://www.linkedin.com/messaging/thread/2-abc%3D/',
      words: 'Open in LinkedIn messaging',
    });
    // A found person's warm-up carries the post its like goes on, as a comment does: Open goes there.
    const post = 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/';
    expect(todayOpenOf({ ...chat, postUrl: post }, 'linkedin')).toEqual({
      url: post,
      words: 'Open the post',
    });
    expect(todayOpenOf({ ...item, profileUrl: null }, 'facebook')).toBeNull();
  });
});
