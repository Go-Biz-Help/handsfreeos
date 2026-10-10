/**
 * Social Outreach: the words and rules of asking the extension (docs/outreach.md, decision 43), the same on the web,
 * in the extension and later on the phone.
 */
import { describe, expect, it } from 'vitest';
import {
  AskInput,
  askAbout,
  askAgainWords,
  askRepliesFor,
  askShownState,
  askStuckPushWords,
  askTarget,
  askWaitingWords,
  groupLink,
  isGroupLink,
} from '../../src/addons/outreach/asks';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Friday 9 October 2026, 2:14 PM in Chicago.
const at = Date.UTC(2026, 9, 9, 19, 14);
const tz = 'America/Chicago';
const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe('asking the extension', () => {
  it('lets a waiting ask go after a day, and calls one lost when its computer went away', () => {
    const waiting = { state: 'waiting' as const, askedAt: iso(at), startedAt: null, seenAt: null };
    expect(askShownState(waiting, at + 23 * HOUR)).toBe('waiting');
    expect(askShownState(waiting, at + 25 * HOUR)).toBe('expired');
    const working = {
      state: 'working' as const,
      askedAt: iso(at),
      startedAt: iso(at),
      seenAt: iso(at + 5 * MIN),
    };
    expect(askShownState(working, at + 10 * MIN)).toBe('working');
    expect(askShownState(working, at + 20 * MIN)).toBe('lost');
    expect(askShownState({ ...working, seenAt: null }, at + MIN)).toBe('lost');
    expect(
      askShownState({ ...working, state: 'stuck', seenAt: iso(at + 7 * HOUR) }, at + 7 * HOUR),
    ).toBe('lost');
    expect(askShownState({ ...working, state: 'done' }, at + 2 * HOUR)).toBe('done');
  });

  it('says what a person may answer a step handed to them', () => {
    expect(askRepliesFor('file_download')).toEqual(['carry_on']);
    expect(askRepliesFor('unfriend')).toEqual(['carry_on', 'skip']);
    expect(askRepliesFor('friends')).toEqual([]);
  });

  it('names what an ask is about, and tells the same thing asked twice apart from another', () => {
    const one = AskInput.parse({ kind: 'members', groupIds: [id(1)] });
    expect(askAbout(one, { groups: ['Austin Small Business Owners'] })).toBe(
      'Austin Small Business Owners',
    );
    const two = AskInput.parse({ kind: 'posts', groupIds: [id(2), id(1)] });
    expect(askAbout(two, { groups: ['A', 'B'] })).toBe('2 groups');
    expect(askAbout(AskInput.parse({ kind: 'members' }))).toBe('your best groups');
    expect(askAbout(AskInput.parse({ kind: 'cancel', profileIds: [id(1), id(2), id(3)] }))).toBe(
      '3 people',
    );
    expect(
      askAbout(AskInput.parse({ kind: 'lookup', draft: { kind: 'opener', profileId: id(1) } }), {
        name: 'Dana Reyes',
      }),
    ).toBe('Dana Reyes');
    expect(askAbout(AskInput.parse({ kind: 'group_search', words: 'dog groomers austin' }))).toBe(
      '“dog groomers austin”',
    );
    expect(askAbout(AskInput.parse({ kind: 'friends' }))).toBeNull();

    // The same groups in any order are the same; a pasted link by its group.
    expect(askTarget(two)).toBe(
      askTarget(AskInput.parse({ kind: 'posts', groupIds: [id(1), id(2)] })),
    );
    expect(
      askTarget(
        AskInput.parse({ kind: 'members', url: 'https://m.facebook.com/groups/42/members?ref=x' }),
      ),
    ).toBe('link:https://www.facebook.com/groups/42/');
    expect(
      askTarget(AskInput.parse({ kind: 'lookup', draft: { kind: 'reply', chatId: id(3) } })),
    ).toBe(`reply:chat:${id(3)}`);
    expect(askAgainWords('cancel')).toContain('still on the last ones you ticked');
    expect(askAgainWords('chats')).toBe('Your computer is on it already.');
    // Not both a group picked and a link pasted; a look-up says who.
    expect(AskInput.safeParse({ kind: 'members', groupIds: [id(1)], url: 'x' }).success).toBe(
      false,
    );
    expect(AskInput.safeParse({ kind: 'lookup', draft: { kind: 'opener' } }).success).toBe(false);
  });

  it('says when the computer does it: in a moment, once signed in, or once it’s on', () => {
    const computer = {
      name: 'Chrome on Windows',
      online: true,
      signedOut: false,
      lastSeenAt: iso(at),
    };
    expect(askWaitingWords(computer, tz, at + MIN)).toBe(
      'Chrome on Windows starts on it in a moment.',
    );
    expect(askWaitingWords({ ...computer, signedOut: true }, tz, at + MIN)).toBe(
      'Chrome on Windows is signed out of the extension. Sign in there, and it does this.',
    );
    expect(askWaitingWords({ ...computer, online: false }, tz, at + 10 * MIN)).toBe(
      'Your computer is offline: nothing runs until Chrome is open. Last seen 2:14 PM. It does this then.',
    );
    expect(askWaitingWords(null, tz, at)).toContain('Install HandsFreeOS Social');
  });

  it('pushes once when it needs the person, with their password asked for in plain words', () => {
    expect(askStuckPushWords('stuck', 'Press Download yourself, then Carry on.')).toEqual({
      title: 'Your computer needs you',
      body: 'Press Download yourself, then Carry on.',
    });
    expect(askStuckPushWords('typing', null).body).toBe(
      'Facebook is asking for your password or PIN. Type it on your computer, in the Facebook tab it opened.',
    );
  });

  it('knows a Facebook group’s link from anything else, and keeps it one way', () => {
    expect(groupLink('https://www.facebook.com/groups/austin.small.biz')).toBe(
      'https://www.facebook.com/groups/austin.small.biz/',
    );
    expect(groupLink('https://www.facebook.com/groups/123456/members/')).toBe(
      'https://www.facebook.com/groups/123456/',
    );
    expect(groupLink('https://m.facebook.com/groups/123456?ref=share')).toBe(
      'https://www.facebook.com/groups/123456/',
    );
    expect(groupLink('facebook.com/groups/123456/posts/789/')).toBe(
      'https://www.facebook.com/groups/123456/',
    );
    expect(isGroupLink('https://www.facebook.com/groups/joins/')).toBe(false);
    expect(isGroupLink('https://www.facebook.com/groups/')).toBe(false);
    expect(isGroupLink('https://www.facebook.com/dana.reyes')).toBe(false);
    expect(isGroupLink('https://example.com/groups/123/')).toBe(false);
    expect(isGroupLink('not a link at all')).toBe(false);
  });
});
