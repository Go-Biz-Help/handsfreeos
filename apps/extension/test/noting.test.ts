/**
 * What the extension sends HandsFreeOS for each step the person takes on Facebook, and each friend request they
 * answer, cut to what the command takes; and how the background decides what to do with one: keep it waiting, send
 * it again, or let it go.
 */
import { describe, expect, it } from 'vitest';
import type { Answered, Seen, Step, StepGroup } from '../src/networks/facebook/actions';
import {
  GROUPS_MOST,
  isTabNote,
  momentOf,
  outcomeOf,
  rememberedFor,
  withSeen,
  type Remembered,
} from '../src/hfos/noting';
import { friendNote, touchSave } from '../src/hfos/saves';

const WS = '6f0a3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b';
const FB = 'https://www.facebook.com';

const kim = { id: '100003000000002', username: null, url: `${FB}/profile.php?id=100003000000002` };
const makers = {
  id: '4455667788',
  url: `${FB}/groups/4455667788/`,
  name: 'Westfield Makers Market',
};
const riverside = { id: 'riverside.pros', url: `${FB}/groups/riverside.pros/`, name: null };

const step = (more: Partial<Step> = {}): Step => ({
  kind: 'friend_request',
  to: { name: 'Kim Lowe', profile: kim },
  group: makers,
  postUrl: null,
  thread: null,
  replying: null,
  ...more,
});

describe('touchSave', () => {
  it('sends who it was to and the group, by its number', () => {
    expect(touchSave(step(), WS)).toEqual({
      ok: true,
      input: {
        workspaceId: WS,
        platform: 'facebook',
        kind: 'friend_request',
        profile: { id: '100003000000002', username: null, url: kim.url },
        name: 'Kim Lowe',
        group: { id: '4455667788', slug: null, url: makers.url, name: 'Westfield Makers Market' },
        postUrl: null,
        threadKey: null,
        replying: null,
        auto: false,
      },
    });
  });

  it('says when the extension took the step on its own', () => {
    const built = touchSave(step({ auto: true }), WS);
    expect(built.ok && built.input.auto).toBe(true);
  });

  it('sends a group by the name in its link, and the one remembered when the page had none', () => {
    const built = touchSave(step({ group: null }), WS, riverside);
    expect(built.ok && built.input.group).toEqual({
      id: null,
      slug: 'riverside.pros',
      url: riverside.url,
      name: null,
    });
    // The page's own group comes first.
    const both = touchSave(step(), WS, riverside);
    expect(both.ok && both.input.group?.id).toBe('4455667788');
  });

  it('sends the post for a like or a comment, and the chat and whether it answers them for a message', () => {
    const post = `${FB}/groups/4455667788/posts/5555666677778888/`;
    const liked = touchSave(step({ kind: 'like', postUrl: post }), WS);
    expect(liked.ok && [liked.input.postUrl, liked.input.threadKey]).toEqual([post, null]);
    const message = touchSave(
      step({
        kind: 'message',
        group: null,
        postUrl: post,
        thread: {
          id: '100009000000002',
          encrypted: false,
          url: `${FB}/messages/t/100009000000002/`,
        },
        replying: true,
      }),
      WS,
    );
    expect(message.ok && message.input).toMatchObject({
      kind: 'message',
      postUrl: null,
      threadKey: '100009000000002',
      replying: true,
    });
  });

  it('cuts a long name, and leaves out what HandsFreeOS wouldn’t take', () => {
    const built = touchSave(
      step({
        to: { name: `  ${'Kim '.repeat(80)}`, profile: kim },
        group: { id: 'not a group!', url: `${FB}/groups/not%20a%20group!/`, name: 'Odd' },
        kind: 'like',
        postUrl: 'https://example.com/post',
      }),
      WS,
    );
    expect(built.ok && built.input.name.length).toBe(200);
    expect(built.ok && built.input.name.endsWith('…')).toBe(true);
    expect(built.ok && [built.input.group, built.input.postUrl]).toEqual([null, null]);
  });

  it('notes nobody it can’t tell the profile of', () => {
    const nobody = { id: 'abc', username: 'no spaces allowed', url: `${FB}/x` };
    expect(touchSave(step({ to: { name: 'Kim Lowe', profile: nobody } }), WS)).toEqual({
      ok: false,
      why: 'Couldn’t tell whose profile it was.',
    });
    expect(touchSave(step({ to: { name: '   ', profile: kim } }), WS).ok).toBe(false);
  });
});

describe('friendNote', () => {
  const answered = (more: Partial<Answered> = {}): Answered => ({
    answer: 'confirm',
    to: { name: 'Kim Lowe', profile: kim },
    mutualFriends: 12,
    ...more,
  });

  it('sends the answer, who asked, and their mutual friends', () => {
    expect(friendNote(answered(), WS)).toEqual({
      ok: true,
      input: {
        workspaceId: WS,
        platform: 'facebook',
        answer: 'confirm',
        profile: { id: '100003000000002', username: null, url: kim.url },
        name: 'Kim Lowe',
        mutualFriends: 12,
      },
    });
    const deleted = friendNote(answered({ answer: 'delete', mutualFriends: 900_000 }), WS);
    expect(deleted.ok && deleted.input).toMatchObject({ answer: 'delete', mutualFriends: null });
  });

  it('notes nobody it can’t tell the profile of', () => {
    const nobody = { id: null, username: null, url: `${FB}/friends/requests/` };
    expect(friendNote(answered({ to: { name: 'Kim Lowe', profile: nobody } }), WS)).toEqual({
      ok: false,
      why: 'Couldn’t tell whose profile it was.',
    });
  });
});

describe('what comes of sending a step', () => {
  const refused = (status: number, rule?: string, disposition?: string) => [
    status,
    { error: { code: 'x', message: 'Words for the person.', rule, disposition } },
  ];

  it('keeps it waiting when HandsFreeOS couldn’t take it now', () => {
    expect(outcomeOf(null, undefined)).toEqual({ kind: 'later' });
    for (const status of [500, 502, 401, 426, 429])
      expect(outcomeOf(...(refused(status) as [number, unknown])).kind).toBe('later');
  });

  it('sends it again under a new id when another was saved at the same moment', () => {
    expect(outcomeOf(...(refused(409, 'outreach_saved_at_once') as [number, unknown]))).toEqual({
      kind: 'again',
    });
  });

  it('lets it go when HandsFreeOS says no, with its words', () => {
    expect(outcomeOf(...(refused(403, 'addon_inactive', 'final') as [number, unknown]))).toEqual({
      kind: 'refused',
      why: 'Words for the person.',
    });
    expect(outcomeOf(400, 'not json')).toEqual({
      kind: 'refused',
      why: 'HandsFreeOS couldn’t keep it.',
    });
  });
});

describe('the group someone was opened from', () => {
  const seen = (
    profile: Seen['profile'],
    name: string | null,
    group: StepGroup = makers,
  ): Seen => ({
    profile,
    name,
    group,
  });

  it('is found by their profile, else by their name when only one person opened had it', () => {
    const byName = { id: null, username: 'kim.lowe', url: `${FB}/kim.lowe` };
    const groups = withSeen({}, seen(kim, 'Kim Lowe'), 1);
    expect(rememberedFor(groups, step({ group: null }))).toEqual(makers);
    // The profile page shows a username where the group's list linked a number.
    expect(rememberedFor(groups, step({ to: { name: 'kim  lowe', profile: byName } }))).toEqual(
      makers,
    );
    const two = withSeen(
      groups,
      seen({ id: '1', username: null, url: `${FB}/profile.php?id=1` }, 'Kim Lowe', riverside),
      2,
    );
    expect(rememberedFor(two, step({ to: { name: 'Kim Lowe', profile: byName } }))).toBeNull();
  });

  it('keeps the latest, letting the oldest go', () => {
    let groups: Record<string, Remembered> = {};
    for (let i = 0; i <= GROUPS_MOST; i++)
      groups = withSeen(
        groups,
        seen({ id: String(i), username: null, url: `${FB}/profile.php?id=${i}` }, null),
        i,
      );
    expect(Object.keys(groups)).toHaveLength(GROUPS_MOST);
    expect(groups['id:0']).toBeUndefined();
    expect(groups[`id:${GROUPS_MOST}`]?.group).toEqual(makers);
  });
});

describe('a tab’s note', () => {
  it('takes notes shaped like a step, an answer or someone seen, and nothing else', () => {
    expect(isTabNote({ type: 'hfos-noted', step: step(), at: '2026-10-06T06:00:00.000Z' })).toBe(
      true,
    );
    const answered = {
      answer: 'delete',
      to: { name: 'Kim Lowe', profile: kim },
      mutualFriends: null,
    };
    expect(isTabNote({ type: 'hfos-answered', answered, at: 'now' })).toBe(true);
    expect(
      isTabNote({ type: 'hfos-answered', answered: { ...answered, answer: 'block' }, at: 'now' }),
    ).toBe(false);
    expect(isTabNote({ type: 'hfos-answered', answered })).toBe(false);
    expect(
      isTabNote({
        type: 'hfos-answered',
        answered: { ...answered, to: { profile: kim } },
        at: 'now',
      }),
    ).toBe(false);
    expect(
      isTabNote({ type: 'hfos-seen', seen: { profile: kim, name: null, group: makers } }),
    ).toBe(true);
    expect(isTabNote({ type: 'hfos-noted', step: { ...step(), kind: 'poke' }, at: 'now' })).toBe(
      false,
    );
    expect(isTabNote({ type: 'hfos-noted', at: 'now' })).toBe(false);
    expect(isTabNote({ type: 'hfos-seen', seen: { profile: kim } })).toBe(false);
    expect(isTabNote({ type: 'hfos-read' })).toBe(false);
    expect(isTabNote(null)).toBe(false);
  });

  it('keeps the moment the tab gave, unless it can’t be right', () => {
    const now = new Date('2026-10-06T06:00:00.000Z');
    expect(momentOf('2026-10-06T05:59:30.000Z', now)).toBe('2026-10-06T05:59:30.000Z');
    expect(momentOf('not a time', now)).toBe(now.toISOString());
    expect(momentOf('2026-10-06T07:00:00.000Z', now)).toBe(now.toISOString());
  });
});
