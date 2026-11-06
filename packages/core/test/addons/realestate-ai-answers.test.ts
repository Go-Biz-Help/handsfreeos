/**
 * What the Assistant reads of the Real Estate Agent's answers, and what its cards say (ai-answers.ts): the short facts
 * ahead of the long lists, a home's MLS photos as a count, a history in the words its page shows, and cards that say
 * what a change would do, by name, never a lockbox's code. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  briefMls,
  historyAnswer,
  homesAnswer,
  listingAnswer,
  listingCampaignCard,
  listingCampaignOutcome,
  lockboxCard,
  photoChanges,
  photosArrangeCard,
  termsConfirmCard,
} from '../../src/addons/realestate/ai-answers';
import { dealHistoryWords } from '../../src/addons/realestate/history-words';

const mls = (photos: number, words = 'Sunny corner lot. '.repeat(40)) => ({
  mlsNumber: 'A123',
  status: 'active',
  photos: Array.from({ length: photos }, (_, i) => ({
    url: `https://cdn.example/p${i}.jpg`,
    caption: null,
  })),
  description: words,
  display: {
    notice: 'Listing data courtesy of the MLS.',
    logoUrl: 'https://cdn.example/logo.png',
    courtesy: 'Courtesy of Acme Realty',
  },
});

describe('a buyer’s homes and matches', () => {
  it('count a home’s MLS photos and cut its description short, keeping who it’s courtesy of', () => {
    const brief = briefMls(mls(12)) as Record<string, unknown>;
    expect(brief).toMatchObject({
      mlsNumber: 'A123',
      photoCount: 12,
      courtesy: 'Courtesy of Acme Realty',
    });
    expect(brief).not.toHaveProperty('photos');
    expect(brief).not.toHaveProperty('display');
    expect((brief['description'] as string).length).toBeLessThanOrEqual(301);
    expect(brief['description']).toMatch(/…$/);
  });

  it('say how many there are first, and give one home asked for by its id whole', () => {
    const output = { homes: [{ id: 'h1', address: '1 Oak St', mls: mls(3) }], total: 7 };
    const many = homesAnswer(output, { dealId: 'd' }) as {
      total: number;
      shown: number;
      homes: { mls: { description: string } }[];
    };
    expect(Object.keys(many)).toEqual(['total', 'shown', 'homes']);
    expect(many).toMatchObject({ total: 7, shown: 1 });
    expect(many.homes[0]!.mls.description).toMatch(/…$/);
    const one = homesAnswer(output, { dealId: 'd', homeId: 'h1' }) as typeof many;
    expect(one.homes[0]!.mls.description).toBe(mls(0).description);
  });
});

describe('a listing', () => {
  it('puts its price, page and description in use first, and the long lists last', () => {
    const got = listingAnswer({
      listing: {
        dealId: 'd',
        choices: [{ key: 'beds' }],
        photos: [{ id: 'p1' }],
        feed: { state: 'found', mls: mls(20) },
        listPriceCents: 50_000_000,
        page: { state: 'published', slug: 'oak', path: '/a/acme/realestate/oak' },
        description: {
          inUse: { words: 'A lovely home.' },
          working: null,
          history: [{ id: 'v1', version: 1, words: 'Old words.', state: 'replaced' }],
        },
      },
    }) as Record<string, unknown>;
    const keys = Object.keys(got);
    expect(keys.indexOf('listPriceCents')).toBeLessThan(keys.indexOf('photos'));
    expect(keys.indexOf('page')).toBeLessThan(keys.indexOf('choices'));
    expect(keys.slice(-3)).toEqual(['feed', 'photos', 'choices']);
    expect(got['description']).toEqual({
      inUse: { words: 'A lovely home.' },
      working: null,
      history: [{ id: 'v1', version: 1, state: 'replaced' }],
    });
    expect((got['feed'] as { mls: { photoCount: number } }).mls.photoCount).toBe(20);
  });
});

describe('a deal’s history', () => {
  it('says each line in the words the History page shows', () => {
    const line = {
      at: '2026-11-01T15:00:00.000Z',
      what: 'stage',
      before: { stage: 'lead' },
      after: { stage: 'active' },
    };
    const got = historyAnswer({ lines: [line] }) as { lines: { words: string }[] };
    expect(got.lines[0]).toMatchObject({
      ...line,
      words: dealHistoryWords('stage', line.before, line.after),
    });
    expect(got.lines[0]!.words).not.toBe('');
  });
});

describe('the photos card', () => {
  const before = [
    { id: 'a', caption: 'Kitchen', public: true, name: 'kitchen.jpg' },
    { id: 'b', caption: null, public: true, name: 'yard.jpg' },
    { id: 'c', caption: 'Bath', public: true, name: 'bath.jpg' },
  ];

  it('names only the photos that change, and how', () => {
    const changes = photoChanges(before, [
      { id: 'b', caption: null, public: true },
      { id: 'a', caption: 'Updated kitchen', public: true },
      { id: 'c', caption: 'Bath', public: false },
    ]);
    expect(changes).toEqual([
      'Photo 1 (yard.jpg): moved from 2',
      'Photo 2 (Updated kitchen): caption “Kitchen” → “Updated kitchen”; moved from 1',
      'Photo 3 (Bath): off the public page',
    ]);
    expect(photosArrangeCard({ dealName: '12 Oak St', changes })).toMatchObject({
      title: 'Change 3 photos on 12 Oak St?',
      lines: changes.map((value, i) => ({ label: `Change ${i + 1}`, value })),
    });
  });

  it('says so when nothing changes', () => {
    const same = before.map(({ id, caption, public: p }) => ({ id, caption, public: p }));
    expect(photoChanges(before, same)).toEqual([]);
    expect(photosArrangeCard({ dealName: '12 Oak St', changes: [] })?.title).toBe(
      'Keep 12 Oak St’s photos as they are?',
    );
  });
});

describe('the card for emailing contacts about a listing', () => {
  const output = {
    campaignId: '0d6b2f1e-8a4c-4e2b-9f3a-5c6d7e8f9a0b',
    recipients: 42,
    skipped: 3,
    street: '12 Oak St',
    channel: 'email',
    words: {
      subject: 'Just listed: 12 Oak St',
      body: 'See it: https://app.example/a/acme/realestate/oak',
    },
    audience: { tags: ['Past clients'], stages: ['Qualified (Sales)'] },
  };

  it('says how many it reaches, who by name, who it leaves out and its exact words, with a warning', () => {
    const card = listingCampaignCard(output)!;
    expect(card.title).toBe('Email 42 people about 12 Oak St?');
    expect(card.lines).toEqual([
      { label: 'Tagged', value: 'Past clients' },
      { label: 'At the stage', value: 'Qualified (Sales)' },
      { label: 'Left out', value: '3 people: no email, unsubscribed, bounced or emailed lately' },
      { label: 'Subject', value: 'Just listed: 12 Oak St' },
      { label: 'Words', value: output.words.body },
    ]);
    expect(card.warning).toMatch(/waits in Campaigns until someone approves it/);
    expect(JSON.stringify(card)).not.toMatch(/tagIds|stageIds/);
  });

  it('ends, once confirmed, with where it waits', () => {
    expect(listingCampaignOutcome(output)).toEqual({
      words: 'The email to 42 people about 12 Oak St waits in Campaigns for someone to approve it.',
      path: `campaigns/${output.campaignId}`,
    });
    expect(listingCampaignCard({ ...output, channel: 'sms', recipients: 1 })?.title).toBe(
      'Text 1 person about 12 Oak St?',
    );
  });
});

describe('the key dates card', () => {
  it('lists each value it confirms, on whose deal', () => {
    expect(
      termsConfirmCard({
        dealName: 'Lee purchase',
        confirmed: [
          { entryId: 'e1', label: 'Closing date', value: 'Dec 12, 2026' },
          { entryId: 'e2', label: 'Purchase price', value: '$450,000' },
        ],
      }),
    ).toEqual({
      title: 'Confirm 2 values on Lee purchase?',
      lines: [
        { label: 'Closing date', value: 'Dec 12, 2026' },
        { label: 'Purchase price', value: '$450,000' },
      ],
    });
    expect(termsConfirmCard({ dealName: 'Lee purchase', confirmed: [] })?.title).toBe(
      'Nothing to confirm on Lee purchase',
    );
  });
});

describe('the lockbox card', () => {
  it('says what changes, and only whether a code is kept, never one', () => {
    const card = lockboxCard({
      dealName: '12 Oak St',
      before: { kind: 'supra', kindLabel: 'Supra', place: 'Front door', serial: null },
      lockbox: {
        kind: 'supra',
        kindLabel: 'Supra',
        place: 'Side gate',
        serial: '12345678',
        hasCode: true,
      },
    })!;
    expect(card).toEqual({
      title: 'Change a lockbox on 12 Oak St?',
      lines: [
        { label: 'Kind', value: 'Supra' },
        { label: 'Where it is', value: 'Front door → Side gate' },
        { label: 'Serial number', value: 'none → 12345678' },
        { label: 'Code', value: 'Kept as it is, locked' },
      ],
    });
    expect(
      lockboxCard({
        dealName: '12 Oak St',
        before: null,
        lockbox: { kindLabel: 'SentriLock', place: null, serial: null, hasCode: false },
      })?.title,
    ).toBe('Add a lockbox to 12 Oak St?');
  });
});
