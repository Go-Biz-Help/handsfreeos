/**
 * What the person asks of their computer on Alignable (partners stage 6c, part 4; src/jobs/alignable): their
 * connections saved from My Network, all of them once its tab of them all is pressed and its Show more has nothing
 * left; the connection requests they've got saved from its Requests; a connection's business page read for the AI's
 * check, only when it's theirs; a business looked up before drafting; and from 0.84.0 their chats read for the AI,
 * noting who wrote last. On pages drawn as the owner's Check Alignable found them (0.68.0): `connection-row`s under
 * `allies-picks-list`, beside `tab-all-connections`; and Messages as his Check of 21 Oct 2026 outlined it.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { CheckLookInput } from '@hfos/core/addons/outreach/checks';
import { LOOKUP_LINE_MOST } from '@hfos/core/addons/outreach/today';
import { runAsk } from '../src/asks/run';
import { businessLines } from '../src/jobs/alignable/checks';
import { readWarmLeads } from '../src/jobs/alignable/engaged';
import { alignableListSave } from '../src/hfos/saves';
import { KITS } from '../src/networks';
import {
  openConversation,
  scrollConversations,
  scrollList,
  showAllConnections,
} from '../src/networks/alignable/browse';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';

// A person's pace between pages, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const AL = 'https://www.alignable.com';

/** A connection's row on My Network, as the owner's Check found them. */
const row = (id: string, name: string, business: string) => `
  <div data-testid="connection-row">
    <a aria-label="${name}" data-testid="connection-row-profile-link" href="/biz/businesses/${id}?cyattr=1&cyfid=2"></a>
    <div data-testid="connection-row-summary"><div><span>${name}</span><span>${business}</span></div></div>
    <a data-testid="connection-row-cta" href="/biz/conversations?_fat=1&with_business_id=${id}">Message</a>
  </div>`;

const PEOPLE = [
  ['B1', 'Dana Reyes', 'Reyes Plumbing'],
  ['B2', 'Lee Park', 'Park Dental'],
  ['B3', 'Sam Lee', 'Lee Realty'],
  ['B4', 'Casey Moreno', 'Moreno Roofing'],
] as const;

/** My Network: Ally's picks first; its tab of them all shows two, and its Show more the rest. */
function myNetwork(): Document {
  const doc = new JSDOM(
    `<!doctype html><html><body><main>
      <div data-testid="connections-table">
        <button data-testid="tab-allies-picks">Ally's Picks</button>
        <button data-testid="tab-all-connections">All Connections</button>
        <div data-testid="allies-picks-list">${row(...PEOPLE[2])}</div>
      </div>
    </main></body></html>`,
    { url: `${AL}/biz/my_network` },
  ).window.document;
  doc.querySelector('[data-testid="tab-all-connections"]')!.addEventListener('click', () => {
    const table = doc.querySelector('[data-testid="connections-table"]')!;
    table.querySelector('[data-testid="allies-picks-list"]')!.remove();
    const all = doc.createElement('div');
    all.setAttribute('data-testid', 'all-connections-list');
    all.innerHTML = `${row(...PEOPLE[0])}${row(...PEOPLE[1])}<button id="more">Show more</button>`;
    table.append(all);
    all.querySelector('#more')!.addEventListener('click', () => {
      all.querySelector('#more')!.remove();
      all.insertAdjacentHTML('beforeend', `${row(...PEOPLE[2])}${row(...PEOPLE[3])}`);
    });
  });
  return doc;
}

/** My Network's Requests: one request someone sent them. */
const requests = () =>
  new JSDOM(
    `<!doctype html><html><body><main>
      <table data-testid="requests-360-table"><tbody>
        <tr><td><a href="/columbus-oh/avery-insurance"><span>Avery Lane</span><span>Avery Insurance</span></a></td>
          <td>We serve the same homeowners</td><td><button>Accept</button></td></tr>
      </tbody></table>
    </main></body></html>`,
    { url: `${AL}/biz/my_network/connection_requests` },
  ).window.document;

/** A business's own page, by the address its id leads to. */
const businessPage = (id = 'B1') =>
  new JSDOM(
    `<!doctype html><html><body><main>
      <h1 title="Dana Reyes">Dana Reyes</h1><h2 title="Owner, Reyes Plumbing">Owner, Reyes Plumbing</h2>
      <a href="/columbus-oh">Columbus, OH</a>
      <div><div><span>We fix leaks fast, day or night.</span><button>Read more</button></div></div>
      <div><div>About Us</div><p>Family plumbing in Columbus since 2009.</p></div>
      <div data-testid="ideal-partner-information"><div data-testid="ideal-partner-description">Realtors and home inspectors</div></div>
      <a href="/biz/conversations?with_business_id=${id}">Message</a>
    </main></body></html>`,
    { url: `${AL}/columbus-oh/reyes-plumbing` },
  ).window.document;

/** A tab on Alignable that opens the pages above by their address, reading and working as its tab does. */
function alignableTab(pages: Record<string, () => Document>) {
  const kit = KITS.alignable;
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

function alignableJob(tab: JobTab, answers: Record<string, (input: unknown) => unknown> = {}) {
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

describe('Alignable’s lists in the page', () => {
  it('switches My Network to all their connections, and presses Show more till there’s no more', () => {
    const doc = myNetwork();
    expect(showAllConnections(doc)).toBe(true);
    expect(doc.querySelector('[data-testid="allies-picks-list"]')).toBeNull();
    expect(doc.querySelectorAll('[data-testid="connection-row"]')).toHaveLength(2);
    expect(scrollList(doc)).toBe(true);
    expect(doc.querySelectorAll('[data-testid="connection-row"]')).toHaveLength(4);
    expect(scrollList(doc)).toBe(false);
  });

  it('opens a chat with words in it from the side of Messages, and says when there’s none', () => {
    const doc = new JSDOM(
      `<!doctype html><html><body>
        <div data-testid="conversationInSidebar" id="empty"><div><div>Sam Lee</div></div></div>
        <div data-testid="conversationInSidebar" id="talk"><div><div>Lee Park</div><div>Thanks for connecting!</div></div></div>
      </body></html>`,
    ).window.document;
    let opened = '';
    for (const r of doc.querySelectorAll<HTMLElement>('[data-testid="conversationInSidebar"]'))
      r.addEventListener('click', () => (opened = r.id));
    expect(openConversation(doc)).toBe(true);
    expect(opened).toBe('talk');
    expect(openConversation(new JSDOM('<body></body>').window.document)).toBe(false);
  });

  it('saves each business once, by Alignable’s id, and leaves out a row with no business page', () => {
    const built = alignableListSave(
      [
        {
          name: 'Dana Reyes',
          profile: { id: 'B1', username: null, url: `${AL}/biz/businesses/B1` },
        },
        {
          name: 'Dana Reyes',
          profile: { id: 'B1', username: null, url: `${AL}/biz/businesses/B1` },
        },
        { name: 'Nobody', profile: { id: null, username: null, url: 'https://example.com/x' } },
      ],
      'friends',
      'b',
    );
    expect(built).toEqual({
      ok: true,
      input: [
        {
          workspaceId: 'b',
          platform: 'alignable',
          list: 'friends',
          people: [
            {
              name: 'Dana Reyes',
              profile: { id: 'B1', username: null, url: `${AL}/biz/businesses/B1` },
              mutualFriends: null,
            },
          ],
        },
      ],
    });
  });
});

describe('Save my connections and Check my connection requests, on Alignable', () => {
  it('reads all their connections from My Network to the end, and saves them', async () => {
    const { tab, opened } = alignableTab({ '/biz/my_network': myNetwork });
    const { job, sent } = alignableJob(tab, { 'hfos-save-friends': () => ({ added: 3 }) });
    const end = await runAsk({ kind: 'friends' }, job, 'alignable');
    expect(opened).toEqual(['/biz/my_network']);
    const saved = sent.find((s) => s.type === 'hfos-save-friends')!.input as {
      list: string;
      platform: string;
      people: { name: string }[];
    };
    expect(saved).toMatchObject({ list: 'friends', platform: 'alignable' });
    expect(saved.people.map((p) => p.name)).toEqual([
      'Dana Reyes',
      'Lee Park',
      'Sam Lee',
      'Casey Moreno',
    ]);
    expect(end).toEqual({ line: 'Saved 4 connections, 3 new.', warned: false, whole: true });
  });

  it('saves the requests they’ve got, or says there are none', async () => {
    const { tab } = alignableTab({ '/biz/my_network/connection_requests': requests });
    const { job, sent } = alignableJob(tab, { 'hfos-save-friends': () => ({ added: 1 }) });
    const end = await runAsk({ kind: 'requests' }, job, 'alignable');
    expect(sent.find((s) => s.type === 'hfos-save-friends')!.input).toMatchObject({
      list: 'requests',
      people: [{ name: 'Avery Lane', profile: { username: 'columbus-oh-avery-insurance' } }],
    });
    expect(end).toMatchObject({ line: 'Saved 1 connection request you’ve got, 1 new.' });
  });
});

describe('Check my connections, Research and a look-up, on Alignable', () => {
  const next = (people: { profileId: string; name: string; url: string }[]) => () => ({
    people,
    today: 0,
    perDay: 30,
  });

  it('reads a connection’s business page for the AI, and says when it isn’t theirs', async () => {
    const { tab, opened } = alignableTab({
      '/biz/businesses/B1': () => businessPage('B1'),
      '/biz/businesses/B9': () => businessPage('B1'),
    });
    const { job, sent } = alignableJob(tab, {
      'hfos-checks-next': next([
        { profileId: 'p1', name: 'Dana Reyes', url: `${AL}/biz/businesses/B1` },
        { profileId: 'p9', name: 'Someone Else', url: `${AL}/biz/businesses/B9` },
      ]),
    });
    const end = await runAsk({ kind: 'checks' }, job, 'alignable');
    expect(opened).toEqual(['/biz/businesses/B1', '/biz/businesses/B9']);
    const looks = sent.filter((s) => s.type === 'hfos-check-look').map((s) => s.input);
    expect(looks).toEqual([
      {
        workspaceId: 'b',
        profileId: 'p1',
        lines: [
          'Dana Reyes, Owner, Reyes Plumbing',
          'In columbus-oh',
          'Elevator Pitch: We fix leaks fast, day or night.',
          'About Us: Family plumbing in Columbus since 2009.',
          'Who they refer with: Realtors and home inspectors',
        ],
        missing: false,
      },
      // Another business's page came up: noted as missing, never read as theirs.
      { workspaceId: 'b', profileId: 'p9', lines: [], missing: true },
    ]);
    expect(end).toMatchObject({
      line: expect.stringContaining(
        'Checked 1 business for the AI. Alignable didn’t show 1 business page.',
      ),
    });
  });

  it('cuts a long About Us to what HandsFreeOS takes, so the check isn’t turned away', () => {
    const lines = businessLines({
      name: 'Dana Reyes',
      title: null,
      profile: null,
      town: null,
      pitch: null,
      about: 'We fix leaks fast, day or night. '.repeat(40),
      customer: null,
      partner: null,
      tags: [],
      connect: false,
      connected: false,
      recommend: false,
      refer: false,
      message: false,
    });
    expect(lines[1]).toHaveLength(LOOKUP_LINE_MOST);
    expect(lines[1]).toMatch(/^About Us: We fix leaks fast, day or night\. .*…$/);
    const id = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(CheckLookInput.safeParse({ workspaceId: id, profileId: id, lines }).success).toBe(true);
  });

  it('looks a business up before drafting, with what its page says', async () => {
    const { tab } = alignableTab({ '/biz/businesses/B1': () => businessPage('B1') });
    const { job, sent } = alignableJob(tab, {
      'hfos-draft': () => ({ drafts: ['Hi Dana!'], kind: 'opener', opener: null, simple: false }),
    });
    const end = await runAsk(
      {
        kind: 'lookup',
        name: 'Dana Reyes',
        profileUrl: `${AL}/biz/businesses/B1`,
        draft: { workspaceId: 'b' },
      } as never,
      job,
      'alignable',
    );
    const drafted = sent.find((s) => s.type === 'hfos-draft');
    expect(drafted).toBeDefined();
    expect(end).toMatchObject({
      line: 'Wrote a draft after looking Dana Reyes up on Alignable.',
      result: { drafts: ['Hi Dana!'], lookedUp: true },
    });
  });
});

describe('Find posts in your town, on Alignable', () => {
  /** Their own profile, at their business's address in their town. */
  const mine = () =>
    new JSDOM(
      `<!doctype html><html><body><main><h1 title="Casey Owner">Casey Owner</h1></main></body></html>`,
      { url: `${AL}/columbus-oh/summit-roofing?user=77` },
    ).window.document;
  /** Their town's group: a business asking for a plumber, and a post with no page of its own. */
  const town = () =>
    new JSDOM(
      `<!doctype html><html><body><main>
        <div><div><a href="/columbus-oh/reyes-plumbing"><span>Dana Reyes</span><span>Reyes Plumbing</span></a></div>
          <div title="Can anyone recommend a roofer?">Can anyone recommend a roofer after last week’s storm?</div>
          <a href="/biz/discussions/501">Comment</a></div>
        <div><div><a href="/columbus-oh/lee-realty"><span>Sam Lee</span></a></div><div title="Hello">Hello all</div></div>
        <div><div><a href="/columbus-oh/summit-roofing"><span>Casey Owner</span><span>Summit Roofing</span></a></div>
          <div title="Storm season">Storm season is here: we’re booking roof checks all week.</div>
          <a href="/biz/discussions/502">Comment</a></div>
      </main></body></html>`,
      { url: `${AL}/groups/columbus-oh` },
    ).window.document;

  it('opens their town from their profile, and sends its posts by businesses for the AI to check, never their own', async () => {
    const { tab, opened } = alignableTab({
      '/biz/businesses/my_profile': mine,
      '/columbus-oh': town,
    });
    const { job, sent } = alignableJob(tab, { 'hfos-save-posts': () => ({ checking: 1 }) });
    const end = await runAsk({ kind: 'posts', groups: null, words: [] } as never, job, 'alignable');
    expect(opened).toEqual(['/biz/businesses/my_profile', '/columbus-oh']);
    const saved = sent.filter((s) => s.type === 'hfos-save-posts').map((s) => s.input);
    expect(saved).toEqual([
      {
        workspaceId: 'b',
        platform: 'alignable',
        group: null,
        found: 'find',
        posts: [
          expect.objectContaining({
            url: `${AL}/biz/discussions/501`,
            name: 'Dana Reyes',
            text: 'Can anyone recommend a roofer after last week’s storm?',
          }),
        ],
      },
    ]);
    expect(end).toMatchObject({
      line: 'Read 1 post in your town on Alignable: 1 post sent for the AI to check. The good ones go on your list for today.',
    });
  });

  it('says to add their town when their profile has none', async () => {
    const nowhere = () =>
      new JSDOM('<!doctype html><html><body><main></main></body></html>', {
        url: `${AL}/biz/businesses/my_profile`,
      }).window.document;
    const { tab } = alignableTab({ '/biz/businesses/my_profile': nowhere });
    const { job } = alignableJob(tab);
    const end = await runAsk({ kind: 'posts', groups: null, words: [] } as never, job, 'alignable');
    expect(end).toMatchObject({
      failed: true,
      line: expect.stringContaining('didn’t show your town'),
    });
  });
});

describe('warm leads from Alignable’s notifications', () => {
  /** A notification, drawn as the owner's Check outlined Notifications (0.68.0): its link, who, and what they did. */
  const note = (n: number, who: string, at: string, did: string) => `<div>
      <a href="/biz/notifications/${n}/9${n}?cyattr=a&cyfid=b"><img alt="${who}" /></a>
      <div><div><div><a href="/${at}?cyattr=a&cyfid=b">${who}</a> ${did}
        <a href="/biz/notifications/${n}/9${n}?cyattr=a&cyfid=b">your post about storm season</a></div>
        <div>1w</div></div></div></div>`;
  const notifications = () =>
    new JSDOM(
      `<!doctype html><html><body><main>
        ${note(1, 'Dana Reyes', 'austin-tx/acme-plumbing', 'liked')}
        ${note(2, 'Sam Lee', 'round-rock-tx/best-bakery', 'recommended you on')}
        ${note(3, 'Kim Ng', 'austin-tx/ng-insurance', 'commented on')}
        ${note(4, 'Pat Doe', 'austin-tx/doe-cleaning', 'wants to connect, from')}
        ${note(5, 'Dana Reyes', 'austin-tx/acme-plumbing', 'also liked')}
      </main></body></html>`,
      { url: `${AL}/biz/notifications` },
    ).window.document;

  it('sends who liked, commented on or recommended them, once each, and nobody else', async () => {
    const { tab, opened } = alignableTab({ '/biz/notifications': notifications });
    const { job, sent } = alignableJob(tab, { 'hfos-engaged-save': () => ({ added: 3 }) });
    const end = await readWarmLeads(job);
    expect(opened).toEqual(['/biz/notifications']);
    const save = sent.find((s) => s.type === 'hfos-engaged-save')!.input as {
      platform: string;
      engaged: { name: string; kind: string; profile: { username: string } }[];
    };
    expect(save.platform).toBe('alignable');
    expect(save.engaged.map((e) => [e.name, e.kind, e.profile.username])).toEqual([
      ['Dana Reyes', 'reaction', 'austin-tx-acme-plumbing'],
      ['Sam Lee', 'recommend', 'round-rock-tx-best-bakery'],
      ['Kim Ng', 'comment', 'austin-tx-ng-insurance'],
    ]);
    expect(end.line).toBe(
      'Read your Alignable notifications: 3 new warm leads who liked, commented on or recommended you, on your list for today.',
    );
  });
});

/** Messages as the owner's Check of 21 Oct 2026 outlined it: conversations down the side, rows that aren't links. */
const sideRow = (name: string, preview: string | null, when: string) =>
  `<div data-testid="conversationInSidebar"><div><div><img alt="" /><div><div>${name}</div>${
    preview ? `<div>${preview}</div>` : ''
  }</div></div><span data-testid="conversationDate">${when}</span></div></div>`;
const theirs = (id: string, name: string, words: string) =>
  `<div><a href="/biz/businesses/${id}?user=5"><img alt="" /></a><div><div><span>${name}</span><span>9:12 AM</span></div>
    <div data-testid="rel-card-message"><div>${words}</div><svg role="img"></svg></div></div></div>`;
const mine = (words: string) =>
  `<div><div><div><span>You</span><span>9:40 AM</span></div>
    <div data-testid="rel-card-message"><div>${words}</div><svg role="img"></svg></div></div><img alt="" /></div>`;
const CONVERSATIONS: Record<string, readonly [string, string]> = {
  'Dana Reyes': [
    'B1',
    `${mine('Want to swap referrals?')}${theirs('B1', 'Dana Reyes', 'Yes, Tuesday works.')}`,
  ],
  'Lee Park': [
    'B2',
    `${theirs('B2', 'Lee Park', 'Thanks for connecting!')}${mine('Likewise, Lee.')}`,
  ],
  'Kim Bakes': [
    'B3',
    `${theirs('B3', 'Kim Bakes', 'Good to meet you!')}${mine('Same here, Kim.')}`,
  ],
};
const pane = (name: string) => {
  const [id, rows] = CONVERSATIONS[name]!;
  return `<div data-testid="channel-header-loaded"><header><div><div><img alt="" />
      <a href="/biz/businesses/${id}?user=5&cyfid=6"><div>${name}</div></a></div></div></header></div>
    <div><div><div><p>You and ${name} are connected</p>${rows}</div></div></div>
    <div data-testid="full-view-write-message"><div contenteditable="true" placeholder="Write a message"></div>
      <button aria-label="Send" data-testid="messaging-send-external"></button></div>`;
};

/**
 * Where Alignable hears a press of a row: on the row's outermost part (`row`), as these tests first had it; on the part
 * inside it, as the owner's Read my chats of 21 Oct 2026 showed, where a press of the outermost part opened nothing
 * (`inside`); or there, as the press starts (`mousedown`).
 */
type Listens = 'row' | 'inside' | 'mousedown';

/**
 * Messages, open on Dana's conversation: pressing a row opens its conversation beside the list, but for the rows of
 * `deaf`, which open nothing.
 */
function messages(listens: Listens = 'row', deaf: readonly string[] = []): Document {
  const doc = new JSDOM(
    `<!doctype html><html><body><div data-testid="inbox">
      <div id="side" style="overflow-y: auto">${sideRow('Dana Reyes', 'Yes, Tuesday works.', '2h')}
        ${sideRow('Lee Park', 'Likewise, Lee.', '3d')}${sideRow('Sam Lee', null, '1w')}${sideRow('Kim Bakes', 'Same here, Kim.', '2w')}</div>
      <div id="open">${pane('Dana Reyes')}</div></div></body></html>`,
    { url: `${AL}/biz/conversations` },
  ).window.document;
  for (const row of doc.querySelectorAll<HTMLElement>('[data-testid="conversationInSidebar"]')) {
    const name = [...row.querySelectorAll('div')].find((d) => !d.children.length)!.textContent!;
    if (deaf.includes(name)) continue;
    const part = listens === 'row' ? row : row.firstElementChild!;
    part.addEventListener(listens === 'mousedown' ? 'mousedown' : 'click', () => {
      if (CONVERSATIONS[name]) doc.querySelector('#open')!.innerHTML = pane(name);
    });
  }
  return doc;
}

describe('Read my chats, on Alignable', () => {
  it('opens a conversation by its row’s name, and scrolls the list down Messages’ side, never the page', () => {
    const doc = messages();
    expect(openConversation(doc, 'lee park')).toBe(true);
    expect(doc.querySelector('[data-testid="channel-header-loaded"] a')!.textContent).toBe(
      'Lee Park',
    );
    expect(openConversation(doc, 'Pat Kim')).toBe(false);
    const side = doc.querySelector<HTMLElement>('#side')!;
    let top = 0;
    Object.defineProperty(side, 'clientHeight', { get: () => 400 });
    Object.defineProperty(side, 'scrollHeight', { get: () => 900 });
    Object.defineProperty(side, 'scrollTop', { get: () => top });
    side.scrollBy = (() => (top = 500)) as typeof side.scrollBy;
    expect(scrollConversations(doc)).toBe(true);
    expect(scrollConversations(doc)).toBe(false);
  });

  it('reads each conversation for the AI as Alignable’s, and notes the one whose last message is theirs', async () => {
    const { tab, opened } = alignableTab({ '/biz/conversations': messages });
    const store = new Map<string, unknown>();
    const chromeHere = () =>
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
    chromeHere();
    const ask = tab.ask.bind(tab);
    const asked: string[] = [];
    // The tab's own work stands in for the page's, and puts back what it stood in for after: chrome too.
    tab.ask = (async (message: { type: string }) => {
      asked.push(message.type);
      const answer = await ask(message as never);
      chromeHere();
      return answer;
    }) as typeof tab.ask;
    try {
      const { job, sent } = alignableJob(tab, {
        'hfos-collect-chats': () => ({ saved: 1, waiting: 1 }),
        'hfos-replies-note': () => ({ replies: [] }),
      });
      const end = await runAsk({ kind: 'chats' }, job, 'alignable');
      expect(opened).toEqual(['/biz/conversations']);
      // Its rows pressed and its list scrolled: nothing else.
      expect(new Set(asked)).toEqual(new Set(['hfos-read', 'hfos-open-chat', 'hfos-scroll-list']));
      const chats = sent
        .filter((s) => s.type === 'hfos-collect-chats')
        .map(
          (s) =>
            s.input as {
              platform: string;
              chats: { name: string; thread: unknown; messages: { fromMe: boolean }[] }[];
            },
        );
      // Sam Lee's has nothing in it yet, so it isn't opened.
      expect(
        chats.map((c) => [
          c.platform,
          c.chats[0]!.name,
          c.chats[0]!.thread,
          c.chats[0]!.messages.map((m) => m.fromMe),
        ]),
      ).toEqual([
        ['alignable', 'Dana Reyes', { id: 'B1', encrypted: false }, [true, false]],
        ['alignable', 'Lee Park', { id: 'B2', encrypted: false }, [false, true]],
        ['alignable', 'Kim Bakes', { id: 'B3', encrypted: false }, [false, true]],
      ]);
      // Dana wrote last, two hours ago; Lee's and Kim's end with the person's own.
      expect(sent.filter((s) => s.type === 'hfos-replies-note').map((s) => s.input)).toEqual([
        {
          workspaceId: 'b',
          platform: 'alignable',
          looking: false,
          seen: [
            {
              name: 'Dana Reyes',
              threadKey: 'B1',
              profile: { id: 'B1', username: null, url: `${AL}/biz/businesses/B1` },
            },
          ],
        },
      ]);
      expect(end).toEqual({
        line: 'Done: 3 chats sent for the AI to read. 1 chat had their message last. Chats read in the last day were left as they were.',
        warned: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** Read my chats on a Messages page, with the extension's storage and what it sent kept here. */
  async function readChatsOn(page: () => Document) {
    const { tab } = alignableTab({ '/biz/conversations': page });
    const store = new Map<string, unknown>();
    const chromeHere = () =>
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
    chromeHere();
    const ask = tab.ask.bind(tab);
    tab.ask = (async (message: { type: string }) => {
      const answer = await ask(message as never);
      chromeHere();
      return answer;
    }) as typeof tab.ask;
    try {
      const { job, sent } = alignableJob(tab, {
        'hfos-collect-chats': () => ({ saved: 1, waiting: 1 }),
        'hfos-replies-note': () => ({ replies: [] }),
      });
      const reports: ReportNote[] = [];
      const end = await runAsk(
        { kind: 'chats' },
        { ...job, report: async (note) => void reports.push(note ?? {}) },
        'alignable',
      );
      const chats = sent
        .filter((s) => s.type === 'hfos-collect-chats')
        .map((s) => (s.input as { chats: { name: string }[] }).chats[0]!.name);
      const read = Object.keys((store.get('hfos.chatsRead') ?? {}) as object);
      return { end, chats, reports, read };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('opens each conversation where Alignable hears the press inside its row, as on his Messages (21 Oct 2026)', async () => {
    for (const listens of ['inside', 'mousedown'] as const) {
      const doc = messages(listens);
      // A press of the row's outermost part, as 0.84.0 pressed it, opens nothing there.
      doc.querySelectorAll<HTMLElement>('[data-testid="conversationInSidebar"]')[1]!.click();
      expect(doc.querySelector('[data-testid="channel-header-loaded"] a')!.textContent).toBe(
        'Dana Reyes',
      );
      // Pressed on its name, as a person's pointer lands, it opens.
      expect(openConversation(doc, 'Lee Park')).toBe(true);
      expect(doc.querySelector('[data-testid="channel-header-loaded"] a')!.textContent).toBe(
        'Lee Park',
      );
      // Every conversation with messages is read, not only the one Messages opened on.
      const { end, chats, reports } = await readChatsOn(() => messages(listens));
      expect(chats).toEqual(['Dana Reyes', 'Lee Park', 'Kim Bakes']);
      expect(end.line).toMatch(/^Done: 3 chats sent for the AI to read\./);
      expect(reports).toEqual([]);
    }
  });

  it('leaves a conversation its row didn’t open for next time, says so, and sends the page once', async () => {
    const { end, chats, reports, read } = await readChatsOn(() =>
      messages('inside', ['Lee Park', 'Kim Bakes']),
    );
    expect(chats).toEqual(['Dana Reyes']);
    expect(end.line).toBe(
      'Done: 1 chat sent for the AI to read. 1 chat had their message last. Alignable didn’t open 2 chats when their rows were pressed: they’re tried again next time. Chats read in the last day were left as they were.',
    );
    // Only Dana's is kept as read: Lee's and Kim's are tried again.
    expect(read).toEqual(['alignable:dana reyes']);
    expect(reports).toEqual([
      {
        job: 'chats.open',
        note: 'A conversation’s row was pressed, and Messages didn’t open it.',
        outline: true,
      },
    ]);
  });
});
