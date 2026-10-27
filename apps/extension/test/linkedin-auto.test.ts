/**
 * The presses LinkedIn's runner makes on its own (src/networks/linkedin/auto.ts), on hand-written pages of made-up
 * people, each as written and again with a bare box around every element: a like on the first post of theirs nothing
 * rules out, Connect without a note (in the top card, or under More), a comment in the post's own box and never a
 * reply's, and a message only in the conversation with them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connect,
  likeTheirPost,
  openMessage,
  theirPosts,
  writeComment,
  writeMessage,
} from '../src/networks/linkedin/auto';
import { readPage } from '../src/networks/linkedin/page';
import type { ProfileRef } from '../src/networks/linkedin/types';
import { boxEverything, load } from './load';

const LI = 'https://www.linkedin.com';
const DANA = `${LI}/in/dana-reyes-4b2a1c/`;
const ACTIVITY = `${DANA}recent-activity/all/`;
const dana: ProfileRef = { id: null, username: 'dana-reyes-4b2a1c', url: DANA };
const sam: ProfileRef = { id: null, username: 'sam-lee-77', url: `${LI}/in/sam-lee-77/` };

const asWrittenAndBoxed = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

const page = (fixture: string, url: string, boxed: boolean) => {
  const doc = load(fixture, url);
  return boxed ? boxEverything(doc) : doc;
};

/** A button LinkedIn behaves as: pressing a Like presses it. */
function likes(doc: Document) {
  for (const like of doc.querySelectorAll('[aria-label="React Like"]'))
    like.addEventListener('click', () => like.setAttribute('aria-pressed', 'true'));
}

/** A box to write in that takes typing as Chrome does, and empties when its button sends it. */
function typing(doc: Document) {
  let into: Element | null = null;
  for (const box of doc.querySelectorAll('[role="textbox"]'))
    box.addEventListener('click', () => (into = box));
  doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
    if (into) into.textContent = text ?? '';
    return true;
  };
  const sent: string[] = [];
  for (const button of doc.querySelectorAll('button[type="submit"]'))
    button.addEventListener('click', () => {
      const box = button.closest('form')!.querySelector('[role="textbox"]')!;
      sent.push(box.textContent ?? '');
      box.textContent = '';
    });
  return sent;
}

afterEach(() => vi.useRealTimers());

describe('liking a post of theirs', () => {
  it.each(asWrittenAndBoxed)('reads only the posts they wrote, %s', (_, boxed) => {
    const doc = page('linkedin-activity.html', ACTIVITY, boxed);
    expect(theirPosts(doc, ACTIVITY, dana).map((f) => f.post)).toEqual([
      {
        url: `${LI}/feed/update/urn:li:activity:7380000000000000302/`,
        when: '3d',
        text: 'Spring is the time to check your water heater. Ours ran 14 years.',
        pictures: [],
        liked: false,
      },
      expect.objectContaining({ url: `${LI}/feed/update/urn:li:activity:7380000000000000303/` }),
      expect.objectContaining({ url: `${LI}/feed/update/urn:li:activity:7380000000000000304/` }),
    ]);
    expect(theirPosts(doc, ACTIVITY, sam)).toHaveLength(1);
  });

  it.each(asWrittenAndBoxed)(
    'presses its own Like, and says so once it shows, %s',
    async (_, boxed) => {
      const doc = page('linkedin-activity.html', ACTIVITY, boxed);
      likes(doc);
      const url = `${LI}/feed/update/urn:li:activity:7380000000000000304/`;
      expect(await likeTheirPost(doc, ACTIVITY, dana, { index: 2, url })).toEqual({
        result: 'done',
        postUrl: url,
      });
      expect(doc.getElementById('like-304')!.getAttribute('aria-pressed')).toBe('true');
      expect(doc.getElementById('like-302')!.getAttribute('aria-pressed')).toBe('false');
      // Liked now: pressing again would take it off, so it doesn't.
      expect((await likeTheirPost(doc, ACTIVITY, dana, { index: 2, url })).result).toBe('already');
      expect(theirPosts(doc, ACTIVITY, dana)[2]!.post.liked).toBe(true);
    },
  );

  it('says so when the page doesn’t take the like', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const doc = page('linkedin-activity.html', ACTIVITY, false);
    const liking = likeTheirPost(doc, ACTIVITY, dana, { index: 0, url: null });
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await liking).result).toBe('not_sent');
  });
});

describe('connecting without a note', () => {
  /** The profile as LinkedIn behaves: Connect opens the box; Send without a note sends it, and it says Pending. */
  function profile(fixture: string, url: string, name: string, boxed: boolean) {
    const doc = page(fixture, url, boxed);
    const pressed: string[] = [];
    const connect = doc.querySelector(`[aria-label="Invite ${name} to connect"]`)!;
    connect.addEventListener('click', () => {
      pressed.push('Connect');
      const box = load('linkedin-invite-box.html', url);
      if (boxed) boxEverything(box);
      const dialog = doc.importNode(box.querySelector('[role="dialog"]')!, true);
      doc.body.append(dialog);
      dialog.querySelector('[aria-label="Send without a note"]')!.addEventListener('click', () => {
        pressed.push('Send without a note');
        dialog.remove();
        connect.insertAdjacentHTML(
          'beforebegin',
          `<button aria-label="Pending, click to withdraw invitation sent to ${name}"><span>Pending</span></button>`,
        );
        connect.remove();
      });
      dialog.querySelector('[aria-label="Add a note"]')!.addEventListener('click', () => {
        pressed.push('Add a note');
      });
    });
    return { doc, pressed };
  }

  it.each(asWrittenAndBoxed)(
    'presses Connect, then Send without a note, and sees Pending, %s',
    async (_, boxed) => {
      const { doc, pressed } = profile('linkedin-profile.html', DANA, 'Dana Reyes', boxed);
      expect(await connect(doc, DANA)).toBe('done');
      expect(pressed).toEqual(['Connect', 'Send without a note']);
      expect(readPage(doc, DANA).profile?.connection).toBe('pending');
      // Pending now: nothing more to send.
      expect(await connect(doc, DANA)).toBe('already');
    },
  );

  it.each(asWrittenAndBoxed)(
    'finds Connect under More when Follow comes first, %s',
    async (_, boxed) => {
      const url = `${LI}/in/sam-lee-77/`;
      const { doc, pressed } = profile('linkedin-profile-follow.html', url, 'Sam Lee', boxed);
      const more = doc.querySelector('[aria-label="More actions"]')!;
      more.addEventListener('click', () => {
        more.setAttribute('aria-expanded', 'true');
        for (const menu of doc.querySelectorAll('main [aria-hidden="true"]'))
          if (menu.querySelector('[aria-label="Invite Sam Lee to connect"]'))
            menu.removeAttribute('aria-hidden');
      });
      expect(await connect(doc, url)).toBe('done');
      expect(pressed).toEqual(['Connect', 'Send without a note']);
    },
  );

  it('never types a note, and leaves a box that asks for more to the person', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const doc = load('linkedin-profile.html', DANA);
    doc
      .querySelector('[aria-label="Invite Dana Reyes to connect"]')!
      .addEventListener('click', () =>
        doc.body.insertAdjacentHTML(
          'beforeend',
          '<div role="dialog"><h2>To verify this member knows you, enter their email to connect.</h2>' +
            '<label for="em">Email</label><input id="em" type="email" />' +
            '<button><span>Send</span></button></div>',
        ),
      );
    const going = connect(doc, DANA);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await going).toBe('none');
    expect(doc.querySelector<HTMLInputElement>('#em')!.value).toBe('');
  });

  it('presses nothing on a profile you’re connected with already', async () => {
    const doc = load('linkedin-profile.html', DANA);
    for (const degree of doc.querySelectorAll('main span[aria-hidden="true"]'))
      if (degree.textContent === '· 2nd') degree.textContent = '· 1st';
    doc.querySelector('[aria-label="Invite Dana Reyes to connect"]')!.remove();
    expect(await connect(doc, DANA)).toBe('none');
  });
});

describe('commenting in the post’s own box', () => {
  const POST = `${LI}/feed/update/urn:li:activity:7380000000000000101/`;

  it.each(asWrittenAndBoxed)(
    'types into its box, never the reply’s, and sends it with its button, %s',
    async (_, boxed) => {
      const doc = page('linkedin-post-commenting.html', POST, boxed);
      const sent = typing(doc);
      const reply = doc.querySelector('[aria-placeholder="Add a reply…"]')!;
      const before = reply.textContent;
      expect(await writeComment(doc, 'Good reminder: ours went at 12 years.')).toBe('done');
      expect(sent).toEqual(['Good reminder: ours went at 12 years.']);
      expect(reply.textContent).toBe(before);
    },
  );

  it('opens the box with the post’s own Comment when it isn’t open', async () => {
    const doc = load('linkedin-post-commenting.html', POST);
    const sent = typing(doc);
    const form = doc.querySelector('[aria-placeholder="Add a comment…"]')!.closest('form')!;
    const holder = form.parentElement!;
    form.remove();
    doc
      .querySelector('[aria-label="Comment"]')!
      .addEventListener('click', () => holder.append(form));
    expect(await writeComment(doc, 'Same here.')).toBe('done');
    expect(sent).toEqual(['Same here.']);
  });

  it('leaves a box with writing in it alone', async () => {
    const doc = load('linkedin-post-commenting.html', POST);
    typing(doc);
    doc.querySelector('[aria-placeholder="Add a comment…"]')!.textContent = 'Half a thought';
    expect(await writeComment(doc, 'Same here.')).toBe('not_sent');
  });
});

describe('writing a message only in the conversation with them', () => {
  const THREAD = `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`;

  it.each(asWrittenAndBoxed)('in their conversation’s own page, %s', async (_, boxed) => {
    const doc = page('linkedin-chat.html', THREAD, boxed);
    const sent = typing(doc);
    expect(await writeMessage(doc, THREAD, 'Glad to help, Dana.', dana)).toBe('done');
    expect(sent).toEqual(['Glad to help, Dana.']);
  });

  it.each(asWrittenAndBoxed)(
    'in the window over the page that links to them, %s',
    async (_, boxed) => {
      const doc = page('linkedin-chat-window.html', `${LI}/feed/`, boxed);
      const sent = typing(doc);
      expect(await writeMessage(doc, `${LI}/feed/`, 'Glad to help, Dana.', dana)).toBe('done');
      expect(sent).toEqual(['Glad to help, Dana.']);
    },
  );

  describe('on the new conversation’s page Message opens, drawn in LinkedIn’s interop frame', () => {
    const NEW = `${LI}/messaging/thread/new/?recipient=ACoAAFakeDanaReyes123&screenContext=NON_SELF_PROFILE_VIEW`;

    /** The page as LinkedIn draws it: its Send off till something's written, and writing in the frame's own page. */
    function newConversation() {
      const doc = load('linkedin-profile.html', NEW);
      const frame = doc.createElement('iframe');
      frame.setAttribute('data-testid', 'interop-iframe');
      doc.body.append(frame);
      const inner = frame.contentDocument!;
      inner.body.innerHTML = load('linkedin-chat.html', `${LI}/messaging/`).querySelector(
        'main',
      )!.outerHTML;
      const box = inner.querySelector('[role="textbox"]')!;
      const send = inner.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      send.disabled = true;
      inner.execCommand = (_command: string, _ui?: boolean, text?: string) => {
        box.textContent = text ?? '';
        send.disabled = !box.textContent;
        return true;
      };
      const sent: string[] = [];
      send.addEventListener('click', () => {
        sent.push(box.textContent ?? '');
        box.textContent = '';
      });
      return { doc, sent };
    }

    it('writes in its box and sends it once Send comes on', async () => {
      const { doc, sent } = newConversation();
      expect(await writeMessage(doc, NEW, 'Glad to help, Dana.', dana)).toBe('done');
      expect(sent).toEqual(['Glad to help, Dana.']);
    });

    it('writes nothing when its address names someone else', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const { doc, sent } = newConversation();
      const someoneElse: ProfileRef = {
        id: 'ACoAAFakeSomeoneElse999',
        username: null,
        url: `${LI}/in/ACoAAFakeSomeoneElse999/`,
      };
      const writing = writeMessage(doc, NEW, 'Hi', someoneElse);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await writing).toBe('none');
      expect(sent).toEqual([]);
    });
  });

  it('in the window LinkedIn draws in its interop box, out of the page’s reach', async () => {
    const doc = load('linkedin-profile.html', DANA);
    const host = doc.createElement('div');
    host.setAttribute('data-testid', 'interop-shadowdom');
    doc.body.append(host);
    const inside = host.attachShadow({ mode: 'open' });
    const from = load('linkedin-chat-window.html', DANA);
    inside.append(doc.importNode(from.querySelector('aside[aria-label="Messaging"]')!, true));
    const box = inside.querySelector('[role="textbox"]')!;
    doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
      box.textContent = text ?? '';
      return true;
    };
    const sent: string[] = [];
    inside.querySelector('button[type="submit"]')!.addEventListener('click', () => {
      sent.push(box.textContent ?? '');
      box.textContent = '';
    });
    expect(await writeMessage(doc, DANA, 'Glad to help, Dana.', dana)).toBe('done');
    expect(sent).toEqual(['Glad to help, Dana.']);
  });

  it('writes nothing when the window is someone else’s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const doc = load('linkedin-chat-window.html', `${LI}/feed/`);
    const sent = typing(doc);
    const writing = writeMessage(doc, `${LI}/feed/`, 'Hi', sam);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await writing).toBe('none');
    expect(sent).toEqual([]);
  });

  it('never writes in the last person’s window, though its messages link to them or it links to nobody', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    // Dana's window, still open as Sam's is opened: one of her messages links to Sam.
    const shared = load('linkedin-chat-window.html', `${LI}/feed/`);
    const sentShared = typing(shared);
    shared
      .querySelector('p[dir="ltr"]')!
      .insertAdjacentHTML('beforeend', ` <a href="${LI}/in/sam-lee-77/">Sam Lee</a>`);
    const writing = writeMessage(shared, `${LI}/feed/`, 'Hi Sam', sam);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await writing).toBe('none');
    expect(sentShared).toEqual([]);
    // Dana's window links to nobody, and Sam's has drawn its header beside it, but not its box yet.
    const unlinked = load('linkedin-chat-window.html', `${LI}/feed/`);
    const sentUnlinked = typing(unlinked);
    for (const link of unlinked.querySelectorAll('aside a')) link.replaceWith(...link.childNodes);
    unlinked
      .querySelector('aside')!
      .insertAdjacentHTML(
        'beforeend',
        `<div><h2><a href="${LI}/in/sam-lee-77/">Sam Lee</a></h2></div>`,
      );
    const again = writeMessage(unlinked, `${LI}/feed/`, 'Hi Sam', sam);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await again).toBe('none');
    expect(sentUnlinked).toEqual([]);
    expect(unlinked.querySelector('[role="textbox"]')!.textContent?.trim()).toBe('');
  });

  it('sends nothing, and takes the writing out, when the focus isn’t in their box or the window changes as it’s typed', async () => {
    for (const trouble of ['focus', 'header'] as const) {
      const doc = load('linkedin-chat-window.html', `${LI}/feed/`);
      const sent = typing(doc);
      const box = doc.querySelector<HTMLElement>('[role="textbox"]')!;
      const type = doc.execCommand;
      if (trouble === 'focus') box.focus = () => undefined;
      else
        doc.execCommand = (command: string, ui?: boolean, text?: string) => {
          const typed = type.call(doc, command, ui, text);
          if (command === 'insertText')
            doc.querySelector('h2 a')!.setAttribute('href', `${LI}/in/sam-lee-77/`);
          return typed;
        };
      expect(await writeMessage(doc, `${LI}/feed/`, 'Glad to help, Dana.', dana)).toBe(
        'not_theirs',
      );
      expect(sent).toEqual([]);
      expect(box.textContent?.trim()).toBe('');
    }
  });

  it('presses Message on their profile', () => {
    const doc = load('linkedin-profile.html', DANA);
    let pressed = false;
    doc
      .querySelector('[aria-label="Message Dana Reyes"]')!
      .addEventListener('click', (event) => ((pressed = true), event.preventDefault()));
    expect(openMessage(doc)).toBe(true);
    expect(pressed).toBe(true);
  });
});
