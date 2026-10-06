/**
 * The steps the extension notices as the person takes them on Facebook, against the hand-written pages in
 * test/fixtures: what each click or Enter was, who it was to, and the group they were found in.
 */
import { describe, expect, it } from 'vitest';
import { seenFromClick, stepFromClick, stepFromEnter } from '../src/facebook/actions';
import { boxEverything, load } from './load';

const FB = 'https://www.facebook.com';
const byId = (id: string) => ({ id, username: null, url: `${FB}/profile.php?id=${id}` });
const byName = (username: string) => ({ id: null, username, url: `${FB}/${username}` });

/** The button labelled `label` on the page, the `nth` of them. */
function button(doc: Document, label: string, nth = 0): Element {
  const found = [...doc.querySelectorAll('[role="button"], button')].filter(
    (e) => (e.getAttribute('aria-label') ?? e.textContent?.trim()) === label,
  )[nth];
  if (!found) throw new Error(`No button "${label}" (${nth})`);
  return found;
}

/** The box to write in whose label starts with `label`, with `words` written in it. */
function write(doc: Document, label: string, words: string): Element {
  const box = doc.querySelector(`[role="textbox"][aria-label^="${label}"]`);
  if (!box) throw new Error(`No box "${label}"`);
  box.querySelector('p')!.textContent = words;
  return box;
}

describe('friend requests', () => {
  it('notes a request from a group’s members, to the member, with the group', () => {
    const url = `${FB}/groups/4455667788/members`;
    const doc = load('group-members-2026.html', url);
    expect(stepFromClick(button(doc, 'Add friend Kim Lowe'), doc, url)).toEqual({
      kind: 'friend_request',
      to: { name: 'Kim Lowe', profile: byId('100003000000002') },
      group: { id: '4455667788', url: `${FB}/groups/4455667788/`, name: 'Westfield Makers Market' },
      postUrl: null,
      thread: null,
      replying: null,
    });
    // The words inside the button are the button's.
    const inner = button(doc, 'Add friend Omar Haddad').querySelector('span span')!;
    expect(stepFromClick(inner, doc, url)?.to.name).toBe('Omar Haddad');
  });

  it('notes the request at the top of a profile as theirs, and one beside it as whoever it’s for', () => {
    const url = `${FB}/jane.doe.5`;
    const doc = load('profile.html', url);
    const top = stepFromClick(button(doc, 'Add friend', 0), doc, url);
    expect(top?.to).toEqual({ name: 'Jane Doe', profile: byName('jane.doe.5') });
    expect(top?.group).toBeNull();
    const suggested = stepFromClick(button(doc, 'Add friend', 1), doc, url);
    expect(suggested?.to).toEqual({ name: 'Kim Lee', profile: byName('kim.lee.21') });
  });

  it('notes the request at the top of a 2026 profile, named by the page’s title', () => {
    const url = `${FB}/dana.reyes.12`;
    const doc = load('profile-2026.html', url);
    const friends = button(doc, 'Friends');
    friends.setAttribute('aria-label', 'Add friend');
    expect(stepFromClick(friends, doc, url)?.to).toEqual({
      name: 'Dana Reyes',
      profile: byName('dana.reyes.12'),
    });
  });

  it('notes a request from People you may know in the feed, by the number in its link', () => {
    const url = `${FB}/`;
    const doc = load('feed-2026.html', url);
    expect(stepFromClick(button(doc, 'Add Friend Tara Quinn'), doc, url)).toMatchObject({
      kind: 'friend_request',
      to: { name: 'Tara Quinn', profile: byId('100004000000003') },
      group: null,
    });
  });

  it('notes nothing it can’t tie to one person', () => {
    const url = `${FB}/jane.doe.5`;
    const doc = load('profile.html', url);
    const suggested = button(doc, 'Add friend', 1);
    suggested.parentElement!.querySelector('a')!.remove();
    // No link beside it, and above it the profile's own links and its friends': nobody in particular.
    expect(stepFromClick(suggested, doc, url)).toBeNull();
  });
});

describe('likes', () => {
  it('notes a like on a post, to whoever wrote it, with the post', () => {
    const url = `${FB}/`;
    const doc = load('feed-2026.html', url);
    expect(stepFromClick(button(doc, 'Like', 0), doc, url)).toEqual({
      kind: 'like',
      to: { name: 'Mark Ellis', profile: byId('100004000000001') },
      group: null,
      postUrl: `${FB}/permalink.php?story_fbid=pfbid0AbCdEf&id=100004000000001`,
      thread: null,
      replying: null,
    });
  });

  it('notes a like on a comment or a reply, to whoever wrote it', () => {
    const url = `${FB}/`;
    const doc = load('feed-2026.html', url);
    expect(stepFromClick(button(doc, 'Like', 1), doc, url)?.to).toEqual({
      name: 'Nina Brooks',
      profile: byId('100004000000002'),
    });
    // The reply mentions Nina, and it's Mark's.
    expect(stepFromClick(button(doc, 'Like', 2), doc, url)?.to.name).toBe('Mark Ellis');
  });

  it('notes a like on an older post whose button has only words', () => {
    const url = `${FB}/jane.doe.5`;
    const doc = load('profile.html', url);
    expect(stepFromClick(button(doc, 'Like'), doc, url)).toMatchObject({
      to: { name: 'Jane Doe', profile: byName('jane.doe.5') },
      postUrl: `${FB}/jane.doe.5/posts/pfbid0abcDEF`,
    });
  });

  it('notes a like on a post in a group with the group, by the group’s link in it', () => {
    const url = `${FB}/groups/7766554433221100/posts/5555666677778888/`;
    const doc = load('group-post-2026.html', url);
    expect(stepFromClick(button(doc, 'Like', 0), doc, url)).toEqual({
      kind: 'like',
      to: { name: 'Owen Pratt', profile: byId('100005000000001') },
      group: {
        id: '7766554433221100',
        url: `${FB}/groups/7766554433221100/`,
        name: 'Riverside Home Pros',
      },
      postUrl: `${FB}/groups/7766554433221100/posts/5555666677778888/`,
      thread: null,
      replying: null,
    });
    // The same post in the feed: its links say the group.
    const feed = load('group-post-2026.html', `${FB}/`);
    expect(stepFromClick(button(feed, 'Like', 0), feed, `${FB}/`)?.group?.id).toBe(
      '7766554433221100',
    );
  });

  it('notes nothing when the like is taken back, or for a like outside a post', () => {
    const url = `${FB}/dana.reyes.12`;
    const doc = load('profile-2026.html', url);
    expect(stepFromClick(button(doc, 'Remove Like'), doc, url)).toBeNull();
    expect(stepFromClick(button(doc, 'Like: 3 people'), doc, url)).toBeNull();
    const outside = doc.createElement('div');
    outside.setAttribute('role', 'button');
    outside.setAttribute('aria-label', 'Like');
    doc.querySelector('[role="main"]')!.prepend(outside);
    expect(stepFromClick(outside, doc, url)).toBeNull();
  });
});

describe('comments', () => {
  const url = `${FB}/groups/7766554433221100/posts/5555666677778888/`;

  it('notes a comment when Enter sends it, to whoever wrote the post, and never what it says', () => {
    const doc = load('group-post-2026.html', url);
    const step = stepFromEnter(write(doc, 'Comment as Robin Hale', 'We can help!'), doc, url);
    expect(step).toEqual({
      kind: 'comment',
      to: { name: 'Owen Pratt', profile: byId('100005000000001') },
      group: {
        id: '7766554433221100',
        url: `${FB}/groups/7766554433221100/`,
        name: 'Riverside Home Pros',
      },
      postUrl: `${FB}/groups/7766554433221100/posts/5555666677778888/`,
      thread: null,
      replying: null,
    });
    expect(JSON.stringify(step)).not.toContain('help');
  });

  it('notes a comment sent with the button beside the box', () => {
    const doc = load('group-post-2026.html', url);
    write(doc, 'Comment as Robin Hale', '👍');
    expect(stepFromClick(button(doc, 'Comment'), doc, url)?.to.name).toBe('Owen Pratt');
  });

  it('notes a reply to whoever wrote the comment it answers', () => {
    const doc = load('group-post-2026.html', url);
    const box = write(doc, 'Reply to Priya Shah', 'Sent you a message');
    expect(stepFromEnter(box, doc, url)?.to).toEqual({
      name: 'Priya Shah',
      profile: byId('100005000000002'),
    });
    // A reply box that doesn't say who: the comment above it.
    box.setAttribute('aria-label', 'Write a reply…');
    expect(stepFromEnter(box, doc, url)?.to.name).toBe('Priya Shah');
  });

  it('notes a comment on a 2026 profile’s post, to them', () => {
    const profile = `${FB}/dana.reyes.12`;
    const doc = load('profile-2026.html', profile);
    const step = stepFromEnter(write(doc, 'Comment as', 'See you there'), doc, profile);
    expect(step).toMatchObject({
      kind: 'comment',
      to: { name: 'Dana Reyes', profile: byName('dana.reyes.12') },
    });
  });

  it('notes a comment from the box Facebook draws under a post, outside it', () => {
    const doc = load('group-post-2026.html', url);
    const form = doc.querySelector('[aria-label="Comment as Robin Hale"]')!.closest('form')!;
    doc.querySelector('[role="main"]')!.append(form);
    const box = write(doc, 'Comment as Robin Hale', 'Nice');
    expect(stepFromEnter(box, doc, url)?.to.name).toBe('Owen Pratt');
  });

  it('notes nothing for an empty box, while a list under it is open, or for your own post', () => {
    const doc = load('group-post-2026.html', url);
    const box = doc.querySelector('[aria-label="Comment as Robin Hale"]')!;
    expect(stepFromEnter(box, doc, url)).toBeNull();
    write(doc, 'Comment as Robin Hale', '@Pri');
    box.setAttribute('aria-expanded', 'true');
    expect(stepFromEnter(box, doc, url)).toBeNull();
    box.removeAttribute('aria-expanded');
    // Your own post: the top bar's "Your profile" links to its author.
    doc
      .querySelector('[role="banner"] a')!
      .setAttribute('href', '/groups/7766554433221100/user/100005000000001/');
    expect(stepFromEnter(box, doc, url)).toBeNull();
  });

  it('notes nothing when a post’s Comment button only opens its box', () => {
    const profile = `${FB}/jane.doe.5`;
    const doc = load('profile.html', profile);
    expect(stepFromClick(button(doc, 'Comment'), doc, profile)).toBeNull();
  });
});

describe('messages', () => {
  const url = `${FB}/messages/t/100009000000002/`;

  it('notes a message sent in an open chat, to who it’s with, in that chat', () => {
    const doc = load('chat-2026.html', url);
    expect(stepFromEnter(write(doc, 'Message Dana Reyes', 'Running late'), doc, url)).toEqual({
      kind: 'message',
      to: { name: 'Dana Reyes', profile: byId('100009000000002') },
      group: null,
      postUrl: null,
      thread: {
        id: '100009000000002',
        encrypted: false,
        url: `${FB}/messages/t/100009000000002/`,
      },
      // The last message was yours.
      replying: false,
    });
  });

  it('says a message answers them when their message was the last', () => {
    const doc = load('chat-2026.html', url);
    const log = doc.querySelector('[role="log"]')!;
    const articles = [...log.querySelectorAll('[role="article"]')];
    // Down to Dana's "…Maybe 10am?".
    for (const article of articles.slice(4)) article.remove();
    const step = stepFromEnter(write(doc, 'Message Dana Reyes', 'Works for me'), doc, url);
    expect(step?.replying).toBe(true);
  });

  it('notes a message in a chat open over another page, by the one person it links to', () => {
    const feed = `${FB}/`;
    const doc = load('feed-2026.html', feed);
    const window = doc.createElement('div');
    window.innerHTML = `
      <div><a role="link" href="/messages/t/100004000000002/">Open in Messenger</a></div>
      <div><a role="link" href="/profile.php?id=100004000000002"><span>Nina Brooks</span></a></div>
      <div><div role="textbox" aria-label="Message" contenteditable="true"><p>Hi Nina</p></div></div>`;
    doc.body.append(window);
    expect(stepFromEnter(window.querySelector('[role="textbox"]')!, doc, feed)).toEqual({
      kind: 'message',
      to: { name: 'Nina Brooks', profile: byId('100004000000002') },
      group: null,
      postUrl: null,
      thread: {
        id: '100004000000002',
        encrypted: false,
        url: `${FB}/messages/t/100004000000002/`,
      },
      replying: null,
    });
  });

  it('notes nothing from a box that isn’t one to write a message or a comment in', () => {
    const feed = `${FB}/`;
    const doc = load('feed-2026.html', feed);
    const box = doc.createElement('div');
    box.setAttribute('role', 'textbox');
    box.setAttribute('aria-label', 'What’s on your mind?');
    box.setAttribute('contenteditable', 'true');
    box.textContent = 'A new post';
    doc.querySelector('[role="main"]')!.prepend(box);
    expect(stepFromEnter(box, doc, feed)).toBeNull();
  });
});

describe('where someone was found', () => {
  it('remembers the group of someone opened from its members', () => {
    const url = `${FB}/groups/4455667788/members`;
    const doc = load('group-members-2026.html', url);
    const link = doc.querySelector(
      'a[href="/groups/4455667788/user/100003000000002/"]:not([aria-hidden])',
    )!;
    expect(seenFromClick(link, doc, url)).toEqual({
      profile: byId('100003000000002'),
      name: 'Kim Lowe',
      group: { id: '4455667788', url: `${FB}/groups/4455667788/`, name: 'Westfield Makers Market' },
    });
  });

  it('remembers the group of someone opened from a post in it, wherever it shows', () => {
    const doc = load('group-post-2026.html', `${FB}/`);
    const link = doc.querySelector('a[href^="/groups/7766554433221100/user/100005000000003/"]')!;
    expect(seenFromClick(link, doc, `${FB}/`)).toMatchObject({
      profile: byId('100005000000003'),
      name: 'Leo Grant',
      group: { id: '7766554433221100', name: 'Riverside Home Pros' },
    });
  });

  it('remembers nobody opened outside a group, nor you', () => {
    const url = `${FB}/`;
    const doc = load('feed-2026.html', url);
    const mark = doc.querySelector('h4 a[href="/profile.php?id=100004000000001"]')!;
    expect(seenFromClick(mark, doc, url)).toBeNull();
    const groups = `${FB}/groups/7766554433221100/posts/5555666677778888/`;
    const post = load('group-post-2026.html', groups);
    const you = post.createElement('a');
    you.setAttribute('href', '/robin.hale.77');
    you.textContent = 'Robin Hale';
    post.querySelector('[role="main"]')!.append(you);
    expect(seenFromClick(you, post, groups)).toBeNull();
  });
});

describe('pages with more boxes than their outline shows', () => {
  const groupPost = `${FB}/groups/7766554433221100/posts/5555666677778888/`;
  const CASES: readonly (readonly [
    what: string,
    fixture: string,
    url: string,
    take: (doc: Document, url: string) => unknown,
  ])[] = [
    [
      'a request from a group’s members',
      'group-members-2026.html',
      `${FB}/groups/4455667788/members`,
      (doc, url) => stepFromClick(button(doc, 'Add friend Kim Lowe'), doc, url),
    ],
    [
      'a request at the top of a profile',
      'profile.html',
      `${FB}/jane.doe.5`,
      (doc, url) => stepFromClick(button(doc, 'Add friend', 0), doc, url),
    ],
    [
      'a request beside a profile',
      'profile.html',
      `${FB}/jane.doe.5`,
      (doc, url) => stepFromClick(button(doc, 'Add friend', 1), doc, url),
    ],
    [
      'a request in the feed',
      'feed-2026.html',
      `${FB}/`,
      (doc, url) => stepFromClick(button(doc, 'Add Friend Tara Quinn'), doc, url),
    ],
    [
      'a like on a post',
      'feed-2026.html',
      `${FB}/`,
      (doc, url) => stepFromClick(button(doc, 'Like', 0), doc, url),
    ],
    [
      'a like on a comment',
      'feed-2026.html',
      `${FB}/`,
      (doc, url) => stepFromClick(button(doc, 'Like', 1), doc, url),
    ],
    [
      'a like in a group',
      'group-post-2026.html',
      groupPost,
      (doc, url) => stepFromClick(button(doc, 'Like', 0), doc, url),
    ],
    [
      'a comment',
      'group-post-2026.html',
      groupPost,
      (doc, url) => stepFromEnter(write(doc, 'Comment as Robin Hale', 'Hi'), doc, url),
    ],
    [
      'a comment sent with the button',
      'group-post-2026.html',
      groupPost,
      (doc, url) => {
        write(doc, 'Comment as Robin Hale', 'Hi');
        return stepFromClick(button(doc, 'Comment'), doc, url);
      },
    ],
    [
      'a reply',
      'group-post-2026.html',
      groupPost,
      (doc, url) => stepFromEnter(write(doc, 'Reply to Priya Shah', 'Hi'), doc, url),
    ],
    [
      'a message',
      'chat-2026.html',
      `${FB}/messages/t/100009000000002/`,
      (doc, url) => stepFromEnter(write(doc, 'Message Dana Reyes', 'Hi'), doc, url),
    ],
    [
      'someone opened from a group',
      'group-members-2026.html',
      `${FB}/groups/4455667788/members`,
      (doc, url) =>
        seenFromClick(
          doc.querySelector(
            'a[href="/groups/4455667788/user/100003000000002/"]:not([aria-hidden])',
          )!,
          doc,
          url,
        ),
    ],
  ];

  it.each(CASES)(
    'notes %s the same with a bare box around every element',
    (_what, fixture, url, take) => {
      const asWritten = take(load(fixture, url), url);
      expect(asWritten).not.toBeNull();
      expect(take(boxEverything(load(fixture, url)), url)).toEqual(asWritten);
    },
  );
});
