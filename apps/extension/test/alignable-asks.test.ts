/**
 * What the person asks of their computer on Alignable (partners stage 6c, part 4; src/jobs/alignable): their
 * connections saved from My Network, all of them once its tab of them all is pressed and its Show more has nothing
 * left; the connection requests they've got saved from its Requests; a connection's business page read for the AI's
 * check, only when it's theirs; and a business looked up before drafting. On pages drawn as the owner's Check
 * Alignable found them (0.68.0): `connection-row`s under `allies-picks-list`, beside `tab-all-connections`.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { readWarmLeads } from '../src/jobs/alignable/engaged';
import { alignableListSave } from '../src/hfos/saves';
import { KITS } from '../src/networks';
import { openConversation, scrollList, showAllConnections } from '../src/networks/alignable/browse';
import type { Hfos, Job, JobTab } from '../src/jobs/job';

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
      </main></body></html>`,
      { url: `${AL}/groups/columbus-oh` },
    ).window.document;

  it('opens their town from their profile, and sends its posts by businesses for the AI to check', async () => {
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
