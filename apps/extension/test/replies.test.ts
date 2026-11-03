/**
 * Replies on the page (src/networks/facebook/replies.ts) and what the background sends of them (src/hfos/replies.ts): the chats
 * whose last message is theirs, in Messenger's list, an open chat and a small chat window; only lately, each once in a
 * while, and only who.
 */
import { describe, expect, it } from 'vitest';
import { readReplies, type ReplySighting } from '../src/networks/facebook/replies';
import {
  isRepliesNote,
  lineHash,
  REPLY_AGAIN_MS,
  repliesInput,
  sightingKey,
  toSend,
  withNewer,
} from '../src/hfos/replies';
import { load } from './load';

const FB = 'https://www.facebook.com';

describe('replies on the page', () => {
  it('in Messenger: the chats in the list whose last line isn’t yours, and the open chat', () => {
    const url = `${FB}/messages/t/1234567890/`;
    expect(readReplies(load('chat.html', url), url)).toEqual([
      // Each with its last line, compared on the computer each time and never sent (decision 150).
      {
        name: 'Maria Lopez',
        threadKey: '9876543210123',
        profile: null,
        when: '3d',
        last: { line: 'Are you free Tuesday?', where: 'list' },
      },
      {
        name: 'Austin Biz Mastermind',
        threadKey: '555666777',
        profile: null,
        when: '1w',
        last: { line: 'Dan: See you all Thursday', where: 'list' },
      },
      // The list still says "You: …", but the open chat shows their answer below it.
      {
        name: 'Sam Carter',
        threadKey: '1234567890',
        profile: expect.objectContaining({ username: 'sam.carter.77' }),
        when: null,
        last: { line: "Honestly it's too expensive for us.", where: 'chat' },
      },
    ]);
  });

  it('in a small chat window over another page, by who its header links to', () => {
    const url = `${FB}/friends/requests/`;
    const doc = load('chat-window-2026.html', url);
    expect(readReplies(doc, url)).toEqual([
      {
        name: 'Riley Quinn',
        threadKey: null,
        profile: expect.objectContaining({ username: 'riley.quinn.7' }),
        when: null,
        last: { line: 'Sure, send them over', where: 'chat' },
      },
    ]);
    // Yours last: nothing.
    const articles = doc.querySelectorAll('[role="log"] [role="article"]');
    articles[articles.length - 1]!.remove();
    expect(readReplies(doc, url)).toEqual([]);
  });
});

describe('what the background sends', () => {
  const now = new Date('2026-10-09T15:00:00');
  const maria: ReplySighting = { name: 'Maria Lopez', threadKey: '987', profile: null, when: '3h' };
  const old: ReplySighting = { name: 'Old Chat', threadKey: '988', profile: null, when: '3d' };
  const open: ReplySighting = {
    name: 'Sam Carter',
    threadKey: null,
    profile: { id: null, username: 'sam.carter.77', url: `${FB}/sam.carter.77` },
    when: null,
  };

  it('only chats from the last two days, each once in a few minutes', () => {
    expect(toSend([maria, old, open, maria], {}, now)).toEqual([maria, open]);
    const sent = { [sightingKey(maria)]: now.getTime() - 60_000 };
    expect(toSend([maria, open], sent, now)).toEqual([open]);
    const later = new Date(now.getTime() + REPLY_AGAIN_MS);
    expect(toSend([maria], sent, later)).toEqual([maria]);
  });

  it('sends who, by their chat’s number or profile: never when', () => {
    expect(repliesInput('ws-1', [maria, open], false)).toEqual({
      workspaceId: 'ws-1',
      looking: false,
      seen: [
        { name: 'Maria Lopez', threadKey: '987', profile: null },
        {
          name: 'Sam Carter',
          threadKey: null,
          profile: { id: null, username: 'sam.carter.77', url: `${FB}/sam.carter.77` },
        },
      ],
    });
  });

  it('takes only a note of the right shape from a tab', () => {
    expect(isRepliesNote({ type: 'hfos-replies', looking: true, seen: [maria] })).toBe(true);
    expect(isRepliesNote({ type: 'hfos-replies', looking: true, seen: [{ name: 3 }] })).toBe(false);
    expect(isRepliesNote({ type: 'hfos-replies', seen: [] })).toBe(false);
  });
});

describe('a newer message of theirs (decision 150)', () => {
  const now = new Date('2026-11-03T15:00:00');
  const said = (line: string, where: 'list' | 'chat' = 'list'): ReplySighting => ({
    name: 'Maria Lopez',
    threadKey: '987',
    profile: null,
    when: '3h',
    last: { line, where },
  });

  it('keeps a fingerprint of each line, never its words', () => {
    const { lines } = withNewer([said('Are you free Tuesday?')], {}, now.getTime());
    expect(JSON.stringify(lines)).not.toContain('Tuesday');
    expect(lineHash('Are  you free Tuesday? ')).toBe(lineHash('are you free tuesday?'));
    expect(lineHash('Are you free Tuesday?')).not.toBe(lineHash('Are you free Wednesday?'));
  });

  it('is news only when the line changed since the computer last saw it', () => {
    const first = withNewer([said('Are you free Tuesday?')], {}, now.getTime());
    // The first sight only notes where the chat stands.
    expect(first.seen[0]!.newer).toBeUndefined();
    const same = withNewer([said('Are you free Tuesday?')], first.lines, now.getTime() + 60_000);
    expect(same.seen[0]!.newer).toBeUndefined();
    const changed = withNewer([said('Or Wednesday?')], same.lines, now.getTime() + 120_000);
    expect(changed.seen[0]!.newer).toBe(true);
  });

  it('compares a line from the list and one from the open chat each with its own', () => {
    const first = withNewer([said('Maria: Or Wednesday?', 'list')], {}, now.getTime());
    const open = withNewer([said('Or Wednesday?', 'chat')], first.lines, now.getTime() + 60_000);
    expect(open.seen[0]!.newer).toBeUndefined();
  });

  it('never takes a tab’s word for what’s newer', () => {
    const { seen } = withNewer([{ ...said('Hi'), newer: true }], {}, now.getTime());
    expect(seen[0]!.newer).toBeUndefined();
  });

  it('forgets a chat unseen for a week', () => {
    const { lines } = withNewer([said('Hi')], {}, now.getTime());
    const week = now.getTime() + 7 * 24 * 3_600_000;
    expect(withNewer([], lines, week).lines).toEqual({});
  });

  it('goes at once, even when the chat was sent a minute ago, and before the others', () => {
    const other: ReplySighting = { name: 'Sam', threadKey: '988', profile: null, when: '1h' };
    const newer = { ...said('Or Wednesday?'), newer: true };
    const sent = { [sightingKey(newer)]: now.getTime() - 60_000 };
    expect(toSend([other, newer], sent, now)).toEqual([newer, other]);
    expect(toSend([other, said('Or Wednesday?')], sent, now)).toEqual([other]);
  });

  it('is sent as newer, never with its words', () => {
    const input = repliesInput('ws-1', [{ ...said('Or Wednesday?'), newer: true }], false);
    expect(input.seen).toEqual([
      { name: 'Maria Lopez', threadKey: '987', profile: null, newer: true },
    ]);
    expect(JSON.stringify(input)).not.toContain('Wednesday');
  });
});
