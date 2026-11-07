/**
 * How the Assistant reads the Add-ons page, the vote on what's next and the Roadmap, without a database: each card in
 * the page's own words (where it stands, Testing, the trouble callout, the note in place of Install, what it lets you do
 * and needs), Coming soon without what the business has, the vote filtered as the page filters it, the Roadmap a column
 * at a time, and the link to an add-on's Connections.
 */
import {
  ADDON_CATALOG,
  ADDON_PAGE_WORDS as W,
  ADDON_STATE_WORDS,
  addonCheckWords,
  findAddon,
  IDEA_STATUS_MEANING,
  IDEAS_WORDS,
} from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import {
  addOnsRead,
  addOnsTidy,
  connectionsRead,
  plannedRead,
  roadmapRead,
  voteRead,
} from '../src/assistant/addons-page';

const realestate = findAddon(ADDON_CATALOG, 'realestate')!;

/** One installation as addon.list gives it. */
const installed = (over: Record<string, unknown>) => ({
  addonId: 'realestate',
  name: realestate.name,
  summary: realestate.summary,
  state: 'enabled',
  lastError: null,
  failedChecks: [],
  retired: false,
  status: 'beta',
  running: true,
  ...over,
});

type Card = Record<string, unknown>;
const read = (list: unknown) =>
  addOnsRead(list) as { inThisBusiness: Card[]; availableToAdd: Card[] };

describe('the Add-ons page, as get_settings reads it', () => {
  it('says where each add-on stands in the page’s words, with what it lets you do and needs', () => {
    const { inThisBusiness } = read({
      installed: [installed({})],
      capabilities: { installable: [] },
      catalog: [],
    });
    expect(inThisBusiness).toEqual([
      expect.objectContaining({
        addonId: 'realestate',
        name: realestate.name,
        state: ADDON_STATE_WORDS.enabled.label,
        whatThatMeans: ADDON_STATE_WORDS.enabled.detail,
        running: true,
        category: 'Industry add-on',
        whatItNeeds: W.needsNothing,
      }),
    ]);
    expect(inThisBusiness[0]!['whatItLetsYouDo']).toEqual(
      realestate.capabilities.map((c) => ({ label: c.label, description: c.description })),
    );
    // Nothing that isn't on the card: no Testing badge, no trouble, nothing in place of a move.
    expect(inThisBusiness[0]).not.toHaveProperty('testing');
    expect(inThisBusiness[0]).not.toHaveProperty('trouble');
    expect(inThisBusiness[0]).not.toHaveProperty('inPlaceOfInstall');
  });

  it('marks one handed over to test, and says why it isn’t finished, check by check', () => {
    const { inThisBusiness } = read({
      installed: [installed({ lastError: 'checks failed', failedChecks: ['no_jobs_pending'] })],
      capabilities: { installable: [] },
      catalog: [
        {
          addonId: 'realestate',
          name: realestate.name,
          summary: realestate.summary,
          status: 'beta',
          testing: true,
        },
      ],
    });
    expect(inThisBusiness[0]).toMatchObject({
      testing: W.testingDetail,
      trouble: [W.troubleChecks, addonCheckWords('no_jobs_pending')],
    });
    // Trouble with no check to name says so in its own words.
    const plain = read({
      installed: [installed({ lastError: 'boom', failedChecks: [] })],
      capabilities: { installable: [] },
      catalog: [],
    });
    expect(plain.inThisBusiness[0]!['trouble']).toBe(W.trouble);
  });

  it('says when HandsFreeOS switched one off, no longer has one, or one can’t come back here', () => {
    const { inThisBusiness } = read({
      installed: [
        installed({ running: false }),
        installed({
          addonId: 'gone',
          name: 'gone',
          summary: '',
          state: 'disabled',
          retired: true,
          status: null,
          running: false,
        }),
        installed({
          addonId: 'outreach',
          name: 'Social Outreach',
          state: 'uninstalled',
          status: 'development',
          running: false,
        }),
      ],
      capabilities: { installable: [] },
      catalog: [],
    });
    expect(inThisBusiness[0]).toMatchObject({ note: W.paused(realestate.name) });
    expect(inThisBusiness[0]).not.toHaveProperty('whatThatMeans');
    expect(inThisBusiness[1]).toMatchObject({ note: W.retired });
    expect(inThisBusiness[1]).not.toHaveProperty('inPlaceOfInstall');
    expect(inThisBusiness[2]).toMatchObject({
      state: ADDON_STATE_WORDS.uninstalled.label,
      inPlaceOfInstall: W.cantAdd,
    });
  });

  it('lists what could be added, the ones handed over to test too, with Install or the note in its place', () => {
    const catalog = [
      {
        addonId: 'salescoach',
        name: 'AI Sales Coach',
        summary: 'Coach',
        status: 'available',
        testing: false,
      },
      {
        addonId: 'outreach',
        name: 'Social Outreach',
        summary: 'Reach',
        status: 'development',
        testing: true,
      },
      { addonId: 'realestate', name: realestate.name, summary: '', status: 'beta', testing: true },
    ];
    const open = read({
      installed: [installed({})],
      capabilities: { installable: [{ provider: 'salescoach' }, { provider: 'outreach' }] },
      catalog,
    });
    // The one it has already is in this business, not to add.
    expect(open.availableToAdd.map((a) => a.addonId)).toEqual(['salescoach', 'outreach']);
    expect(open.availableToAdd[0]).toMatchObject({ canInstall: true });
    expect(open.availableToAdd[0]).not.toHaveProperty('inPlaceOfInstall');
    expect(open.availableToAdd[1]).toMatchObject({ canInstall: true, testing: W.testingDetail });

    const shut = read({ installed: [], capabilities: { installable: [] }, catalog });
    expect(shut.availableToAdd[0]).toMatchObject({
      canInstall: false,
      inPlaceOfInstall: W.cantAdd,
    });
  });
});

const roadmap = {
  comingSoon: [
    {
      addonId: 'realestate',
      name: 'Real Estate Agent',
      summary: 'Deals',
      how: 'plan',
      votes: 4,
      voted: true,
    },
    { addonId: 'pets', name: 'Pet Care', summary: 'Pets', how: 'votes', votes: 2, voted: false },
  ],
  planned: [
    {
      addonId: 'roofing',
      name: 'Roofing',
      summary: 'Roof jobs and inspections.',
      category: 'industry',
      groups: ['Home services & trades'],
      overlap: null,
      votes: 3,
      voted: false,
    },
    {
      addonId: 'budget',
      name: 'Budgets',
      summary: 'Plan spending by month.',
      category: 'finance',
      groups: ['Money'],
      overlap: 'HandsFreeOS already sends invoices.',
      votes: 9,
      voted: true,
    },
    {
      addonId: 'hvac',
      name: 'HVAC',
      summary: 'Heating and cooling service plans.',
      category: 'industry',
      groups: ['Home services & trades'],
      overlap: null,
      votes: 3,
      voted: false,
    },
  ],
  nextPickAt: '2026-11-09T05:00:00.000Z',
};

describe('the vote on what’s next', () => {
  it('sums up Coming soon and the vote with each add-on’s id, for get_settings', () => {
    const vote = voteRead(roadmap) as Record<string, unknown>;
    expect(vote['comingSoon']).toEqual([
      { addonId: 'realestate', name: 'Real Estate Agent', summary: 'Deals', youVoted: true },
      { addonId: 'pets', name: 'Pet Care', summary: 'Pets', youVoted: false },
    ]);
    expect(vote['mostVotes']).toEqual([
      { addonId: 'budget', name: 'Budgets', votes: 9, youVoted: true },
      { addonId: 'hvac', name: 'HVAC', votes: 3, youVoted: false },
      { addonId: 'roofing', name: 'Roofing', votes: 3, youVoted: false },
    ]);
    expect(vote['youVotedFor']).toEqual([{ addonId: 'budget', name: 'Budgets' }]);
    expect(vote['planned']).toBe(3);
  });

  it('leaves out of Coming soon what the business already has, as the page does', () => {
    const tidy = addOnsTidy({
      addOns: { inThisBusiness: [{ addonId: 'realestate' }], availableToAdd: [] },
      vote: voteRead(roadmap),
    }) as { vote: { comingSoon: { addonId: string }[] } };
    expect(tidy.vote.comingSoon.map((c) => c.addonId)).toEqual(['pets']);
    // A part this person may not see stays as it was.
    expect(addOnsTidy({ addOns: null, vote: null })).toEqual({ addOns: null, vote: null });
  });

  it('filters and sorts the list as the page does, with the chips’ counts and the groups', () => {
    type Planned = {
      comingSoon: { addonId: string; youVoted?: string }[];
      categories: { category: string; label: string; count: number }[];
      groups: string[];
      shown: string;
      more?: number;
      planned: Record<string, unknown>[];
    };
    const all = plannedRead(roadmap, {}, new Set(['realestate'])) as Planned;
    expect(all.comingSoon).toEqual([expect.objectContaining({ addonId: 'pets', votes: 2 })]);
    expect(all.categories).toEqual([
      { category: 'all', label: W.allCategories, count: 3 },
      { category: 'industry', label: 'Industry', count: 2 },
      { category: 'finance', label: 'Finance', count: 1 },
    ]);
    expect(all.groups).toEqual(['Home services & trades', 'Money']);
    expect(all.shown).toBe(W.plannedCount(3));
    // Most votes first, then A to Z.
    expect(all.planned.map((p) => p['addonId'])).toEqual(['budget', 'hvac', 'roofing']);
    expect(all.planned[0]).toEqual({
      addonId: 'budget',
      name: 'Budgets',
      summary: 'Plan spending by month.',
      category: 'Finance',
      groups: ['Money'],
      alreadyInHandsFreeOS: 'HandsFreeOS already sends invoices.',
      votes: 9,
      youVoted: true,
    });

    const industry = plannedRead(
      roadmap,
      { category: 'industry', sort: 'az' },
      new Set(),
    ) as Planned;
    expect(industry.planned.map((p) => p['name'])).toEqual(['HVAC', 'Roofing']);
    expect(industry.comingSoon[0]).toMatchObject({
      addonId: 'realestate',
      youVoted: W.comingSoonVoted,
    });

    const found = plannedRead(roadmap, { search: 'heating' }, new Set()) as Planned;
    expect(found.planned.map((p) => p['addonId'])).toEqual(['hvac']);
    expect(found.categories[0]!.count).toBe(1);

    const few = plannedRead(roadmap, { limit: 1 }, new Set()) as Planned;
    expect(few.planned).toHaveLength(1);
    expect(few.more).toBe(2);
  });
});

describe('the Roadmap, a column at a time', () => {
  const card = (n: number) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    number: n,
    title: `Idea ${n}`,
    areaId: 'money',
    voteCount: n,
    voted: n === 1,
    statusChangedAt: '2026-10-01T12:00:00.000Z',
  });
  const columns = {
    planned: Array.from({ length: 20 }, (_, i) => card(i + 1)),
    inProgress: [],
    done: [card(30)],
  };
  type Column = {
    column: string;
    status: string;
    means: string;
    count: number;
    cards: Card[];
  } & Card;

  it('gives each column’s count and first cards, in the tab’s words, so Done lately is never cut off', () => {
    const read = roadmapRead(columns, {}, [{ id: 'money', name: 'Money' }]) as {
      columns: Column[];
    };
    expect(read.columns.map((c) => c.column)).toEqual([
      'Planned',
      'In progress',
      IDEAS_WORDS.doneLately,
    ]);
    const [planned, building, done] = read.columns;
    expect(planned).toMatchObject({ count: 20, more: 5, means: IDEA_STATUS_MEANING.planned });
    expect(planned!.cards).toHaveLength(15);
    expect(planned!.cards[0]).toEqual({
      ideaId: card(1).id,
      number: 1,
      title: { someone_wrote: 'Idea 1' },
      area: 'Money',
      votes: 1,
      youVoted: true,
      since: '2026-10-01',
    });
    expect(building).toMatchObject({ count: 0, empty: IDEAS_WORDS.roadmapEmpty.in_progress });
    expect(done!.means).toContain('90 days');
    expect(done!.cards).toHaveLength(1);
  });

  it('reads one column on its own', () => {
    const read = roadmapRead(columns, { column: 'planned' }, []) as { columns: Column[] };
    expect(read.columns).toHaveLength(1);
    expect(read.columns[0]!.cards).toHaveLength(20);
    expect(read.columns[0]).not.toHaveProperty('more');
    // An area this build can't name goes by its id.
    expect(read.columns[0]!.cards[0]!['area']).toBe('money');
  });
});

describe('an add-on’s connections', () => {
  it('adds the link to its Connections page, which opens its own tab when it keeps one', () => {
    const got = connectionsRead(
      { connectors: [] },
      { addonId: 'realestate' },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'https://app.example.com/',
    );
    expect(got).toEqual({
      connectors: [],
      page: 'https://app.example.com/app/w/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/addons/realestate/connections',
    });
  });
});
