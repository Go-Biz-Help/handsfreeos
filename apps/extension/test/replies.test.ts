/**
 * Replies on the page (src/facebook/replies.ts) and what the background sends of them (src/hfos/replies.ts): the chats
 * whose last message is theirs, in Messenger's list, an open chat and a small chat window; only lately, each once in a
 * while, and only who.
 */
import { describe, expect, it } from 'vitest';
import { readReplies, type ReplySighting } from '../src/facebook/replies';
import {
  isRepliesNote,
  REPLY_AGAIN_MS,
  repliesInput,
  sightingKey,
  toSend,
} from '../src/hfos/replies';
import { load } from './load';

const FB = 'https://www.facebook.com';

describe('replies on the page', () => {
  it('in Messenger: the chats in the list whose last line isn’t yours, and the open chat', () => {
    const url = `${FB}/messages/t/1234567890/`;
    expect(readReplies(load('chat.html', url), url)).toEqual([
      { name: 'Maria Lopez', threadKey: '9876543210123', profile: null, when: '3d' },
      { name: 'Austin Biz Mastermind', threadKey: '555666777', profile: null, when: '1w' },
      // The list still says "You: …", but the open chat shows their answer below it.
      {
        name: 'Sam Carter',
        threadKey: '1234567890',
        profile: expect.objectContaining({ username: 'sam.carter.77' }),
        when: null,
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
