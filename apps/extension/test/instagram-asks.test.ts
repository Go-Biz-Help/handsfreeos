/**
 * What the person asks of their computer on Instagram (the Instagram and Alignable plan's part 12; src/jobs/instagram):
 * Save my followers opens their own account from Instagram's menu, then the box of their followers over it, scrolls the
 * box a screen at a time to its end, and saves everyone as Instagram's friends list, where a follow-back counts as
 * accepting. On a box drawn as Instagram usually draws it, till the owner's next Check outlines his own.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { instagramListSave } from '../src/hfos/saves';
import { KITS } from '../src/networks';
import { openChat, scrollDialog } from '../src/networks/instagram/browse';
import { unfollow } from '../src/networks/instagram/unfollow';
import type { Hfos, Job, JobTab } from '../src/jobs/job';

// A person's pace between screens, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const IG = 'https://www.instagram.com';
const MENU = `<div><a role="link" href="/"><span>Home</span></a>
  <a role="link" href="/me.owner/"><span dir="auto"><span>Profile</span></span></a></div>`;

const row = (username: string, name: string, followBack: boolean) =>
  `<div><a role="link" href="/${username}/"><img alt=""></a>
    <div><div><a role="link" href="/${username}/"><span dir="auto">${username}</span></a>
      ${followBack ? '' : '<span>·</span><div role="button">Follow</div>'}</div>
      <span dir="auto">${name}</span></div>
    <div><button><div dir="auto">Remove</div></button></div></div>`;

const PEOPLE = [
  ['dana.reyes', 'Dana Reyes', false],
  ['sam.lee', 'Sam Lee', true],
  ['kim_bakes', 'Kim Bakes', true],
] as const;

/**
 * Their followers' box over their profile: two rows drawn, and the third once the box is scrolled; its list is the part
 * that scrolls, taller inside than it shows till it's at its end.
 */
function followers(): Document {
  const doc = new JSDOM(
    `<!doctype html><html><body>${MENU}<main><header><h2>me.owner</h2></header></main>
      <div role="dialog"><div><h1>Followers</h1>
        <div id="list" style="overflow-y: auto">${row(...PEOPLE[0])}${row(...PEOPLE[1])}</div></div></div>
    </body></html>`,
    { url: `${IG}/me.owner/followers/` },
  ).window.document;
  const list = doc.querySelector<HTMLElement>('#list')!;
  let top = 0;
  let height = 800;
  Object.defineProperty(list, 'clientHeight', { get: () => 400 });
  Object.defineProperty(list, 'scrollHeight', { get: () => height });
  Object.defineProperty(list, 'scrollTop', { get: () => top });
  list.scrollBy = (() => {
    top = height - 400;
    if (height === 800) {
      list.insertAdjacentHTML('beforeend', row(...PEOPLE[2]));
      height = 1000;
    }
  }) as typeof list.scrollBy;
  return doc;
}

const home = () =>
  new JSDOM(`<!doctype html><html><body>${MENU}<main><article></article></main></body></html>`, {
    url: `${IG}/`,
  }).window.document;

/** A tab on Instagram that opens the pages above by their address, reading and working as its tab does. */
function instagramTab(pages: Record<string, () => Document>) {
  const kit = KITS.instagram;
  const opened: string[] = [];
  let doc: Document | null = null;
  const tab = {
    async open(url: string) {
      const path = new URL(url).pathname;
      const make = pages[path];
      if (!make) throw new Error(`Not expected: ${url}`);
      opened.push(path);
      doc = make();
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      return work();
    },
    async close() {},
    async ask(message: { readonly type: string }) {
      const page = doc!;
      const at = page.location.href;
      if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(page, at) };
      vi.stubGlobal('location', new URL(at));
      vi.stubGlobal('document', page);
      try {
        return (await kit.work!(message)) ?? { ok: false, error: `Not expected: ${message.type}` };
      } finally {
        vi.unstubAllGlobals();
      }
    },
  } as unknown as JobTab;
  return { tab, opened };
}

function instagramJob(tab: JobTab, answers: Record<string, (input: unknown) => unknown> = {}) {
  const sent: { type: string; input: unknown }[] = [];
  const job: Job = {
    tab,
    hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
      sent.push({ type: ask.type, input: ask.input });
      const answer = answers[ask.type];
      return { ok: true, value: answer ? answer(ask.input) : {} };
    }) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
  };
  return { job, sent };
}

describe('Instagram’s lists in the page', () => {
  it('scrolls the followers’ box, never the page behind it, till its end', () => {
    const doc = followers();
    expect(doc.querySelectorAll('[role="dialog"] a[href="/kim_bakes/"]')).toHaveLength(0);
    expect(scrollDialog(doc)).toBe(true);
    expect(doc.querySelectorAll('[role="dialog"] a[href="/kim_bakes/"]')).toHaveLength(2);
    expect(scrollDialog(doc)).toBe(true);
    expect(scrollDialog(doc)).toBe(false);
  });

  it('opens a chat from the side of their messages by its row, and says when there’s none', () => {
    const doc = new JSDOM(
      `<!doctype html><html><body>
        <div role="button" id="note"><div>Your note</div></div>
        <div role="button" id="dana"><span title="Dana Reyes">Dana Reyes</span><span>You: See you</span><abbr>3d</abbr></div>
      </body></html>`,
    ).window.document;
    let opened = '';
    for (const r of doc.querySelectorAll<HTMLElement>('[role="button"]'))
      r.addEventListener('click', () => (opened = r.id));
    expect(openChat(doc)).toBe(true);
    expect(opened).toBe('dana');
    expect(openChat(new JSDOM('<body></body>').window.document)).toBe(false);
  });

  it('saves each follower once, by their username, named as Instagram shows them', () => {
    expect(
      instagramListSave(
        [
          { username: 'dana.reyes', url: `${IG}/dana.reyes/`, name: 'Dana Reyes' },
          { username: 'Dana.Reyes', url: `${IG}/Dana.Reyes/`, name: 'Dana Reyes' },
          { username: 'kim_bakes', url: `${IG}/kim_bakes/`, name: null },
          { username: 'nobody', url: 'https://example.com/nobody/', name: 'Nobody' },
        ],
        'b',
      ),
    ).toEqual({
      ok: true,
      input: [
        {
          workspaceId: 'b',
          platform: 'instagram',
          list: 'friends',
          people: [
            {
              name: 'Dana Reyes',
              profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
              mutualFriends: null,
            },
            {
              name: 'kim_bakes',
              profile: { id: null, username: 'kim_bakes', url: `${IG}/kim_bakes/` },
              mutualFriends: null,
            },
          ],
        },
      ],
    });
    expect(instagramListSave([], 'b')).toMatchObject({ ok: false });
  });
});

describe('Save my followers, on Instagram', () => {
  it('opens their own account’s followers from the menu, reads the box to its end, and saves them', async () => {
    const { tab, opened } = instagramTab({ '/': home, '/me.owner/followers/': followers });
    const { job, sent } = instagramJob(tab, { 'hfos-save-friends': () => ({ added: 2 }) });
    const end = await runAsk({ kind: 'friends' }, job, 'instagram');
    expect(opened).toEqual(['/', '/me.owner/followers/']);
    const saved = sent.find((s) => s.type === 'hfos-save-friends')!.input as {
      list: string;
      platform: string;
      people: { name: string; profile: { username: string } }[];
    };
    expect(saved).toMatchObject({ list: 'friends', platform: 'instagram' });
    expect(saved.people.map((p) => p.profile.username)).toEqual([
      'dana.reyes',
      'sam.lee',
      'kim_bakes',
    ]);
    expect(end).toEqual({ line: 'Saved 3 followers, 2 new.', warned: false, whole: true });
  });

  it('says so when Instagram doesn’t show their own account, or no followers', async () => {
    const signedOut = () =>
      new JSDOM(`<!doctype html><html><body><main></main></body></html>`, { url: `${IG}/` }).window
        .document;
    const { tab } = instagramTab({ '/': signedOut });
    const { job } = instagramJob(tab);
    expect(await runAsk({ kind: 'friends' }, job, 'instagram')).toMatchObject({
      line: 'Couldn’t find your own account in Instagram’s menu. Check you’re signed in to Instagram in this browser, then ask again.',
      failed: true,
    });
    const empty = () =>
      new JSDOM(
        `<!doctype html><html><body>${MENU}<div role="dialog"><h1>Followers</h1></div></body></html>`,
        { url: `${IG}/me.owner/followers/` },
      ).window.document;
    const second = instagramTab({ '/': home, '/me.owner/followers/': empty });
    expect(
      await runAsk({ kind: 'friends' }, instagramJob(second.tab).job, 'instagram'),
    ).toMatchObject({
      line: 'Instagram showed nobody in your followers. If you have some, check you’re signed in to Instagram in this browser, then ask again.',
      failed: true,
    });
  });
});

/** Someone's page: its header's Following opens a box with Unfollow, which turns it back to Follow. */
function theirPage(username: string, button: 'Following' | 'Follow', box = 'Unfollow'): Document {
  const doc = new JSDOM(
    `<!doctype html><html><body>${MENU}<main role="main"><header>
      <section><a href="#"><h2 dir="auto"><span>${username}</span></h2></a></section>
      <section><button id="state"><div dir="auto">${button}</div></button><div role="button">Message</div></section>
    </header></main></body></html>`,
    { url: `${IG}/${username}/` },
  ).window.document;
  const state = doc.querySelector<HTMLElement>('#state')!;
  state.addEventListener('click', () => {
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `<button id="confirm">${box}</button><button id="cancel">Cancel</button>`;
    doc.body.append(dialog);
    dialog.querySelector('#confirm')!.addEventListener('click', () => {
      if (box === 'Unfollow') state.querySelector('div')!.textContent = 'Follow';
      dialog.remove();
    });
    dialog.querySelector('#cancel')!.addEventListener('click', () => dialog.remove());
  });
  return doc;
}

describe('Unfollowing the ones they ticked, on Instagram', () => {
  it('presses Following, then Unfollow in its box, by their own words, and says when they aren’t followed', async () => {
    const doc = theirPage('dana.reyes', 'Following');
    expect(await unfollow(doc)).toBe('done');
    expect(doc.querySelector('#state')!.textContent).toBe('Follow');
    expect(await unfollow(theirPage('sam.lee', 'Follow'))).toBe('not_found');
  });

  it('closes a box with no Unfollow in it, and says it couldn’t', async () => {
    vi.useFakeTimers();
    try {
      const doc = theirPage('dana.reyes', 'Following', 'Mute');
      const going = unfollow(doc);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await going).toBe('none');
      expect(doc.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unfollows each one ticked who’s still followed, and notes one who isn’t as done already', async () => {
    const candidate = (username: string, name: string) => ({
      profileId: `p-${username}`,
      name,
      url: `${IG}/${username}/`,
      platformId: null,
      username,
      since: '2026-09-20T00:00:00.000Z',
      lastContact: null,
      fit: null,
    });
    const { tab, opened } = instagramTab({
      '/dana.reyes/': () => theirPage('dana.reyes', 'Following'),
      '/sam.lee/': () => theirPage('sam.lee', 'Follow'),
    });
    const { job, sent } = instagramJob(tab, {
      'hfos-tidy': () => ({
        cancel: [candidate('dana.reyes', 'Dana Reyes'), candidate('sam.lee', 'Sam Lee')],
        unfriend: [],
        limits: { cancel_request: { done: 0, most: 20 }, unfriend: { done: 0, most: 0 } },
      }),
      'hfos-friend-end': () => ({ counted: true }),
    });
    const end = await runAsk(
      { kind: 'cancel', profileIds: ['p-dana.reyes', 'p-sam.lee', 'p-gone'] },
      job,
      'instagram',
    );
    expect(opened).toEqual(['/dana.reyes/', '/sam.lee/']);
    expect(sent.filter((s) => s.type === 'hfos-friend-end').map((s) => s.input)).toEqual([
      {
        workspaceId: 'b',
        platform: 'instagram',
        kind: 'cancel_request',
        profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
        name: 'Dana Reyes',
        already: false,
      },
      {
        workspaceId: 'b',
        platform: 'instagram',
        kind: 'cancel_request',
        profile: { id: null, username: 'sam.lee', url: `${IG}/sam.lee/` },
        name: 'Sam Lee',
        already: true,
      },
    ]);
    expect(end).toEqual({
      line: 'Done. Unfollowed: 1 person. Not followed already: 1. No longer on the list: 1.',
      warned: false,
    });
  });
});
