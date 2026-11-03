/**
 * Who wrote back on LinkedIn (src/networks/linkedin/replies.ts), as ./replies.test.ts does Facebook's: the
 * conversations in messaging's list whose last line isn't yours, and the one open beside it when its last message is
 * theirs; never a group, never what they wrote. And what the background sends of them, as LinkedIn's. Read on the page
 * as written and again with a bare box around every element.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { repliesInput, sightingKey, toSend } from '../src/hfos/replies';
import { readReplies } from '../src/networks/linkedin/replies';
import { boxEverything, load } from './load';

const LI = 'https://www.linkedin.com';
const THREAD = `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`;
const SHAPES = [
  ['as written', (doc: Document) => doc],
  ['with a bare box around every element', boxEverything],
] as const;

describe.each(SHAPES)('replies on LinkedIn, %s', (_, shape) => {
  // A chat's side is measured on screen; jsdom draws nothing.
  const read = (url: string) =>
    readReplies(shape(load('linkedin-chat.html', url)), url, { sideOf: () => null });

  it('in messaging: the open conversation, with who it’s with, and the list’s time', () => {
    expect(read(THREAD)).toEqual([
      {
        name: 'Dana Reyes',
        threadKey: '2-MadeUpThreadDana0001==',
        profile: {
          id: 'ACoAAFakeDanaReyes123',
          username: null,
          url: `${LI}/in/ACoAAFakeDanaReyes123/`,
        },
        when: '2:21 PM',
      },
    ]);
  });

  it('in the list alone: theirs, never yours ("You: …") and never a group', () => {
    expect(read(`${LI}/messaging/`)).toEqual([
      { name: 'Dana Reyes', threadKey: '2-MadeUpThreadDana0001==', profile: null, when: '2:21 PM' },
    ]);
  });

  it('nowhere else: a chat window over the feed is the person’s own to read', () => {
    expect(read(`${LI}/feed/`)).toEqual([]);
  });

  it('sends nothing they wrote', () => {
    expect(JSON.stringify(read(THREAD))).not.toContain('Tuesday');
  });
});

/** A row of LinkedIn's newer list, as the owner's Check LinkedIn of 29 Oct 2026 outlined one: no link to its conversation. */
const row = (name: string, when: string, said: string) =>
  `<li><div><div><div><div><img alt="${name}"><div><input type="checkbox"><label aria-label="Select conversation with ${name}"></label></div></div>
    <div><div><h3><span>${name}</span></h3><time>${when}</time><span>${when}</span></div>
      <div><p>${said}</p><div role="img" aria-label="Status is offline"></div></div></div></div>
    <div><div><button aria-expanded="false" type="button"><span>Open the options list in your conversation with ${name}</span></button></div></div></div></div></li>`;
const NEWER_LIST = `<!doctype html><html><body><main><div><div>
  <div><a href="#"><div>Jump to active conversation</div></a><h2>Conversation List</h2></div>
  <ul aria-label="Conversation List"><li></li>
    ${row('LinkedIn', 'Oct 28', '<span>LinkedIn Offer</span><span aria-hidden="true">•</span>Try Premium free for a month')}
    ${row('Dana Reyes', '2:21 PM', 'Dana: Tuesday works for me')}
    ${row('Sam Lee', 'Oct 27', 'You: Thanks, talk soon')}
    ${row('Avery Lane', 'Oct 26', '<span>InMail</span><span aria-hidden="true">•</span>Quick question about your hiring')}
    ${row('Jo Reed, Kim Baker', 'Oct 25', 'Jo: see you all there')}
    ${row('Casey Moreno', 'Oct 24', 'Casey reacted 👍 to your message')}
  </ul></div></div></main></body></html>`;

describe.each(SHAPES)('replies in LinkedIn’s newer list, %s', (_, shape) => {
  it('go by the name each row shows: theirs alone, never yours, a group, an InMail, an ad or a reaction', () => {
    const url = `${LI}/messaging/`;
    const doc = shape(new JSDOM(NEWER_LIST, { url }).window.document);
    expect(readReplies(doc, url, { sideOf: () => null })).toEqual([
      { name: 'Dana Reyes', threadKey: null, profile: null, when: '2:21 PM' },
    ]);
    expect(JSON.stringify(readReplies(doc, url, { sideOf: () => null }))).not.toContain('Tuesday');
  });
});

describe('what the background sends of LinkedIn’s', () => {
  const dana = {
    name: 'Dana Reyes',
    threadKey: '2-MadeUpThreadDana0001==',
    profile: null,
    when: '2:21 PM',
  };

  it('says they’re LinkedIn’s, and keeps them apart from Facebook’s', () => {
    expect(repliesInput('ws-1', [dana], true, 'linkedin')).toEqual({
      workspaceId: 'ws-1',
      platform: 'linkedin',
      looking: true,
      seen: [{ name: 'Dana Reyes', threadKey: '2-MadeUpThreadDana0001==', profile: null }],
    });
    expect(sightingKey(dana, 'linkedin')).not.toBe(sightingKey(dana));
    const now = new Date('2026-10-15T15:00:00');
    // Sent lately as Facebook's: still news on LinkedIn.
    expect(toSend([dana], { [sightingKey(dana)]: now.getTime() }, now, 'linkedin')).toEqual([dana]);
  });
});
