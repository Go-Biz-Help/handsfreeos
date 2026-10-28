/**
 * Tidying on its own, once a day (docs/outreach.md, decision 98): what it does with HandsFreeOS's picks as the person
 * chose (nothing while they only tick), where it sits in each network's once-a-day jobs, and Alignable's withdraw
 * (from 0.97.0): on a made-up business page whose buttons behave as a person would expect, it presses only that
 * business's own controls, presses the box's Withdraw and never its Cancel, never presses a waiting link that could ask
 * again, and notes a page it can't work with its outline.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ALIGNABLE_DAILY } from '../src/auto/alignable';
import { INSTAGRAM_DAILY } from '../src/auto/instagram';
import { LINKEDIN_DAILY } from '../src/auto/linkedin';
import { DAILY_JOBS } from '../src/auto/plan';
import type { Tidy, TidyCandidate } from '../src/hfos/messages';
import { withdrawOnItsOwn, withdrawTicked } from '../src/jobs/alignable/withdraw';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { ownTidy } from '../src/jobs/own-tidy';
import type { ReportNote } from '../src/jobs/report';
import { KITS } from '../src/networks';
import { businessPage } from '../src/networks/alignable/read';
import { withdrawOnPage } from '../src/networks/alignable/withdraw';

// A person's pace, and what a press opens, without the waits.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));
vi.mock('../src/networks/looking/looks', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
  waitFor: async <T>(find: () => T | null | undefined) => find() ?? null,
}));

const AL = 'https://www.alignable.com';
const PAGE = `${AL}/austin-tx/acme-plumbing`;

const candidate = (id: string, name = `Business ${id}`): TidyCandidate => ({
  profileId: `9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c${id.padStart(2, '0')}`,
  name,
  url: PAGE,
  platformId: '42',
  username: 'austin-tx-acme-plumbing',
  since: '2026-09-01T12:00:00.000Z',
  lastContact: null,
  fit: null,
});

const lists = (own: Tidy['own'] | undefined, done = 0): Tidy =>
  ({
    cancel: [candidate('1', 'Dana Reyes')],
    unfriend: [],
    totals: { cancel_request: 1, unfriend: 0 },
    cancelAfterWeeks: 3,
    needsFile: false,
    limits: { cancel_request: { done, most: 20 }, unfriend: { done: 0, most: 0 } },
    friends: 10,
    cap: 30_000,
    warning: null,
    ...(own ? { own } : {}),
  }) as Tidy;

describe('tidying on its own, from HandsFreeOS’s picks', () => {
  const job = { stopped: () => false };

  it('does nothing while the person only ticks, or for a server from before', async () => {
    const run = vi.fn();
    expect(await ownTidy(job, lists({ mode: 'off', cancel: [], unfriend: [] }), run)).toEqual({
      line: 'Off: only the ones you tick in HandsFreeOS go.',
      warned: false,
    });
    expect((await ownTidy(job, lists(undefined), run)).line).toMatch(/^Off:/);
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels the old requests picked, then unfriends the friends picked, and says both', async () => {
    const run = vi.fn(async (which: string) => ({ line: `${which} done.`, warned: false }));
    const picked = lists({
      mode: 'unfriend',
      cancel: [candidate('1')],
      unfriend: [candidate('2')],
    });
    expect(await ownTidy(job, picked, run)).toEqual({
      line: 'cancel_request done. unfriend done.',
      warned: false,
    });
    expect(run.mock.calls.map(([which]) => which)).toEqual(['cancel_request', 'unfriend']);
  });

  it('stops at a warning, and says when there’s nothing to tidy today', async () => {
    const warned = { line: 'Facebook warned you.', warned: true };
    const run = vi.fn(async () => warned);
    const both = lists({ mode: 'unfriend', cancel: [candidate('1')], unfriend: [candidate('2')] });
    expect(await ownTidy(job, both, run)).toBe(warned);
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      (await ownTidy(job, lists({ mode: 'cancel', cancel: [], unfriend: [] }), run)).line,
    ).toBe('Nothing to tidy up today.');
  });

  it('comes right after the day’s requests on each network, and after who followed back on Instagram', () => {
    expect(DAILY_JOBS.slice(0, 2)).toEqual(['requests', 'tidy']);
    expect(LINKEDIN_DAILY.slice(0, 2)).toEqual(['requests', 'tidy']);
    expect(ALIGNABLE_DAILY.slice(0, 3)).toEqual(['my_groups', 'requests', 'tidy']);
    expect(INSTAGRAM_DAILY.slice(0, 3)).toEqual(['requests', 'follow_backs', 'tidy']);
  });
});

// ------------------------------------------------------------------------------------------------- Alignable

type Standing = 'connect' | 'menu' | 'direct' | 'link' | 'connected' | 'stuck';

/**
 * A business's own page: its row of buttons beside its Recommend and Refer (by Alignable's id for it, 42), and another
 * business it suggests, asked to connect with too. While a request waits, its row says so in one of the ways
 * Alignable might: a Request Sent that opens a menu with Cancel Request (`menu`), a Cancel request of its own
 * (`direct`), a Pending link to a connection request (`link`), or a Request Sent whose menu takes nothing back
 * (`stuck`).
 */
function businessHtml(standing: Standing): string {
  const row = {
    connect: `<a href="/biz/connection_requests/make_connection?business_id=42&request_source=profile"><div>Connect</div></a>`,
    menu: '<button id="waiting">Request Sent</button>',
    stuck: '<button id="waiting">Request Sent</button>',
    direct: '<button disabled>Request Sent</button><button id="take-back">Cancel request</button>',
    link: `<a id="pending" href="/biz/connection_requests/quick?business_id=42"><div>Pending</div></a>`,
    connected: `<a href="/biz/connections/42">Remove Connection</a>`,
  }[standing];
  return `<main><section>
    <div><a href="/biz/recommendations/new?id=42">Recommend</a><a href="/forward_referral_card/42">Refer</a>${row}</div>
    <h1 title="Dana Reyes">Dana Reyes</h1><h2 title="Acme Plumbing">Acme Plumbing</h2>
    <div><a href="/austin-tx">Austin, TX</a></div>
    <aside><h3>Businesses like this</h3><div><a href="/austin-tx/best-bakery?user=6">Sam Lee</a>
      <a href="/forward_referral_card/43">Refer</a><button id="other">Request Sent</button></div></aside>
  </section></main>`;
}

/** The page, its buttons behaving as Alignable's might; `presses` lists what was pressed, by its id or words. */
function alignablePage(standing: Standing, onGone: () => void = () => undefined) {
  const doc = new JSDOM(`<!doctype html><html><body>${businessHtml(standing)}</body></html>`, {
    url: PAGE,
  }).window.document;
  const presses: string[] = [];
  const press = (el: Element) => presses.push(el.id || (el.textContent ?? '').trim());
  const gone = () => {
    const row = doc.querySelector('section > div')!;
    for (const el of row.querySelectorAll('#waiting, #take-back, [disabled]')) el.remove();
    row.insertAdjacentHTML(
      'beforeend',
      `<a href="/biz/connection_requests/make_connection?business_id=42"><div>Connect</div></a>`,
    );
    onGone();
  };
  const box = (role: string, items: Record<string, () => void>) => {
    const over = doc.createElement('div');
    over.setAttribute('role', role);
    for (const [label, then] of Object.entries(items)) {
      const item = doc.createElement('button');
      item.textContent = label;
      item.addEventListener('click', () => {
        press(item);
        over.remove();
        then();
      });
      over.append(item);
    }
    doc.body.append(over);
  };
  const sure = () => box('dialog', { Cancel: () => undefined, Withdraw: gone });
  doc.querySelector('#waiting')?.addEventListener('click', (e) => {
    press(e.currentTarget as Element);
    box(
      'menu',
      standing === 'stuck' ? { 'Send message': () => undefined } : { 'Cancel Request': sure },
    );
  });
  doc.querySelector('#take-back')?.addEventListener('click', (e) => {
    press(e.currentTarget as Element);
    sure();
  });
  for (const id of ['#pending', '#other'])
    doc.querySelector(id)?.addEventListener('click', (e) => {
      e.preventDefault();
      press(e.currentTarget as Element);
    });
  return { doc, presses };
}

const THEM = { id: '42', username: 'austin-tx-acme-plumbing', url: PAGE };

describe('withdrawing a connection request on a business’s page', () => {
  it('reads that a request waits only from their own row, never a business it suggests', () => {
    expect(businessPage(alignablePage('menu').doc, PAGE)).toMatchObject({
      connect: false,
      asked: true,
    });
    expect(businessPage(alignablePage('link').doc, PAGE)).toMatchObject({
      connect: true,
      asked: true,
    });
    expect(businessPage(alignablePage('connect').doc, PAGE)).toMatchObject({
      connect: true,
      asked: false,
    });
  });

  it('presses Request Sent, then Cancel Request, then the box’s Withdraw, never its Cancel', async () => {
    const { doc, presses } = alignablePage('menu');
    expect(await withdrawOnPage(doc, PAGE, THEM)).toBe('done');
    expect(presses).toEqual(['waiting', 'Cancel Request', 'Withdraw']);
    expect(businessPage(doc, PAGE)).toMatchObject({ connect: true, asked: false });
  });

  it('presses a Cancel request of their own straight away', async () => {
    const { doc, presses } = alignablePage('direct');
    expect(await withdrawOnPage(doc, PAGE, THEM)).toBe('done');
    expect(presses).toEqual(['take-back', 'Withdraw']);
  });

  it('never presses a waiting link, which could ask again, nor another business’s', async () => {
    const link = alignablePage('link');
    expect(await withdrawOnPage(link.doc, PAGE, THEM)).toBe('not_found');
    expect(link.presses).toEqual([]);
    const stuck = alignablePage('stuck');
    expect(await withdrawOnPage(stuck.doc, PAGE, THEM)).toBe('not_sure');
    expect(stuck.presses).toEqual(['waiting']);
  });

  it('says when it went already, they’re connected now, or it isn’t their page', async () => {
    expect(await withdrawOnPage(alignablePage('connect').doc, PAGE, THEM)).toBe('already');
    expect(await withdrawOnPage(alignablePage('connected').doc, PAGE, THEM)).toBe('connected');
    expect(await withdrawOnPage(alignablePage('menu').doc, PAGE, { ...THEM, id: '43' })).toBe(
      'not_found',
    );
  });
});

/** A tab on Alignable whose business page is drawn as it stands now, reading and working as its tab does. */
function alignableTab(first: Standing) {
  const kit = KITS.alignable;
  let standing = first;
  let doc: Document | null = null;
  const opened: string[] = [];
  const tab = {
    tabId: 1,
    async open(url: string) {
      opened.push(url);
      doc = alignablePage(standing, () => (standing = 'connect')).doc;
      return 1;
    },
    async loaded() {},
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

function alignableJob(tab: JobTab, tidy: Tidy) {
  const sent: { type: string; input?: unknown }[] = [];
  const reports: ReportNote[] = [];
  const job: Job = {
    tab,
    hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
      sent.push({ type: ask.type, input: ask.input });
      if (ask.type === 'hfos-tidy') return { ok: true, value: tidy };
      return {
        ok: true,
        value: { profileId: candidate('1').profileId, counted: true, doneToday: 1 },
      };
    }) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    report: async (note) => void reports.push(note ?? {}),
  };
  return { job, sent, reports };
}

describe('Alignable’s withdraw job', () => {
  it('withdraws the request ticked, checks their page again, and notes it', async () => {
    const { tab, opened } = alignableTab('menu');
    const { job, sent } = alignableJob(tab, lists(undefined));
    const end = await withdrawTicked(job, [candidate('1').profileId]);
    expect(end).toEqual({
      line: 'Done. Connection requests withdrawn: 1 business.',
      warned: false,
    });
    expect(opened).toEqual([PAGE, PAGE]);
    expect(sent.find((s) => s.type === 'hfos-friend-end')?.input).toMatchObject({
      platform: 'alignable',
      kind: 'cancel_request',
      already: false,
      name: 'Dana Reyes',
    });
  });

  it('notes one whose page shows it went already, not counted', async () => {
    const { tab } = alignableTab('connect');
    const { job, sent } = alignableJob(tab, lists(undefined));
    const end = await withdrawTicked(job, [candidate('1').profileId]);
    expect(end.line).toBe(
      'Done. Connection requests withdrawn: 0 businesses. Answered or withdrawn already: 1.',
    );
    expect(sent.find((s) => s.type === 'hfos-friend-end')?.input).toMatchObject({ already: true });
  });

  it('on its own, goes only as the person chose, and passes over a page it can’t work, noting its outline', async () => {
    const off = alignableTab('menu');
    const quiet = alignableJob(off.tab, lists({ mode: 'off', cancel: [], unfriend: [] }));
    expect((await withdrawOnItsOwn(quiet.job)).line).toMatch(/^Off:/);
    expect(off.opened).toEqual([]);

    const { tab } = alignableTab('link');
    const { job, sent, reports } = alignableJob(
      tab,
      lists({ mode: 'cancel', cancel: [candidate('1', 'Dana Reyes')], unfriend: [] }),
    );
    const end = await withdrawOnItsOwn(job);
    expect(end.line).toBe('Done. Connection requests withdrawn: 0 businesses. Skipped: 1.');
    expect(sent.some((s) => s.type === 'hfos-friend-end')).toBe(false);
    expect(reports[0]).toMatchObject({ job: 'tidy.not_found', outline: true });
  });

  it('stops at today’s limit on Alignable', async () => {
    const { tab, opened } = alignableTab('menu');
    const { job } = alignableJob(tab, lists(undefined, 20));
    const end = await withdrawTicked(job, [candidate('1').profileId]);
    expect(end.line).toMatch(/^That’s today’s limit of 20 on Alignable\./);
    expect(opened).toEqual([]);
  });
});
