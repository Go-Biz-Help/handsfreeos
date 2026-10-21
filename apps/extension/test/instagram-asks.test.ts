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
import { openChat, scrollDialog, scrollList } from '../src/networks/instagram/browse';
import { readReplies } from '../src/networks/instagram/replies';
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

  it('presses their count of followers once when the address shows their account without the box (21 Oct 2026)', async () => {
    // Their account as the owner's Check found it at /<you>/followers/: its counts aren't links to the list.
    const account = () => {
      const doc = new JSDOM(
        `<!doctype html><html><body>${MENU}<main role="main"><header>
          <section><a role="link" href="#"><h2 dir="auto"><span>me.owner</span></h2></a>
            <div><span dir="auto"><span>0</span> posts</span>
              <a role="link" href="#" id="count"><span dir="auto"><span title="3">3</span> followers</span></a></div></section>
          <section><a role="link" href="/accounts/edit/">Edit profile</a></section></header></main></body></html>`,
        { url: `${IG}/me.owner/followers/` },
      ).window.document;
      let presses = 0;
      doc.querySelector('#count')!.addEventListener('click', () => {
        if (presses++) return;
        const box = followers().querySelector('[role="dialog"]')!;
        doc.body.append(doc.importNode(box, true));
      });
      return doc;
    };
    const { tab, opened } = instagramTab({ '/': home, '/me.owner/followers/': account });
    const asked: string[] = [];
    const ask = tab.ask.bind(tab);
    tab.ask = (async (message: { type: string }) => {
      asked.push(message.type);
      return ask(message as never);
    }) as typeof tab.ask;
    const { job, sent } = instagramJob(tab, { 'hfos-save-friends': () => ({ added: 2 }) });
    const end = await runAsk({ kind: 'friends' }, job, 'instagram');
    expect(opened).toEqual(['/', '/me.owner/followers/']);
    expect(asked.filter((t) => t === 'hfos-show-all')).toHaveLength(1);
    const saved = sent.find((s) => s.type === 'hfos-save-friends')!.input as {
      people: { profile: { username: string } }[];
    };
    expect(saved.people.map((p) => p.profile.username)).toEqual(['dana.reyes', 'sam.lee']);
    expect(end).toMatchObject({ line: 'Saved 2 followers, 2 new.' });
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

// ------------------------------------------------------------------------------------------------- part 13

/** Someone's account, as the owner's Check outlined one: their name, what they do, their bio, counts and posts. */
const account = (username: string, name: string) => () =>
  new JSDOM(
    `<!doctype html><html><body>${MENU}<main role="main"><header>
      <section><a href="#"><h2 dir="auto"><span>${username}</span></h2></a>
        <span dir="auto">${name}</span>
        <div><a href="#"><span dir="auto"><span title="1,204">1.2K</span> followers</span></a></div></section>
      <section><div dir="auto">Plumber</div><span dir="auto"><div role="button"><span dir="auto">Fixing Austin leaks since 2009</span></div></span>
        <a href="/${username}/followers/mutualOnly"><span dir="auto">Followed by sam.lee</span></a></section>
      <section><button><div dir="auto">Follow</div></button><div role="button">Message</div></section>
    </header>
    <div><a href="/${username}/p/C1aaaaaaa/"><img alt="A new water heater, fitted"></a>
      <a href="/${username}/p/C1bbbbbbb/"><img alt=""></a></div></main></body></html>`,
    { url: `${IG}/${username}/` },
  ).window.document;

describe('Check my followers and Research, on Instagram', () => {
  const who = (username: string, name: string) => ({
    profileId: `p-${username}`,
    name,
    url: `${IG}/${username}/`,
  });

  it('opens each account HandsFreeOS names, checks it’s theirs, and sends what it says for the AI', async () => {
    const { tab, opened } = instagramTab({
      '/dana.reyes/': account('dana.reyes', 'Dana Reyes'),
      // Instagram showed another account for this one: missing, with no lines.
      '/sam.lee/': account('kim_bakes', 'Kim Bakes'),
    });
    const { job, sent } = instagramJob(tab, {
      'hfos-checks-next': () => ({
        people: [who('dana.reyes', 'Dana Reyes'), who('sam.lee', 'Sam Lee')],
        today: 0,
        perDay: 20,
      }),
      'hfos-check-look': () => ({ checkId: 'c' }),
    });
    const end = await runAsk({ kind: 'checks' }, job, 'instagram');
    expect(opened).toEqual(['/dana.reyes/', '/sam.lee/']);
    expect(sent.find((s) => s.type === 'hfos-checks-next')!.input).toMatchObject({
      platform: 'instagram',
    });
    expect(sent.filter((s) => s.type === 'hfos-check-look').map((s) => s.input)).toEqual([
      {
        workspaceId: 'b',
        profileId: 'p-dana.reyes',
        lines: [
          'Dana Reyes (@dana.reyes)',
          'Plumber',
          'Fixing Austin leaks since 2009',
          '1,204 followers',
          'A post: A new water heater, fitted',
        ],
        missing: false,
      },
      { workspaceId: 'b', profileId: 'p-sam.lee', lines: [], missing: true },
    ]);
    expect(end).toEqual({
      line: 'Done. Checked 1 person for the AI. Instagram didn’t show 1 account. The good fits show under Good fits on the Friends tab once it has read them.',
      warned: false,
    });
  });

  it('says when today’s checks are done, and researches one within them', async () => {
    const { tab } = instagramTab({ '/dana.reyes/': account('dana.reyes', 'Dana Reyes') });
    const full = instagramJob(tab, {
      'hfos-checks-next': () => ({ people: [], today: 20, perDay: 20 }),
    });
    expect(await runAsk({ kind: 'checks' }, full.job, 'instagram')).toEqual({
      line: 'That’s today’s 20 profiles on Instagram. It carries on tomorrow.',
      warned: false,
    });
    const one = instagramJob(tab, {
      'hfos-checks-next': (input) => {
        expect(input).toMatchObject({ profileId: 'p-dana.reyes', most: 1, platform: 'instagram' });
        return { people: [who('dana.reyes', 'Dana Reyes')], today: 3, perDay: 20 };
      },
      'hfos-check-look': () => ({ checkId: 'c' }),
    });
    expect(
      await runAsk(
        { kind: 'research', profileId: 'p-dana.reyes', name: 'Dana Reyes' },
        one.job,
        'instagram',
      ),
    ).toMatchObject({ line: expect.stringContaining('Checked 1 person for the AI.') });
  });
});

describe('a look-up before drafting, on Instagram', () => {
  it('reads their account, closes the window, and has the AI draft with what it said', async () => {
    const { tab } = instagramTab({ '/dana.reyes/': account('dana.reyes', 'Dana Reyes') });
    const { job, sent } = instagramJob(tab, {
      'hfos-draft': () => ({
        drafts: ['Hi Dana, how are the water heaters going?'],
        kind: 'opener',
        opener: null,
        simple: false,
      }),
    });
    const end = await runAsk(
      {
        kind: 'lookup',
        draft: { kind: 'opener', profileId: 'p-dana', chatId: null, postId: null },
        profileUrl: `${IG}/dana.reyes/`,
        name: 'Dana Reyes',
      },
      job,
      'instagram',
    );
    const drafted = sent.find((s) => s.type === 'hfos-draft')!.input as { lookup: string[] };
    expect(drafted.lookup).toContain('Fixing Austin leaks since 2009');
    expect(end).toMatchObject({
      line: 'Wrote a draft after looking Dana Reyes up on Instagram.',
      result: { drafts: ['Hi Dana, how are the water heaters going?'], lookedUp: true },
    });
  });
});

/** Their messages: two chats in the list beside them, rows that are buttons; and each chat's own page. */
const inboxRow = (name: string, line: string, when: string) =>
  `<div role="button"><div><img alt="user"></div><div><span dir="auto"><span title="${name}">${name}</span></span>
    <div><span dir="auto"><span>${line}</span></span><span dir="auto"><abbr><span>${when}</span></abbr></span></div></div></div>`;
const INBOX_ROWS = `<div role="navigation" aria-label="Thread list"><div>
  ${inboxRow('Dana Reyes', 'Yes, what do you need?', '2h')}${inboxRow('Sam Lee', 'You: Thanks!', '3d')}</div></div>`;

const chatPage = (id: string, username: string, name: string, theirsLast: boolean) => () =>
  new JSDOM(
    `<!doctype html><html><body>${MENU}<main><section>${INBOX_ROWS}
      <div><div><a role="link" href="/${username}/"><span title="${name}">${name}</span></a></div>
      <div aria-label="Messages in conversation with ${name}"><div role="grid">
        <div role="row"><div role="gridcell"><h5><span>You sent</span></h5><div dir="auto">Hi, are you taking new clients?</div></div></div>
        ${
          theirsLast
            ? `<div role="row"><div role="gridcell"><h5><span>${name.split(' ')[0]} sent</span></h5><div dir="auto">Yes, what do you need?</div></div></div>`
            : ''
        }
      </div></div>
      <div><div role="textbox" contenteditable="true" aria-label="Message"></div></div></div></section></main></body></html>`,
    { url: `${IG}/direct/t/${id}/` },
  ).window.document;

describe('Read my chats, on Instagram', () => {
  it('opens a chat by its row’s name, and scrolls the list of chats, never the page', () => {
    const doc = new JSDOM(
      `<!doctype html><html><body><div id="list" style="overflow-y: auto">${INBOX_ROWS}</div></body></html>`,
      { url: `${IG}/direct/inbox/` },
    ).window.document;
    let pressed = '';
    for (const row of doc.querySelectorAll<HTMLElement>('[role="button"]'))
      row.addEventListener(
        'click',
        () => (pressed = row.querySelector('span[title]')!.getAttribute('title')!),
      );
    expect(openChat(doc, 'sam lee')).toBe(true);
    expect(pressed).toBe('Sam Lee');
    expect(openChat(doc, 'Kim Bakes')).toBe(false);
    const list = doc.querySelector<HTMLElement>('#list')!;
    let top = 0;
    Object.defineProperty(list, 'clientHeight', { get: () => 400 });
    Object.defineProperty(list, 'scrollHeight', { get: () => 900 });
    Object.defineProperty(list, 'scrollTop', { get: () => top });
    list.scrollBy = (() => (top = 500)) as typeof list.scrollBy;
    expect(scrollList(doc, `${IG}/direct/inbox/`)).toBe(true);
    expect(scrollList(doc, `${IG}/direct/inbox/`)).toBe(false);
  });

  it('tells who wrote last in the chat open, by its id and their account', () => {
    const doc = chatPage('111', 'dana.reyes', 'Dana Reyes', true)();
    expect(readReplies(doc, doc.location.href)).toEqual([
      {
        name: 'Dana Reyes',
        threadKey: '111',
        profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
        when: null,
      },
    ]);
    const mine = chatPage('222', 'sam.lee', 'Sam Lee', false)();
    expect(readReplies(mine, mine.location.href)).toEqual([]);
  });

  it('reads each chat for the AI as Instagram’s, and notes the one whose last message is theirs', async () => {
    const shown = {
      dana: chatPage('111', 'dana.reyes', 'Dana Reyes', true),
      sam: chatPage('222', 'sam.lee', 'Sam Lee', false),
    };
    const { tab, opened } = instagramTab({
      '/direct/inbox/': () =>
        new JSDOM(
          `<!doctype html><html><body>${MENU}<main><section>${INBOX_ROWS}</section></main></body></html>`,
          { url: `${IG}/direct/inbox/` },
        ).window.document,
    });
    // A row pressed opens its chat's page: the tab shows it from then on.
    const ask = tab.ask.bind(tab);
    let doc: Document | null = null;
    tab.ask = (async (message: { type: string; name?: string }) => {
      if (message.type === 'hfos-open-chat') {
        doc = shown[message.name === 'Dana Reyes' ? 'dana' : 'sam']();
        return { ok: true };
      }
      if (message.type === 'hfos-scroll-list') return { ok: false };
      if (message.type === 'hfos-read' && doc)
        return { ok: true, result: KITS.instagram.readPage(doc, doc.location.href) };
      return ask(message as never);
    }) as typeof tab.ask;
    const store = new Map<string, unknown>();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (k: string) => (store.has(k) ? { [k]: store.get(k) } : {}),
          set: async (v: Record<string, unknown>) => {
            for (const [k, value] of Object.entries(v)) store.set(k, value);
          },
        },
      },
    });
    try {
      const { job, sent } = instagramJob(tab, {
        'hfos-collect-chats': () => ({ saved: 1, waiting: 1 }),
        'hfos-replies-note': () => ({ replies: [] }),
      });
      const end = await runAsk({ kind: 'chats' }, job, 'instagram');
      expect(opened).toEqual(['/direct/inbox/']);
      const chats = sent
        .filter((s) => s.type === 'hfos-collect-chats')
        .map((s) => s.input as { platform: string; chats: { name: string; thread: unknown }[] });
      expect(chats.map((c) => [c.platform, c.chats[0]!.name, c.chats[0]!.thread])).toEqual([
        ['instagram', 'Dana Reyes', { id: '111', encrypted: false }],
        ['instagram', 'Sam Lee', { id: '222', encrypted: false }],
      ]);
      // Dana wrote last, two hours ago; Sam's chat ends with the person's own.
      expect(sent.filter((s) => s.type === 'hfos-replies-note').map((s) => s.input)).toEqual([
        {
          workspaceId: 'b',
          platform: 'instagram',
          looking: false,
          seen: [
            {
              name: 'Dana Reyes',
              threadKey: '111',
              profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
            },
          ],
        },
      ]);
      expect(end).toEqual({
        line: 'Done: 2 chats sent for the AI to read. 1 chat had their message last. Chats read in the last day were left as they were.',
        warned: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
