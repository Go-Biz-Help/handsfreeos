/**
 * The steps the extension notices as the person takes them on LinkedIn (src/networks/linkedin/actions.ts), against
 * the hand-written pages in test/fixtures, as ./actions.test.ts does Facebook's: an invitation to connect, with or
 * without a note, once it went; Accept and Ignore; a like; a comment and a reply; a message in a conversation and in
 * a chat window. Every step is taken on the page as written and again with a bare box around every element, as
 * ./linkedin-boxes.test.ts reads them.
 */
import { describe, expect, it } from 'vitest';
import { kitOf } from '../src/networks';
import type { Noticed } from '../src/networks/kit';
import {
  CONNECT_LOOK_MS,
  ENTER_LOOK_MS,
  INVITE_WAIT_MS,
  linkedInNoticer,
} from '../src/networks/linkedin/actions';
import { touchSave, friendNote } from '../src/hfos/saves';
import { boxEverything, load } from './load';

const LI = 'https://www.linkedin.com';
const WS = '6f0a3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b';
const byName = (username: string) => ({ id: null, username, url: `${LI}/in/${username}/` });
const dana = { name: 'Dana Reyes', profile: byName('dana-reyes-4b2a1c') };
const danaWithId = {
  name: 'Dana Reyes',
  profile: { ...byName('dana-reyes-4b2a1c'), id: 'ACoAAFakeDanaReyes123' },
};
const POST = `${LI}/feed/update/urn:li:activity:7380000000000000101/`;

type Shape = (doc: Document) => Document;
const SHAPES: readonly (readonly [string, Shape])[] = [
  ['as written', (doc) => doc],
  ['with a bare box around every element', boxEverything],
];

/** The control whose label (or, without one, words) is `label`, the `nth` of them. */
function control(doc: Document, label: string, nth = 0): Element {
  const found = [...doc.querySelectorAll('[role="button"], button, a[href]')].filter(
    (e) => (e.getAttribute('aria-label') ?? e.textContent?.trim()) === label,
  )[nth];
  if (!found) throw new Error(`No control "${label}" (${nth})`);
  return found;
}

/** Writes `words` in a box to write in: the `nth` with this placeholder or label. */
function write(doc: Document, placeholder: string, words: string, nth = 0): Element {
  const box = [
    ...doc.querySelectorAll(
      `[aria-placeholder="${placeholder}"], [aria-label="${placeholder}"], [placeholder="${placeholder}"]`,
    ),
  ][nth];
  if (!box) throw new Error(`No box "${placeholder}"`);
  if (box.tagName === 'TEXTAREA') (box as HTMLTextAreaElement).value = words;
  else box.querySelector('p')!.textContent = words;
  return box;
}

/** Empties a box, as sending does. */
function empty(box: Element): void {
  if (box.tagName === 'TEXTAREA') (box as HTMLTextAreaElement).value = '';
  else box.querySelector('p')!.replaceChildren(box.ownerDocument.createElement('br'));
}

/** Moves the box over the page from a hand-written fixture into `doc`, as LinkedIn opens it. */
function openBox(doc: Document, fixture: string, shape: Shape): Element {
  const box = shape(load(fixture, LI)).querySelector('[role="dialog"]')!;
  const wrapped = shape === boxEverything ? box.parentElement! : box;
  doc.body.append(doc.importNode(wrapped, true));
  return doc.querySelector('[role="dialog"]')!;
}

/** The step a noticed click or key notes now, or once its page says it went. */
function noted(noticed: Noticed | null) {
  if (!noticed || noticed.kind === 'answer' || noticed.kind === 'seen') return null;
  return noticed.kind === 'step' ? noticed.step : noticed.went() ? noticed.step : null;
}

describe.each(SHAPES)('LinkedIn, %s', (_, shape) => {
  const page = (fixture: string, url: string) => shape(load(fixture, url));

  describe('an invitation to connect', () => {
    const url = `${LI}/in/dana-reyes-4b2a1c/`;

    it('is noted once the box Connect opens sends it, without a note', () => {
      const doc = page('linkedin-profile.html', url);
      const noticer = linkedInNoticer();
      const pressed = noticer.click(control(doc, 'Invite Dana Reyes to connect'), doc, url);
      expect(pressed).toMatchObject({ kind: 'maybe', afterMs: CONNECT_LOOK_MS });
      if (pressed?.kind !== 'maybe') throw new Error('no maybe');
      expect(pressed.step).toEqual({
        kind: 'friend_request',
        // The profile's top card links her id in her mutual connections and her Message.
        to: danaWithId,
        group: null,
        postUrl: null,
        thread: null,
        replying: null,
      });
      openBox(doc, 'linkedin-invite-box.html', shape);
      // The box is open: its Send notes it, not the look after Connect.
      expect(pressed.went()).toBe(false);
      expect(noticer.click(control(doc, 'Send without a note'), doc, url)).toEqual({
        kind: 'step',
        step: pressed.step,
      });
      // Sent: a look after, and a second Send, note nothing more.
      expect(pressed.went()).toBe(false);
      expect(noticer.click(control(doc, 'Send without a note'), doc, url)).toBeNull();
    });

    it('is noted with a note too, and never for what the note says', () => {
      const doc = page('linkedin-profile.html', url);
      const noticer = linkedInNoticer();
      const pressed = noticer.click(control(doc, 'Invite Dana Reyes to connect'), doc, url);
      openBox(doc, 'linkedin-invite-note.html', shape);
      write(doc, 'Ex: We know each other from…', 'Loved your water heater post!');
      // Enter in the note's box starts a new line: the invitation goes with Send.
      const typed = doc.querySelector('textarea')!;
      expect(noticer.enter(typed, doc, url)).toBeNull();
      const sent = noticer.click(control(doc, 'Send invitation'), doc, url);
      expect(sent).toEqual({ kind: 'step', step: (pressed as { step: unknown }).step });
      expect(JSON.stringify(sent)).not.toContain('Loved');
    });

    it('is noted when LinkedIn sends it at once, with no box: Connect becomes Pending', () => {
      const doc = page('linkedin-profile.html', url);
      const noticer = linkedInNoticer();
      const connect = control(doc, 'Invite Dana Reyes to connect');
      const pressed = noticer.click(connect, doc, url);
      if (pressed?.kind !== 'maybe') throw new Error('no maybe');
      connect.setAttribute(
        'aria-label',
        'Pending, click to withdraw invitation sent to Dana Reyes',
      );
      connect.querySelector('span')!.textContent = 'Pending';
      expect(pressed.went()).toBe(true);
      // Once.
      expect(pressed.went()).toBe(false);
    });

    it('notes nothing when Connect did nothing, or the box was left', () => {
      const doc = page('linkedin-profile.html', url);
      const noticer = linkedInNoticer();
      const pressed = noticer.click(control(doc, 'Invite Dana Reyes to connect'), doc, url);
      // No box, and the button still says Connect.
      expect(noted(pressed)).toBeNull();
      // A box left open long past: its Send isn't the Connect's.
      let now = 0;
      const slow = linkedInNoticer(() => now);
      slow.click(control(doc, 'Invite Dana Reyes to connect'), doc, url);
      openBox(doc, 'linkedin-invite-box.html', shape);
      now = INVITE_WAIT_MS + 1;
      expect(slow.click(control(doc, 'Send without a note'), doc, url)).toBeNull();
    });

    it('notes nothing when the box names someone else than the Connect was for', () => {
      const doc = page('linkedin-profile.html', url);
      const noticer = linkedInNoticer();
      // Quinn Harper, in the column beside the profile.
      const pressed = noticer.click(control(doc, 'Invite Quinn Harper to connect'), doc, url);
      expect(pressed?.kind === 'maybe' && pressed.step.to).toEqual({
        name: 'Quinn Harper',
        profile: byName('quinnharper'),
      });
      openBox(doc, 'linkedin-invite-box.html', shape);
      // The box says it's Dana's.
      expect(noticer.click(control(doc, 'Send without a note'), doc, url)).toBeNull();
    });

    it('notes a Connect under More as the profile’s', () => {
      const doc = page('linkedin-profile.html', url);
      const follow = control(doc, 'Follow Dana Reyes');
      follow.setAttribute('aria-label', 'Invite Dana Reyes to connect');
      follow.querySelector('span')!.textContent = 'Connect';
      const pressed = linkedInNoticer().click(follow, doc, url, true);
      expect(pressed?.kind === 'maybe' && pressed.step.to).toEqual(danaWithId);
    });

    it('notes a Connect drawn as LinkedIn’s link to its box, by the name in its address', () => {
      const search = `${LI}/search/results/people/?keywords=plumber`;
      const doc = page('linkedin-search-people.html', search);
      const pending = control(doc, 'Pending, click to withdraw invitation sent to Morgan Ellis');
      pending.insertAdjacentHTML(
        'beforebegin',
        '<a href="/preload/search-custom-invite/?vanityName=morgan-ellis-3" aria-label="Invite Morgan Ellis to connect"><span>Connect</span></a>',
      );
      pending.remove();
      const pressed = linkedInNoticer().click(
        control(doc, 'Invite Morgan Ellis to connect'),
        doc,
        search,
      );
      expect(pressed?.kind === 'maybe' && pressed.step.to).toEqual({
        name: 'Morgan Ellis',
        profile: byName('morgan-ellis-3'),
      });
    });

    it('notes a Connect in people search, to the one person its row names', () => {
      const search = `${LI}/search/results/people/?keywords=plumber`;
      const doc = page('linkedin-search-people.html', search);
      const noticer = linkedInNoticer();
      const inner = control(doc, 'Invite Dana Reyes to connect').querySelector('span')!;
      const pressed = noticer.click(inner, doc, search);
      // The link to her carries her id too.
      expect(pressed?.kind === 'maybe' && pressed.step.to).toEqual(danaWithId);
      openBox(doc, 'linkedin-invite-box.html', shape);
      expect(noted(noticer.click(control(doc, 'Send without a note'), doc, search))).toMatchObject({
        kind: 'friend_request',
        to: danaWithId,
      });
    });

    it('is saved as LinkedIn’s, with LinkedIn’s ids', () => {
      const doc = page('linkedin-profile.html', url);
      const pressed = linkedInNoticer().click(
        control(doc, 'Invite Dana Reyes to connect'),
        doc,
        url,
      );
      if (pressed?.kind !== 'maybe') throw new Error('no maybe');
      expect(touchSave(pressed.step, WS, null, 'linkedin')).toEqual({
        ok: true,
        input: {
          workspaceId: WS,
          platform: 'linkedin',
          kind: 'friend_request',
          profile: {
            id: 'ACoAAFakeDanaReyes123',
            username: 'dana-reyes-4b2a1c',
            url: `${LI}/in/dana-reyes-4b2a1c/`,
          },
          name: 'Dana Reyes',
          group: null,
          postUrl: null,
          threadKey: null,
          replying: null,
          auto: false,
        },
      });
      // A LinkedIn profile is never saved as a Facebook one.
      expect(touchSave(pressed.step, WS).ok).toBe(false);
    });
  });

  describe('Accept and Ignore', () => {
    const url = `${LI}/mynetwork/invitation-manager/received/`;

    it('notes Accept as a yes and Ignore as a no, with their mutual connections', () => {
      const doc = page('linkedin-invitations.html', url);
      const noticer = linkedInNoticer();
      expect(noticer.click(control(doc, 'Accept Jordan Blake’s invitation'), doc, url)).toEqual({
        kind: 'answer',
        answered: {
          answer: 'confirm',
          to: { name: 'Jordan Blake', profile: byName('jordan-blake-09') },
          mutualFriends: 4,
        },
      });
      // Its words inside the button, and the one whose face beside it is a mutual connection's.
      const ignore = control(doc, 'Ignore an invitation to connect from Taylor Reed');
      expect(noticer.click(ignore.querySelector('span')!, doc, url)).toEqual({
        kind: 'answer',
        answered: {
          answer: 'delete',
          to: { name: 'Taylor Reed', profile: byName('taylor-reed-5') },
          mutualFriends: 1,
        },
      });
    });

    it('notes nothing for an invitation to follow a page', () => {
      const doc = page('linkedin-invitations.html', url);
      const noticer = linkedInNoticer();
      expect(
        noticer.click(control(doc, 'Accept an invitation to follow Lane Landscaping'), doc, url),
      ).toBeNull();
      expect(
        noticer.click(control(doc, 'Ignore an invitation to follow Lane Landscaping'), doc, url),
      ).toBeNull();
    });

    it('notes Accept at the top of the profile of whoever sent it', () => {
      const profile = `${LI}/in/dana-reyes-4b2a1c/`;
      const doc = page('linkedin-profile.html', profile);
      const connect = control(doc, 'Invite Dana Reyes to connect');
      connect.setAttribute('aria-label', 'Accept Dana Reyes’s invitation');
      connect.querySelector('span')!.textContent = 'Accept';
      const noticed = linkedInNoticer().click(connect, doc, profile);
      expect(noticed).toEqual({
        kind: 'answer',
        answered: { answer: 'confirm', to: danaWithId, mutualFriends: 12 },
      });
      if (noticed?.kind !== 'answer') throw new Error('no answer');
      expect(friendNote(noticed.answered, WS, 'linkedin')).toMatchObject({
        ok: true,
        input: { platform: 'linkedin', answer: 'confirm', mutualFriends: 12 },
      });
    });
  });

  describe('likes', () => {
    const url = POST;

    it('notes a post’s Like, to whoever wrote it, with the post', () => {
      const doc = page('linkedin-post-commenting.html', url);
      expect(linkedInNoticer().click(control(doc, 'React Like'), doc, url)).toEqual({
        kind: 'step',
        step: {
          kind: 'like',
          to: dana,
          group: null,
          postUrl: POST,
          thread: null,
          replying: null,
        },
      });
    });

    it('notes a reaction picked over Like, while the post has none of theirs', () => {
      const doc = page('linkedin-post-commenting.html', url);
      const noticer = linkedInNoticer();
      expect(noted(noticer.click(control(doc, 'Celebrate'), doc, url))).toMatchObject({
        kind: 'like',
        to: dana,
      });
      // Pressed already: another reaction changes it, and "Unreact" takes it back. Neither is a new one.
      const like = control(doc, 'React Like');
      like.setAttribute('aria-pressed', 'true');
      expect(noticer.click(control(doc, 'Celebrate'), doc, url)).toBeNull();
      expect(noticer.click(like, doc, url)).toBeNull();
      like.setAttribute('aria-pressed', 'false');
      like.setAttribute('aria-label', 'Unreact Like');
      expect(noticer.click(like, doc, url)).toBeNull();
    });

    it('notes a comment’s Like, to whoever wrote the comment', () => {
      const doc = page('linkedin-post-commenting.html', url);
      expect(
        noted(
          linkedInNoticer().click(control(doc, 'React Like to Avery Lane’s comment'), doc, url),
        ),
      ).toMatchObject({ kind: 'like', to: { name: 'Avery Lane', profile: byName('averylane') } });
    });

    it('notes likes in the feed, and nothing on a company’s post', () => {
      const feed = `${LI}/feed/`;
      const doc = page('linkedin-feed.html', feed);
      const noticer = linkedInNoticer();
      expect(noted(noticer.click(control(doc, 'React Like', 1), doc, feed))).toMatchObject({
        kind: 'like',
        to: { name: 'Avery Lane', profile: byName('averylane') },
        postUrl: `${LI}/feed/update/urn:li:activity:7380000000000000202/`,
      });
      expect(
        noted(noticer.click(control(doc, 'React Like to Sam Lee’s comment'), doc, feed)),
      ).toMatchObject({ to: { name: 'Sam Lee', profile: byName('sam-lee-77') } });
      // Acme Plumbing's: a company, not a person.
      expect(noticer.click(control(doc, 'React Like', 2), doc, feed)).toBeNull();
    });
  });

  describe('comments', () => {
    const url = POST;

    it('notes a comment sent with its button, to whoever wrote the post, and never what it says', () => {
      const doc = page('linkedin-post-commenting.html', url);
      const noticer = linkedInNoticer();
      // Empty, the button sends nothing; the bar's Comment only opens the box.
      expect(noticer.click(control(doc, 'Comment', 1), doc, url)).toBeNull();
      write(doc, 'Add a comment…', 'Fourteen years is a good run!');
      expect(noticer.click(control(doc, 'Comment', 0), doc, url)).toBeNull();
      const sent = noticer.click(control(doc, 'Comment', 1), doc, url);
      expect(sent).toEqual({
        kind: 'step',
        step: {
          kind: 'comment',
          to: dana,
          group: null,
          postUrl: POST,
          thread: null,
          replying: null,
        },
      });
      expect(JSON.stringify(sent)).not.toContain('Fourteen');
    });

    it('notes a reply, to whoever wrote the comment it’s under', () => {
      const doc = page('linkedin-post-commenting.html', url);
      write(doc, 'Add a reply…', 'Sam Lee same here');
      expect(noted(linkedInNoticer().click(control(doc, 'Reply', 0), doc, url))).toMatchObject({
        kind: 'comment',
        to: { name: 'Sam Lee', profile: byName('sam-lee-77') },
        postUrl: POST,
      });
    });

    it('notes Enter only once the box empties: Enter may only start a new line', () => {
      const doc = page('linkedin-post-commenting.html', url);
      const noticer = linkedInNoticer();
      const box = write(doc, 'Add a comment…', 'Great tip');
      const pressed = noticer.enter(box.querySelector('p')!, doc, url);
      expect(pressed).toMatchObject({ kind: 'maybe', afterMs: ENTER_LOOK_MS });
      if (pressed?.kind !== 'maybe') throw new Error('no maybe');
      expect(pressed.step).toMatchObject({ kind: 'comment', to: dana });
      expect(pressed.went()).toBe(false);
      empty(box);
      expect(pressed.went()).toBe(true);
    });

    it('notes Enter once when the button sent it just after', () => {
      const doc = page('linkedin-post-commenting.html', url);
      const noticer = linkedInNoticer();
      const box = write(doc, 'Add a comment…', 'Great tip');
      const pressed = noticer.enter(box, doc, url);
      expect(noted(noticer.click(control(doc, 'Comment', 1), doc, url))).toMatchObject({
        kind: 'comment',
      });
      empty(box);
      expect(pressed?.kind === 'maybe' && pressed.went()).toBe(false);
    });
  });

  describe('messages', () => {
    const url = `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`;

    it('notes Send in a conversation, to who it’s with, with its id, answering their last message', () => {
      const doc = page('linkedin-chat.html', url);
      const noticer = linkedInNoticer();
      expect(noticer.click(control(doc, 'Send'), doc, url)).toBeNull();
      write(doc, 'Write a message…', 'Tuesday at 10 then. Talk soon!');
      const sent = noticer.click(control(doc, 'Send'), doc, url);
      expect(sent).toEqual({
        kind: 'step',
        step: {
          kind: 'message',
          to: {
            name: 'Dana Reyes',
            profile: {
              id: 'ACoAAFakeDanaReyes123',
              username: null,
              url: `${LI}/in/ACoAAFakeDanaReyes123/`,
            },
          },
          group: null,
          postUrl: null,
          thread: {
            id: '2-MadeUpThreadDana0001==',
            encrypted: false,
            url: `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`,
          },
          replying: true,
        },
      });
      expect(JSON.stringify(sent)).not.toContain('Tuesday at 10');
      if (sent?.kind !== 'step') throw new Error('no step');
      expect(touchSave(sent.step, WS, null, 'linkedin')).toMatchObject({
        ok: true,
        input: { platform: 'linkedin', kind: 'message', threadKey: '2-MadeUpThreadDana0001==' },
      });
    });

    it('notes Enter in a conversation once the box empties', () => {
      const doc = page('linkedin-chat.html', url);
      const box = write(doc, 'Write a message…', 'See you then');
      const pressed = linkedInNoticer().enter(box, doc, url);
      if (pressed?.kind !== 'maybe') throw new Error('no maybe');
      expect(pressed.step).toMatchObject({ kind: 'message', to: { name: 'Dana Reyes' } });
      expect(pressed.went()).toBe(false);
      empty(box);
      expect(pressed.went()).toBe(true);
    });

    it('notes a message in a chat window over another page, to the one person it’s with', () => {
      const feed = `${LI}/feed/`;
      const doc = page('linkedin-chat-window.html', feed);
      write(doc, 'Write a message…', 'Happy to show you on a call.');
      expect(noted(linkedInNoticer().click(control(doc, 'Send'), doc, feed))).toEqual({
        kind: 'message',
        to: dana,
        group: null,
        postUrl: null,
        thread: null,
        replying: null,
      });
    });

    it('notes nothing in a chat window with more than one other person', () => {
      const feed = `${LI}/feed/`;
      const doc = page('linkedin-chat-window.html', feed);
      const header = doc.querySelector('h2 a')!;
      header.insertAdjacentHTML(
        'afterend',
        `<a href="${LI}/in/sam-lee-77/"><span>Sam Lee</span></a>`,
      );
      write(doc, 'Write a message…', 'Hi both');
      expect(linkedInNoticer().click(control(doc, 'Send'), doc, feed)).toBeNull();
    });
  });

  it('notes nothing to yourself', () => {
    const url = `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`;
    const doc = page('linkedin-chat.html', url);
    // Your own name on the top bar's Me is the conversation's: a chat with yourself.
    doc.querySelector('header img')!.setAttribute('alt', 'Dana Reyes');
    write(doc, 'Write a message…', 'Note to self');
    expect(linkedInNoticer().click(control(doc, 'Send'), doc, url)).toBeNull();
  });
});

describe('a LinkedIn tab’s kit', () => {
  it('is LinkedIn’s by its address, and never for another site', () => {
    expect(kitOf(`${LI}/feed/`)?.platform).toBe('linkedin');
    expect(kitOf('https://www.facebook.com/')?.platform).toBe('facebook');
    expect(kitOf('https://www.linkedin.com.example.com/feed/')).toBeNull();
    expect(kitOf('https://example.com/?u=https://www.linkedin.com/')).toBeNull();
  });
});
