/**
 * What Social Outreach's AI is told the business knows (docs/outreach.md decision 122): the business profile and its
 * Knowledge go with every message, comment and helpful post that says something about the business, and a reply says
 * what nothing answers, so it waits for the person.
 */
import { describe, expect, it } from 'vitest';
import { helpfulPrompt } from '../../src/addons/outreach/helpful';
import {
  KNOWS_WORDS,
  knowsBlocks,
  UNANSWERED_MOST,
  unansweredLine,
  type DraftKnows,
} from '../../src/addons/outreach/knows';
import { partnerDraftPrompt } from '../../src/addons/outreach/partners';
import { SendQueueInput } from '../../src/addons/outreach/sends';
import {
  TODAY_DRAFT_SCHEMA,
  TodayDraftAnswer,
  todayDraftPrompt,
  unansweredOf,
} from '../../src/addons/outreach/today';

const knows: DraftKnows = {
  brief: 'Business: Lane Roofing.\nService area: Austin and Round Rock',
  items: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'faq',
      title: 'Do you give free estimates?',
      body: 'Yes, within 48 hours of your call.',
    },
  ],
  allowPrices: false,
  avoid: ['cheap'],
};

const base = {
  business: 'Lane Roofing',
  name: 'Sam Carter',
  facts: [],
  recent: [{ fromMe: false, text: 'Do you come out to Dallas?', at: '2026-10-29T15:00:00.000Z' }],
  playbook: null,
} as const;

describe('what a draft is told the business knows', () => {
  it('gives the profile, the knowledge and how to use them to every kind that speaks for the business', () => {
    for (const kind of ['opener', 'reply', 'follow_up', 'comment', 'group_reply'] as const) {
      const prompt = todayDraftPrompt({
        ...base,
        kind,
        knows,
        post:
          kind === 'comment' || kind === 'group_reply' ? { text: 'Anyone?', group: null } : null,
      });
      expect(prompt).toContain('<business_profile>');
      expect(prompt).toContain('Service area: Austin and Round Rock');
      expect(prompt).toContain('Q: Do you give free estimates?');
      expect(prompt).toContain('never guess or make up a detail');
      expect(prompt).toContain('Never give a price from <business_profile> or <knowledge>.');
      expect(prompt).toContain('Never use these words either: cheap');
    }
    // A price may be given when the profile allows it, as written, only when they ask.
    expect(
      todayDraftPrompt({ ...base, kind: 'reply', knows: { ...knows, allowPrices: true } }),
    ).toContain('may be given only when they ask for it, exactly as written');
  });

  it('tells a birthday, a new job or a demo’s reminder nothing of it, and nothing when it isn’t given', () => {
    for (const kind of ['birthday', 'new_job', 'demo_reminder', 'rebook'] as const)
      expect(todayDraftPrompt({ ...base, kind, knows })).not.toContain('<business_profile>');
    expect(todayDraftPrompt({ ...base, kind: 'reply' })).not.toContain('<business_profile>');
    // When it couldn't be read, the AI is told so and still says nothing it wasn't given.
    const missing = todayDraftPrompt({ ...base, kind: 'reply', knows: null });
    expect(missing).toContain('(not available)');
    expect(missing).toContain('never guess or make up a detail');
  });

  it('asks a reply alone what nothing answers', () => {
    expect(todayDraftPrompt({ ...base, kind: 'reply', knows })).toContain(
      'Knowledge has no answer to',
    );
    expect(todayDraftPrompt({ ...base, kind: 'follow_up', knows })).not.toContain(
      'Knowledge has no answer to',
    );
    expect(TODAY_DRAFT_SCHEMA.required).toContain('unanswered');
  });

  it('quotes what the business wrote as data', () => {
    const blocks = knowsBlocks({ ...knows, brief: 'Business: <b>Lane</b> & Sons' }).join('\n');
    expect(blocks).toContain('Business: &lt;b&gt;Lane&lt;/b&gt; &amp; Sons');
    expect(knowsBlocks({ ...knows, brief: null, items: [] }).join('\n')).toContain(
      'Nothing written yet.',
    );
  });

  it('goes with a partner’s messages and the helpful posts too', () => {
    const partner = partnerDraftPrompt({
      ...base,
      kind: 'partner_reply',
      helps: null,
      partner: { kind: 'business', audience: null, why: [] },
      knows,
    });
    expect(partner).toContain('Q: Do you give free estimates?');
    const post = helpfulPrompt({
      business: 'Lane Roofing',
      playbook: null,
      group: null,
      asked: [],
      knows,
    });
    expect(post).toContain('Service area: Austin and Round Rock');
    expect(
      helpfulPrompt({ business: 'Lane Roofing', playbook: null, group: null, asked: [] }),
    ).not.toContain('<business_profile>');
  });
});

describe('a reply nothing answers', () => {
  it('keeps what they asked as one short line, and nothing when all of it is answered', () => {
    expect(unansweredLine('  “whether you come out\nto Dallas.”  ')).toBe(
      'whether you come out to Dallas',
    );
    expect(unansweredLine('')).toBeNull();
    expect(unansweredLine('None')).toBeNull();
    const long = unansweredLine('the price of '.repeat(40));
    expect(long!.length).toBeLessThanOrEqual(UNANSWERED_MOST);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('is kept for a reply to something they wrote, never another draft', () => {
    const answer = TodayDraftAnswer.parse({ drafts: ['Let me check.'], unanswered: 'Dallas' });
    expect(unansweredOf('reply', answer, base.recent)).toBe('Dallas');
    expect(unansweredOf('follow_up', answer, base.recent)).toBeNull();
    expect(
      unansweredOf('reply', answer, [{ fromMe: true, text: 'Hi', at: '2026-10-29T15:00:00.000Z' }]),
    ).toBeNull();
    // An answer from before it was asked says nothing.
    expect(TodayDraftAnswer.parse({ drafts: [] }).unanswered).toBe('');
  });

  it('says why it waits, and the extension hands what it was on with the reply', () => {
    expect(KNOWS_WORDS.needsYou('whether you come out to Dallas')).toBe(
      'Knowledge has no answer to whether you come out to Dallas',
    );
    const queued = SendQueueInput.parse({
      workspaceId: '00000000-0000-4000-8000-000000000002',
      profileId: '00000000-0000-4000-8000-000000000003',
      kind: 'reply',
      text: 'Good question. Let me check and get back to you.',
      unanswered: 'whether you come out to Dallas',
    });
    expect(queued.unanswered).toBe('whether you come out to Dallas');
    // An extension before 0.111.0 sends none.
    expect(
      SendQueueInput.parse({
        workspaceId: '00000000-0000-4000-8000-000000000002',
        profileId: '00000000-0000-4000-8000-000000000003',
        kind: 'reply',
        text: 'Thanks!',
      }).unanswered,
    ).toBeNull();
  });
});
