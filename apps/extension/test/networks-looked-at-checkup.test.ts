/**
 * Check Instagram and Check Alignable (src/jobs/looking.ts, docs/outreach.md decision 78): one press reads the
 * network's main pages, with its window in front, notes each with its outline, and looks for each step's button on the
 * page it's for, pressing none; Alignable's follows its own menu, never to Log Out or Upgrade. On small pages written
 * here by hand.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { KITS } from '../src/networks';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';

// A person's pace between pages, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const IG = 'https://www.instagram.com';
const AL = 'https://www.alignable.com';

const html = (body: string, title = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const IG_MENU = `<nav><a href="/">Home</a><a href="/direct/inbox/">Messages</a>
  <a href="/casey.owner/"><span>Profile</span></a></nav>`;

const INSTAGRAM_PAGES: Record<string, string> = {
  [`${IG}/`]: html(`${IG_MENU}<main><article><a href="/dana.reyes/">dana.reyes</a>
    <a href="/p/C9xYz12AbCd/"><time>3h</time></a></article></main>`),
  [`${IG}/casey.owner/`]: html(
    `${IG_MENU}<main><header><h2>casey.owner</h2><a href="/accounts/edit/">Edit profile</a></header></main>`,
  ),
  [`${IG}/accounts/edit/`]: html(
    `<main><form><label for="pepBio">Bio</label><textarea id="pepBio"></textarea><button>Submit</button></form></main>`,
  ),
  [`${IG}/explore/search/keyword/?q=small%20business`]: html(
    `${IG_MENU}<main><a href="/sam.carter/">sam.carter</a><a href="/p/D1aBc34DeFg/">post</a></main>`,
  ),
  [`${IG}/dana.reyes/`]: html(`${IG_MENU}<main><header><h2>dana.reyes</h2><button>Follow</button>
    <div role="button">Message</div></header><a href="/p/E2bCd45EfGh/">a post</a></main>`),
  [`${IG}/p/E2bCd45EfGh/`]:
    html(`<main><article><div role="button"><svg aria-label="Like"></svg></div>
    <form><textarea aria-label="Add a comment…"></textarea><div role="button">Post</div></form></article></main>`),
  [`${IG}/direct/inbox/`]: html(`${IG_MENU}<main><h1>Messages</h1></main>`),
};

const ALIGNABLE_MENU = `<header><nav>
  <a href="/">Home</a><a href="/network">My Network</a><a href="/inbox">Messages</a>
  <a href="/forum">Forum</a><a href="/upgrade">Upgrade</a><a href="/logout">Log Out</a>
  <a href="/me">My Profile</a>
</nav></header>`;

const ALIGNABLE_PAGES: Record<string, string> = {
  [`${AL}/`]: html(
    `${ALIGNABLE_MENU}<main><div><button>Like</button><button>Comment</button></div></main>`,
  ),
  [`${AL}/network`]: html(`${ALIGNABLE_MENU}<main>
    <div><a href="/austin-tx/acme-plumbing/dana-reyes">Dana Reyes</a><button>Connect</button></div></main>`),
  [`${AL}/inbox`]: html(`${ALIGNABLE_MENU}<main><button>New Message</button></main>`),
  [`${AL}/forum`]: html(`${ALIGNABLE_MENU}<main><h1>Forum</h1></main>`),
  [`${AL}/me`]: html(`${ALIGNABLE_MENU}<main><h1>My Profile</h1></main>`),
  [`${AL}/austin-tx/acme-plumbing/dana-reyes`]: html(
    `${ALIGNABLE_MENU}<main><button>Connect</button><button>Message</button><button>Recommend</button></main>`,
  ),
};

/** A tab on a network still looked at, opening the pages above by address; it reads and looks as the tab does. */
function fakeTab(pages: Record<string, string>, platform: 'instagram' | 'alignable') {
  const kit = KITS[platform];
  let doc: Document | null = null;
  let at = '';
  const opened: string[] = [];
  const asked: string[] = [];
  const order: string[] = [];
  const tab = {
    async open(url: string) {
      const page = pages[url];
      if (!page) throw new Error(`Not expected: ${url}`);
      opened.push(url);
      at = url;
      doc = new JSDOM(page, { url }).window.document;
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      order.push('in front');
      const out = await work();
      order.push('back');
      return out;
    },
    async ask(message: { readonly type: string; readonly step?: string }) {
      asked.push(message.type);
      if (!doc) return { ok: false, error: 'closed' };
      if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc, at) };
      if (message.type === 'hfos-outline')
        return {
          ok: true,
          result: kit.readPage(doc, at),
          outline: kit.outline(doc, at),
          shown: true,
        };
      if (message.type === 'hfos-try') {
        // As the tab answers it (src/networks/looking/kit.ts), on this page.
        vi.stubGlobal('location', new URL(at));
        vi.stubGlobal('document', doc);
        try {
          return await kit.work!(message);
        } finally {
          vi.unstubAllGlobals();
        }
      }
      return { ok: false, error: `Not expected: ${message.type}` };
    },
  } as unknown as JobTab;
  return { tab, opened, asked, order };
}

async function checkOn(platform: 'instagram' | 'alignable') {
  const { tab, opened, asked, order } = fakeTab(
    platform === 'instagram' ? INSTAGRAM_PAGES : ALIGNABLE_PAGES,
    platform,
  );
  const notes: ReportNote[] = [];
  const job: Job = {
    tab,
    hfos: (async () => {
      throw new Error('A Check saves nothing in HandsFreeOS but its notes.');
    }) as unknown as Hfos,
    businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    report: async (note = {}) => void notes.push(note),
  };
  const end = await runAsk({ kind: 'checkup' }, job, platform);
  return { end, notes, opened, asked, order };
}

describe('Check Instagram', () => {
  it('reads its main pages and looks for each step’s button on the page it’s for, pressing none', async () => {
    const { end, notes, opened, asked, order } = await checkOn('instagram');
    expect(order).toEqual(['in front', 'back']);
    expect(opened).toEqual([
      `${IG}/`,
      `${IG}/casey.owner/`,
      `${IG}/accounts/edit/`,
      `${IG}/explore/search/keyword/?q=small%20business`,
      `${IG}/dana.reyes/`,
      `${IG}/p/E2bCd45EfGh/`,
      `${IG}/direct/inbox/`,
    ]);
    // It reads, and looks: nothing else is asked of the tab.
    expect(new Set(asked)).toEqual(new Set(['hfos-read', 'hfos-try']));
    expect(notes.filter((n) => n.job?.startsWith('checkup.')).map((n) => n.job)).toEqual([
      'checkup.bio',
      'checkup.follow',
      'checkup.message',
      'checkup.like',
      'checkup.comment',
      'checkup.summary',
    ]);
    expect(notes.at(-1)!.found).toEqual({ pages: 7, steps: 5, working: 5 });
    expect(end).toEqual({
      line: 'Read 7 Instagram pages and tried 5 steps up to their last press. Everything works.',
      warned: false,
    });
  });
});

describe('Check Alignable', () => {
  it('follows its own menu, never to Log Out or Upgrade, and looks for each step till it’s found', async () => {
    const { end, notes, opened } = await checkOn('alignable');
    expect(opened).toEqual([
      `${AL}/`,
      `${AL}/network`,
      `${AL}/inbox`,
      `${AL}/forum`,
      `${AL}/me`,
      `${AL}/austin-tx/acme-plumbing/dana-reyes`,
    ]);
    for (const never of ['/logout', '/upgrade']) expect(opened).not.toContain(`${AL}${never}`);
    // One note of each step, its best: found on the page it was first found on.
    const steps = notes.filter((n) => n.job?.startsWith('checkup.') && n.job !== 'checkup.summary');
    expect(steps.map((n) => [n.job, n.found?.works])).toEqual([
      ['checkup.connect', true],
      ['checkup.message', true],
      ['checkup.recommend', true],
      ['checkup.like', true],
      ['checkup.comment', true],
    ]);
    expect(end.line).toBe(
      'Read 6 Alignable pages and tried 5 steps up to their last press. Everything works.',
    );
  });

  it('says which steps it found nowhere, with what each page had instead', async () => {
    const pages = { ...ALIGNABLE_PAGES };
    pages[`${AL}/austin-tx/acme-plumbing/dana-reyes`] = html(
      `${ALIGNABLE_MENU}<main><button>Connect</button></main>`,
    );
    const { tab } = fakeTab(pages, 'alignable');
    const notes: ReportNote[] = [];
    const job = {
      tab,
      hfos: (async () => ({ ok: true, value: {} })) as unknown as Hfos,
      businessId: 'b',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
      report: async (note: ReportNote = {}) => void notes.push(note),
    } satisfies Job;
    const end = await runAsk({ kind: 'checkup' }, job, 'alignable');
    expect(notes.find((n) => n.job === 'checkup.recommend')).toMatchObject({
      note: 'Recommending: no Recommend on the page.',
      outline: false,
    });
    expect(end.line).toBe(
      'Read 6 Alignable pages and tried 5 steps up to their last press. Not working: recommending.',
    );
  });
});
