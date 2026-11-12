/**
 * AI Social Media Content Creator's variety on the calendar (docs/socialcontent.md, "Variety"; decisions 34 to 39): the
 * weekly mix of kinds, the lists taking turns for each post's topic, the ideas planned before they're written, what
 * each open day is written from, how each is shown and its pictures laid out, and what the AI is told. No database.
 */
import { describe, expect, it } from 'vitest';
import type { MainOfferLists } from '../../src/main-offer/lists';
import {
  checkedIdeas,
  ideasPrompt,
  IdeasAnswer,
} from '../../src/addons/socialcontent/notes-ai';
import {
  checkedDesign,
  checkedPost,
  DESIGN_SCHEMA,
  designChoices,
  designOf,
  designPrompt,
  lookForAi,
  paletteFor,
  WRITE_SYSTEM,
  writePrompt,
  type DesignAnswer,
  type WriteAnswer,
} from '../../src/addons/socialcontent/posts-ai';
import { contrastRatio } from '../../src/chat/origins';
import {
  checkedFacts,
  FactsAnswer,
  factsPrompt,
  RESEARCH,
  researchPrompt,
} from '../../src/addons/socialcontent/research-ai';
import {
  ANGLES,
  examplesFor,
  MIX,
  nextAngles,
  nextLook,
  type PostBefore,
  pickTopic,
  planIdeas,
  planWrites,
  wordsOf,
  type CreatorPost,
  type IdeaToPlan,
  type Topic,
} from '../../src/addons/socialcontent/variety';

const LISTS: MainOfferLists = {
  topics: ['Reply fast', 'Follow up', 'Reviews'],
  questions: ['Will it sound like a robot? No.'],
  myths: ['Myth: AI is cold. Truth: it texts like a teammate.'],
  problems: ['Leads go cold', 'No time to call back'],
  beforeAfter: ['Before: missed calls. After: every lead answered.'],
  story: ['Started in IT in 2008'],
  different: ['40 automations built in'],
  benefits: ['Missed call text back, so no lead waits'],
  voice: ['Plain and friendly'],
};

describe('the weekly mix', () => {
  it('from nothing, follows 4 tips, 2 problems, 2 stories and 2 offers in every 10, never one kind twice in a row', () => {
    const kinds = nextAngles([], 50);
    expect(kinds.slice(0, 10)).toEqual([
      'tip',
      'problem',
      'story',
      'offer',
      'tip',
      'problem',
      'tip',
      'story',
      'offer',
      'tip',
    ]);
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
    for (const a of ANGLES) expect(kinds.filter((k) => k === a).length).toBe(MIX[a] * 5);
  });

  it('catches up after a run of one kind, and ignores posts with no kind', () => {
    const kinds = nextAngles(['offer', null, 'offer', 'offer', 'offer'], 6);
    expect(kinds[0]).toBe('tip');
    expect(kinds.slice(0, 5)).not.toContain('offer');
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
  });
});

describe('a topic for each post', () => {
  it('takes turns through the kind’s lists, the one used longest ago first, then its line used longest ago, skipping lists with no fresh line', () => {
    expect(pickTopic('tip', LISTS, [])).toEqual({ list: 'topics', line: 'Reply fast' });
    const used: Topic[] = [
      { list: 'topics', line: 'Reply fast' },
      { list: 'questions', line: 'Will it sound like a robot? No.' },
    ];
    expect(pickTopic('tip', LISTS, used)?.list).toBe('myths');
    expect(
      pickTopic('tip', LISTS, [{ list: 'myths', line: LISTS.myths![0]! }, ...used]),
    ).toEqual({ list: 'topics', line: 'Follow up' });
  });

  it('matches lines whatever their case, and is null when the kind’s lists are empty', () => {
    expect(
      pickTopic('problem', { problems: ['Leads go cold', 'No time'] }, [
        { list: 'problems', line: 'leads go cold ' },
      ]),
    ).toEqual({ list: 'problems', line: 'No time' });
    expect(pickTopic('offer', { topics: ['x'], different: ['  '] }, [])).toBeNull();
  });

  it('plans ideas after the ones waiting, so the mix and the lists carry on', () => {
    const plan = planIdeas(4, [{ angle: 'tip', topic: { list: 'topics', line: 'Reply fast' } }], LISTS);
    expect(plan.map((p) => p.angle)).toEqual(['problem', 'story', 'offer', 'tip']);
    expect(plan[0]!.topic).toEqual({ list: 'problems', line: 'Leads go cold' });
    expect(plan[3]!.topic).toEqual({ list: 'questions', line: 'Will it sound like a robot? No.' });
  });
});

describe('what each open day is written from', () => {
  const idea = (over: Partial<IdeaToPlan>): IdeaToPlan => ({
    id: 'i',
    network: null,
    angle: null,
    topic: null,
    saved: false,
    ...over,
  });

  it('a saved idea for the network first, then an idea of the kind the mix needs, then a line from the lists', () => {
    const plan = planWrites({
      slots: [{ network: 'instagram' }, { network: 'facebook' }, { network: 'instagram' }],
      before: [{ angle: 'tip', topic: null }],
      ideas: [
        idea({ id: 'story-ig', angle: 'story', network: 'instagram' }),
        idea({ id: 'problem-fb', angle: 'problem', network: 'facebook' }),
        idea({ id: 'saved-ig', angle: 'offer', network: 'instagram', saved: true }),
      ],
      lists: LISTS,
    });
    expect(plan.map((p) => [p.angle, p.ideaId])).toEqual([
      ['offer', 'saved-ig'],
      ['problem', 'problem-fb'],
      ['story', 'story-ig'],
    ]);
  });

  it('writes from the lists when no idea fits, then from an older idea with no kind, then from the kind alone', () => {
    const fromLists = planWrites({
      slots: [{ network: 'linkedin' }],
      before: [],
      ideas: [idea({ id: 'tip-ig', angle: 'tip', network: 'instagram' })],
      lists: LISTS,
    });
    expect(fromLists[0]).toMatchObject({
      angle: 'tip',
      ideaId: null,
      topic: { list: 'topics', line: 'Reply fast' },
    });
    const older = planWrites({
      slots: [{ network: 'instagram' }, { network: 'instagram' }],
      before: [],
      ideas: [idea({ id: 'old' })],
      lists: {},
    });
    expect(older.map((p) => [p.angle, p.ideaId, p.topic])).toEqual([
      ['tip', 'old', null],
      ['problem', null, null],
    ]);
  });

  it('leaves a topic a waiting idea is about to that idea', () => {
    const plan = planWrites({
      slots: [{ network: 'instagram' }],
      before: [{ angle: null, topic: { list: 'topics', line: 'Reply fast' } }],
      ideas: [],
      lists: { topics: LISTS.topics! },
    });
    expect(plan[0]!.topic).toEqual({ list: 'topics', line: 'Follow up' });
  });
});

describe('what the AI is told', () => {
  const answer = (over: Partial<WriteAnswer> = {}): WriteAnswer => ({
    title: 'Reply in a minute',
    format: 'photo',
    hook: 'A lead waits 5 minutes. Then it’s gone.',
    words: 'Reply fast.',
    hashtags: [],
    slides: [],
    picture: null,
    pictureWay: 'design',
    photoPrompt: null,
    angle: 'story',
    ...over,
  });

  it('writes the kind and topic asked for, and never repeats the last posts’ hooks', () => {
    const prompt = writePrompt({
      business: '<business_profile>CRM</business_profile>',
      network: 'instagram',
      playbook: null,
      idea: null,
      ask: null,
      before: null,
      angle: 'tip',
      topic: { list: 'topics', line: 'Reply fast' },
      recent: [{ title: 'Missed calls', hook: 'The difference between a missed call text and…' }],
    });
    expect(prompt).toContain('<topic>\nFrom “Topics you want to be known for”: Reply fast');
    expect(prompt).toContain('Write a tip post about the topic: Teach one useful tip');
    expect(prompt).toContain(
      '<recent_posts>\n- Missed calls: The difference between a missed call text and…\n</recent_posts>',
    );
    expect(WRITE_SYSTEM).toContain('<recent_posts>');
    expect(WRITE_SYSTEM).toContain('<topic>');
  });

  it('keeps the kind asked for, else the kind the AI says it wrote', () => {
    expect(checkedPost(answer(), 'instagram', 'tip')!.angle).toBe('tip');
    expect(checkedPost(answer(), 'instagram')!.angle).toBe('story');
    expect(checkedPost(answer({ angle: 'video' }), 'instagram')!.angle).toBeNull();
  });

  it('asks for one idea for each slot, and keeps each idea’s kind and topic from its slot', () => {
    const slots = planIdeas(2, [], LISTS);
    const { prompt, refs } = ideasPrompt({
      business: 'CRM',
      summary: null,
      sections: [],
      standouts: [],
      networks: ['instagram'],
      already: [],
      slots,
      recent: [{ title: 'Missed calls', hook: null }],
    });
    expect(prompt).toContain('<slots>\n1. Tip: Teach one useful tip');
    expect(prompt).toContain('Topic, from “Topics you want to be known for”: Reply fast');
    expect(prompt).toContain('2. Customer problem:');
    expect(prompt).toContain('<recent_posts>\n- Missed calls\n</recent_posts>');
    const base = {
      hook: null,
      format: null,
      network: 'instagram',
      outline: null,
      why: null,
      basedOn: [],
    };
    const ideas = checkedIdeas(
      IdeasAnswer.parse({
        ideas: [
          { ...base, slot: 2, title: 'Leads go cold overnight' },
          { ...base, slot: 2, title: 'A second for slot 2' },
          { ...base, slot: 9, title: 'No such slot' },
          { ...base, slot: 1, title: 'Reply in 60 seconds' },
        ],
      }),
      refs,
      [],
      ['instagram'],
      slots,
    );
    expect(ideas.map((i) => [i.title, i.angle, i.topic?.line])).toEqual([
      ['Leads go cold overnight', 'problem', 'Leads go cold'],
      ['Reply in 60 seconds', 'tip', 'Reply fast'],
    ]);
  });
});

describe('news and facts found online', () => {
  const fact = (id: string): IdeaToPlan => ({
    id,
    network: null,
    angle: 'tip',
    topic: null,
    saved: false,
    fact: true,
  });

  it('every other tip is a fact while one waits; the tips between come from ideas or the lists', () => {
    const plan = planWrites({
      slots: Array.from({ length: 10 }, () => ({ network: 'instagram' })),
      before: [],
      ideas: [fact('f1'), fact('f2'), fact('f3')],
      lists: LISTS,
    });
    const tips = plan.filter((p) => p.angle === 'tip');
    expect(tips.map((t) => t.ideaId)).toEqual(['f1', null, 'f2', null]);
    expect(tips[1]!.topic).not.toBeNull();
  });

  it('carries on after a tip that was a fact', () => {
    const plan = planWrites({
      slots: [{ network: 'instagram' }],
      before: [
        { angle: 'offer', topic: null },
        { angle: 'tip', topic: null, fact: true },
        { angle: 'story', topic: null },
        { angle: 'problem', topic: null },
      ],
      ideas: [fact('f1')],
      lists: LISTS,
    });
    expect(plan[0]).toMatchObject({ angle: 'tip', ideaId: null });
  });

  it('keeps each fact with a page the search really found', () => {
    const pages = [{ url: 'https://example.org/a' }, { url: 'ftp://example.org/b' }];
    const facts = checkedFacts(
      FactsAnswer.parse({
        facts: [
          {
            title: 'Fast replies win — big',
            fact: 'Leads answered in 5 minutes buy more.',
            hook: 'Five minutes.',
            why: 'Speed sells.',
            page: 1,
            publisher: '',
          },
          { title: 'No page', fact: 'x', hook: null, why: null, page: 7, publisher: 'X' },
          { title: 'Not the web', fact: 'x', hook: null, why: null, page: 2, publisher: 'X' },
          { title: 'Old one', fact: 'x', hook: null, why: null, page: 1, publisher: 'X' },
        ],
      }),
      pages,
      ['old one'],
      5,
    );
    expect(facts).toEqual([
      {
        title: 'Fast replies win, big',
        hook: 'Five minutes.',
        format: null,
        network: null,
        outline: 'Leads answered in 5 minutes buy more.',
        why: 'Speed sells.',
        basedOn: [],
        angle: 'tip',
        topic: null,
        source: { url: 'https://example.org/a', name: 'example.org' },
      },
    ]);
  });

  it('asks for different facts from the ones before, and names a post’s source in plain words', () => {
    const prompt = researchPrompt({
      business: 'CRM',
      niches: ['home services'],
      earlier: ['Fast replies win'],
    });
    expect(prompt).toContain('<niches>\n- home services\n</niches>');
    expect(prompt).toContain('<earlier_facts>\n- Fast replies win\n</earlier_facts>');
    expect(prompt).toContain(`Use up to ${RESEARCH.searches} searches`);
    expect(factsPrompt({ notes: 'Fast [1]', pages: [{ url: 'https://a.org', title: 'A', age: null }] })).toContain(
      '[1] A (https://a.org)',
    );
    const write = writePrompt({
      business: 'CRM',
      network: 'facebook',
      playbook: null,
      idea: {
        title: 'Fast replies win',
        hook: null,
        format: null,
        outline: 'Leads answered in 5 minutes buy more.',
        why: null,
        source: 'Angi',
      },
      ask: null,
      before: null,
    });
    expect(write).toContain('Source: Angi');
    expect(WRITE_SYSTEM).toContain('say where it came from in plain words');
  });
});

describe('creators’ posts that match', () => {
  const post = (caption: string, over: Partial<CreatorPost> = {}): CreatorPost => ({
    caption,
    network: 'instagram',
    standout: false,
    times: null,
    why: null,
    ...over,
  });

  it('shows the posts sharing the most words with the topic, standouts and best ones first', () => {
    const posts = [
      post('Our new truck wraps are here!'),
      post('Missed calls cost contractors jobs every week', { times: 2 }),
      post('Why missed calls cost you jobs, and the fix', { standout: true, times: 6, why: 'A cost first.' }),
      post('Three ways to answer leads faster'),
    ];
    const shown = examplesFor('Missed calls cost jobs', posts);
    expect(shown.map((p) => p.caption)).toEqual([
      'Why missed calls cost you jobs, and the fix',
      'Missed calls cost contractors jobs every week',
    ]);
    expect(wordsOf('The difference between a missed call text and a voicemail')).toEqual(
      new Set(['difference', 'between', 'missed', 'call', 'text', 'voicemail']),
    );
  });

  it('with none close, shows the best standouts to learn hooks from', () => {
    const shown = examplesFor('Roof repair myths', [
      post('Truck wraps', { standout: true, times: 3 }),
      post('Lunch', { standout: false }),
      post('Our team', { standout: true, times: 8 }),
    ]);
    expect(shown.map((p) => p.caption)).toEqual(['Our team', 'Truck wraps']);
  });

  it('tells the writer to learn from them and never copy', () => {
    const prompt = writePrompt({
      business: 'CRM',
      network: 'instagram',
      playbook: null,
      idea: null,
      ask: null,
      before: null,
      examples: [post('Why missed calls cost you jobs', { standout: true, times: 6, why: 'A cost first.' })],
    });
    expect(prompt).toContain(
      '<creator_examples>\n1. Instagram, a standout, 6 times its creator’s usual:\nWhy missed calls cost you jobs\nWhy it worked: A cost first.\n</creator_examples>',
    );
    expect(WRITE_SYSTEM).toContain('never copy their words');
  });
});

describe('how each post is shown (decision 39)', () => {
  /** The looks of `n` posts one after another on one network, from nothing. */
  const run = (n: number, network: string, photos = true) => {
    const before: PostBefore[] = [];
    for (let k = 0; k < n; k++) {
      const look = nextLook(before, network, photos);
      before.unshift({ angle: null, topic: null, format: look.format, photo: look.photo });
    }
    return before.reverse();
  };

  it('takes turns between carousels and single pictures on Instagram, about 3 in 10 with a photo, never two in a row', () => {
    const looks = run(10, 'instagram');
    expect(looks.filter((l) => l.format === 'carousel')).toHaveLength(5);
    expect(looks.filter((l) => l.format === 'photo')).toHaveLength(5);
    expect(looks.some((l) => l.format === 'text')).toBe(false);
    expect(looks.filter((l) => l.photo)).toHaveLength(3);
    for (let k = 1; k < looks.length; k++)
      expect(looks[k]!.photo && looks[k - 1]!.photo).toBe(false);
  });

  it('puts words alone on Facebook or LinkedIn once in 10 posts', () => {
    const looks = run(20, 'facebook');
    expect(looks.filter((l) => l.format === 'text')).toHaveLength(2);
    expect(looks[0]!.format).toBe('text');
    expect(looks[10]!.format).toBe('text');
  });

  it('never has a photo when OpenAI’s image model isn’t set up, and catches up after a run of carousels', () => {
    expect(run(10, 'instagram', false).some((l) => l.photo)).toBe(false);
    const carousels: PostBefore[] = Array.from({ length: 4 }, () => ({
      angle: null,
      topic: null,
      format: 'carousel',
      photo: false,
    }));
    expect(nextLook(carousels, 'instagram', true)).toEqual({ format: 'photo', photo: true });
  });

  it('plans a look with each post, and tells the writer how to show it', () => {
    const planned = planWrites({
      slots: [{ network: 'instagram' }, { network: 'linkedin' }, { network: 'instagram' }],
      before: [],
      ideas: [],
      lists: LISTS,
      photos: true,
    });
    expect(planned.map((p) => p.look.format)).toEqual(['carousel', 'text', 'photo']);
    expect(lookForAi({ format: 'text', photo: false })).toMatch(/words alone/);
    expect(lookForAi({ format: 'carousel', photo: true })).toMatch(/photo under the first slide/);
    expect(lookForAi({ format: 'photo', photo: false })).toMatch(/designed/);
    const prompt = writePrompt({
      business: '<business_profile>x</business_profile>',
      network: 'instagram',
      playbook: null,
      idea: null,
      ask: null,
      before: null,
      look: { format: 'photo', photo: true },
    });
    expect(prompt).toMatch(/pictureWay "photo"/);
  });

  it('keeps the planned format, whatever the AI answered', () => {
    const answer: WriteAnswer = {
      title: 'T',
      format: 'carousel',
      hook: 'H',
      words: 'Words.',
      hashtags: [],
      slides: [
        { heading: 'A', body: 'a' },
        { heading: 'B', body: 'b' },
      ],
      picture: 'A van outside a house.',
      pictureWay: 'photo',
      photoPrompt: 'A van outside a house at dusk.',
      angle: 'tip',
    };
    const one = checkedPost(answer, 'instagram', null, { format: 'photo', photo: true })!;
    expect(one.format).toBe('photo');
    expect(one.slides).toEqual([]);
    expect(one.pictureWay).toBe('photo');
    const words = checkedPost(answer, 'facebook', null, { format: 'text', photo: false })!;
    expect([words.format, words.pictureWay]).toEqual(['text', 'own']);
  });
});

describe('pictures that don’t all look the same (decision 39)', () => {
  const page = (over: Partial<DesignAnswer['pages'][number]> = {}) => ({
    layout: 'bold',
    kicker: null,
    heading: 'Stop losing jobs to missed calls',
    body: 'Text back every caller.',
    items: [],
    mark: null,
    footer: 'Example Co',
    ...over,
  });
  const answer = (over: Partial<DesignAnswer> = {}): DesignAnswer => ({
    style: null,
    font: 'loud',
    background: '#141414',
    text: '#ffffff',
    accent: '#ff5a36',
    photo: false,
    pages: [page()],
    ...over,
  });

  it('gives colours that go with the business’s colour, every one a real colour', () => {
    const palette = paletteFor('#2d69d8');
    expect(palette[0]).toEqual({ name: 'its colour', hex: '#2d69d8' });
    expect(palette).toHaveLength(9);
    for (const c of palette) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
    const deep = palette.find((c) => c.name === 'deep')!.hex;
    const pale = palette.find((c) => c.name === 'pale')!.hex;
    expect(contrastRatio(deep, pale)).toBeGreaterThan(7);
    expect(paletteFor('nonsense')[0]!.hex).toBe('#2d69d8');
    // A grey brand still gets colours to pair with it.
    expect(paletteFor('#808080').find((c) => c.name === 'beside it')!.hex).not.toBe('#808080');
  });

  it('steers away from the last two first layouts and the last font, and offers shuffled others', () => {
    let k = 0;
    const rand = () => [0.1, 0.7, 0.3, 0.9, 0.5][k++ % 5]!;
    const c = designChoices(
      [
        { style: 'list', font: 'classic' },
        { style: 'bold', font: 'modern' },
        { style: 'note', font: null },
      ],
      false,
      rand,
    );
    expect(c.avoid).toEqual(['list', 'bold']);
    expect(c.tryFirst).toHaveLength(4);
    for (const s of c.tryFirst) expect(['list', 'bold', 'photo', 'framed']).not.toContain(s);
    expect(c.fonts).not.toContain('classic');
    const withPhoto = designChoices([{ style: 'photo', font: null }], true, rand);
    expect(withPhoto.tryFirst).toEqual(['framed']);
  });

  it('draws each page in a layout it can be drawn in', () => {
    const d = checkedDesign(
      answer({
        pages: [
          page({ layout: 'list', items: ['One'] }),
          page({ layout: 'number', mark: '' }),
          page({ layout: 'highlight', mark: 'not in the heading' }),
          page({ layout: 'beforeAfter', items: ['Before', 'After'] }),
          page({ layout: 'photo' }),
          page({ layout: 'wavy' }),
        ],
      }),
      '#2d69d8',
      6,
    )!;
    expect(d.pages.map((p) => p.layout)).toEqual([
      'clean',
      'bold',
      'bold',
      'beforeAfter',
      'bold',
      'bold',
    ]);
    expect(d.font).toBe('loud');
    expect(d.photo).toBe(false);
  });

  it('puts the photo under the first page only, and never starts the way the last pictures did', () => {
    const d = checkedDesign(
      answer({ pages: [page({ layout: 'quote' }), page({ layout: 'framed' })] }),
      '#2d69d8',
      2,
      { photo: true },
    )!;
    expect(d.pages.map((p) => p.layout)).toEqual(['photo', 'bold']);
    expect([d.style, d.photo]).toEqual(['photo', true]);
    const avoided = checkedDesign(answer({ pages: [page({ layout: 'clean' })] }), '#2d69d8', 1, {
      avoid: ['clean', 'split'],
    })!;
    expect(avoided.style).toBe('bold');
    const swapped = checkedDesign(answer(), '#2d69d8', 1, { photo: true, avoid: ['photo'] })!;
    expect(swapped.style).toBe('framed');
  });

  it('reads a design kept before the layouts the same way it looked, and a new one back unchanged', () => {
    const old = designOf({
      style: 'split',
      background: '#ffffff',
      text: '#111111',
      accent: '#2d69d8',
      pages: [{ kicker: null, heading: 'Hello', body: 'There', footer: null }],
    })!;
    expect(old.pages[0]!.layout).toBe('split');
    expect(old.font).toBe('modern');
    const d = checkedDesign(
      answer({ pages: [page({ layout: 'list', items: ['A', 'B', 'C'] })] }),
      '#2d69d8',
      1,
    )!;
    expect(designOf(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const photo = checkedDesign(answer(), '#2d69d8', 1, { photo: true })!;
    expect(designOf(JSON.parse(JSON.stringify(photo)))).toEqual(photo);
  });

  it('tells the design AI its colours, the photo, and the layouts to try and to skip', () => {
    const prompt = designPrompt({
      business: '<business_profile>x</business_profile>',
      businessName: 'Example Co',
      color: '#2d69d8',
      post: {
        network: 'instagram',
        format: 'photo',
        hook: 'Hook',
        words: 'Words',
        slides: [],
        picture: 'A van',
      },
      ask: null,
      photo: 'A van outside a house',
      choices: { avoid: ['bold'], tryFirst: ['framed', 'photo'], fonts: ['friendly'] },
    });
    expect(prompt).toContain('its colour #2d69d8');
    expect(prompt).toMatch(/photo under its words/);
    expect(prompt).toMatch(/"framed", "photo"/);
    expect(prompt).toMatch(/Never start with "bold"/);
    expect(prompt).toMatch(/"friendly" font/);
    const required = (
      DESIGN_SCHEMA['properties'] as { pages: { items: { required: string[] } } }
    ).pages.items.required;
    expect(required).toEqual(['layout', 'kicker', 'heading', 'body', 'items', 'mark', 'footer']);
  });
});
