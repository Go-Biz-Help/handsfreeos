/**
 * Your newest followers on Threads (decision 163, ../src/jobs/follows/people.ts), the save its first day waits on: their
 * own profile from the menu, the box of their followers opened by the button around their count, its rows saved. On a
 * profile and a box as the owner's Chrome drew them on 16 Nov 2026, where the count's button sits inside two parts
 * that say just what it says, which till 0.141.4 were pressed instead and opened nothing.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { saveFollowers } from '../src/jobs/follows/people';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { KITS } from '../src/networks';

// A person's pace between looks, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const TH = 'https://www.threads.com';

const MENU = `<div role="navigation"><a role="link" href="/"><svg role="img" aria-label="Threads"></svg></a>
  <div><a role="link" href="/"><div><svg></svg><span dir="auto"><span>For you</span></span></div></a>
    <a role="link" href="/@casey.owner"><div><svg role="img"><title>Profile</title></svg><span dir="auto"><span>Profile</span></span></div></a>
    <a role="link" href="/following/"><div><span dir="auto"><span>Following</span></span></div></a></div></div>`;

const home = () =>
  new JSDOM(`<!doctype html><html><body><div>${MENU}<div><div></div></div></div></body></html>`, {
    url: `${TH}/`,
  }).window.document;

/** Their own profile: the count of their followers a button inside two parts that say just the same. */
const ownProfile = (count: string) => () =>
  new JSDOM(
    `<!doctype html><html><body><div>${MENU}<div>
      <div><a role="link" aria-label="casey.owner profile" href="/@casey.owner"><h1 dir="auto"><span>casey.owner</span></h1></a></div>
      <div role="region" aria-label="Profile header"><div>
        <div><div><div><h1 dir="auto">Casey Owner</h1><span dir="auto"><span>casey.owner</span></span></div>
          <div role="button"><img alt="casey.owner's profile picture"></div></div>
          <span dir="auto">We answer every lead.</span>
          <div><div><div><div role="button" id="count"><div><div><img alt=""></div></div><span dir="auto"><span title="${count}">${count}</span> followers</span></div></div></div>
            <div><a role="link" href="/insights">${'<svg role="img"><title>Insights</title></svg>'}</a></div></div></div>
        <div role="button"><div>Edit profile</div></div>
        <div><a role="link" aria-label="Threads" aria-current="page" href="/@casey.owner"><span dir="auto"><span>Threads</span></span></a></div>
      </div></div></div></div></body></html>`,
    { url: `${TH}/@casey.owner` },
  ).window.document;

const row = (
  username: string,
  name: string,
  button: string,
) => `<div><div><div><span><div><span><div>
  <a role="link" href="/@${username}"><span><span>${username}</span></span></a></div></span></div></span></div>
  <div><span><span>${name}</span></span></div></div><div role="button"><div>${button}</div></div></div>`;

/** The box of their followers, as a press of the count's own button draws it; Escape takes it away. */
function opensBox(doc: Document): void {
  doc.querySelector('#count')!.addEventListener('click', () => {
    doc.body.insertAdjacentHTML(
      'beforeend',
      `<div role="dialog"><div><div role="tablist"><div role="tab"><div role="button" aria-label="Followers">Followers 441</div></div></div>
        <div><input aria-label="Search">${row('avery.lane', 'Avery Lane', 'Follow back')}${row('sam.lee', 'Sam Lee', 'Following')}</div></div></div>`,
    );
    const box = doc.querySelector('[role="dialog"]')!;
    box.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') box.remove();
    });
  });
}

/** A tab on Threads that opens the pages above by their address, reading and working as its tab does. */
function threadsTab(pages: Record<string, () => Document>) {
  const kit = KITS.threads;
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
  return { tab, opened, page: () => doc! };
}

function threadsJob(tab: JobTab) {
  const saved: string[] = [];
  const job: Job = {
    tab,
    hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
      if (ask.type !== 'hfos-save-friends') return { ok: true, value: {} };
      const people = (ask.input as { people: { profile: { username: string } }[] }).people;
      saved.push(...people.map((p) => p.profile.username));
      return { ok: true, value: { added: people.length, changed: 0 } };
    }) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
  };
  return { job, saved };
}

describe('Your newest followers on Threads', () => {
  it('opens their followers from the button around their count, saves them, and closes the box again', async () => {
    const profile = ownProfile('441');
    const { tab, opened, page } = threadsTab({
      '/': home,
      '/@casey.owner': () => {
        const doc = profile();
        opensBox(doc);
        return doc;
      },
    });
    const { job, saved } = threadsJob(tab);
    expect(await saveFollowers(job, 'threads')).toMatchObject({
      line: 'Saved your 2 followers, 2 new.',
      warned: false,
      whole: true,
    });
    expect(opened).toEqual(['/', '/@casey.owner']);
    expect(saved).toEqual(['avery.lane', 'sam.lee']);
    expect(page().querySelector('[role="dialog"]')).toBeNull();
  });

  it('starts the day with nobody to save when their profile says 0 followers, pressing nothing', async () => {
    const profile = ownProfile('0');
    let pressed = 0;
    const { tab } = threadsTab({
      '/': home,
      '/@casey.owner': () => {
        const doc = profile();
        doc.querySelector('#count')!.addEventListener('click', () => pressed++);
        return doc;
      },
    });
    expect(await saveFollowers(threadsJob(tab).job, 'threads')).toMatchObject({
      line: 'No followers on Threads yet, so nobody to save.',
      whole: true,
    });
    expect(pressed).toBe(0);
  });

  it('says the box didn’t open, not to check they’re signed in, when their profile showed and the box never did', async () => {
    const { tab } = threadsTab({ '/': home, '/@casey.owner': ownProfile('441') });
    const end = await saveFollowers(threadsJob(tab).job, 'threads');
    expect(end).toMatchObject({
      line: 'Your followers didn’t open on Threads from your count of them (441).',
      failed: true,
    });
  });
});
