/**
 * A job's note of what it saw (src/jobs/report.ts, decision 74): the network's own section names from the outline,
 * never a masked heading; what the readers found as counts and yes or no, never words, within the most core keeps of a
 * report; and for the person's own profile, what wasn't read, with the outline kept when what nearly everyone has is
 * missing.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { PROBLEM_FOUND_MOST, ProblemFound } from '@hfos/core/problem-report';
import { ownProfileNote, pageFound, reportFound, sectionsIn } from '../src/jobs/report';
import type { PageRead } from '../src/networks/kit';
import { ALIGNABLE } from '../src/networks/alignable/site';
import { readLooking } from '../src/networks/looking/read';

describe('a note of what a job saw', () => {
  it('names the sections from the outline’s headings, in either layout, and never a masked one', () => {
    const outline = [
      'HandsFreeOS Social 0.48.0 · page outline',
      'Page: own-profile /in/{1}/',
      'body',
      '  h1 "[2 words]"',
      '  h2 "About"',
      '  h2 data-testid="toasts-title" "[2 words]"',
      '  h2',
      '    span aria-hidden="true" "Experience"',
      '    span "Experience"',
      '  h2 "About"',
      '  h3',
      '    span "[3 words]"',
    ].join('\n');
    expect(sectionsIn(outline)).toEqual(['About', 'Experience']);
  });

  it('counts each list the readers found, and says which parts of a profile were there, never what they said', () => {
    const read = {
      platform: 'linkedin',
      kind: 'profile',
      url: 'https://www.linkedin.com/in/dana-reyes-4b2a1c/',
      readAt: '2026-10-16T12:00:00Z',
      profile: { name: 'Dana Reyes', headline: 'Owner at Reyes Roofing', about: null, role: null },
      posts: [{}, {}],
      warnings: [],
      notes: ['Found no roles'],
    } as unknown as PageRead;
    const found = pageFound(read);
    expect(found).toEqual({
      posts: 2,
      warnings: 0,
      notes: 1,
      profile: true,
      profileName: true,
      profileHeadline: true,
      profileAbout: false,
      profileRole: false,
    });
    expect(JSON.stringify(found)).not.toMatch(/Dana|Reyes|Owner/);
  });

  it('says what of their own profile wasn’t read, and keeps the outline when Experience or the headline is missing', () => {
    const read = {
      platform: 'linkedin' as const,
      bio: 'I help roofers',
      about: 'About me',
      intro: [],
      featured: [],
      posts: ['A post'],
      picture: 'A profile photo LinkedIn didn’t describe',
      cover: null,
    };
    expect(ownProfileNote(read)).toEqual({
      found: {
        name: false,
        bio: true,
        about: true,
        roles: 0,
        featured: 0,
        posts: 1,
        photo: true,
        banner: false,
      },
      note: 'Not read: Experience, Featured.',
      outline: true,
    });
    expect(ownProfileNote({ ...read, intro: ['Founder at Gee Consulting'] })).toMatchObject({
      note: 'Not read: Featured.',
      outline: false,
    });
    // Each network's parts in its own words: Alignable's About Us and services, with its pitch and posts not read yet.
    expect(
      ownProfileNote({ ...read, platform: 'alignable', bio: null, about: null, posts: [] }).note,
    ).toBe('Not read: About Us, the ideal customer, the services.');
    expect(ownProfileNote({ ...read, platform: 'instagram', about: null }).note).toBe(
      'Not read: a link, highlights.',
    );
  });
});

/**
 * An Alignable business's page you're connected with (its own Remove Connection, its newer Message), with a post of
 * theirs and an answer under it, as the owner's report of 26 Oct 2026 drew one: its readers find more than core keeps
 * of a report.
 */
const businessWithPosts = () =>
  new JSDOM(
    `<!doctype html><html><body><main><section>
      <div><div><img alt="cover" />
        <div><div><h1 title="Jo Marsh">Jo Marsh</h1><h2 title="Marsh Hardware">Marsh Hardware</h2></div>
          <div><a href="/salem-or">Salem, OR</a></div></div>
        <div><a href="/biz/messages/new?recipient_ids=7001&to_user=7001"><svg></svg>Message</a>
          <a href="/biz/recommendations/new?id=6060&request_source=profile"><svg></svg></a></div></div>
      <div><a href="/forward_referral_card/6060">Refer</a>
        <a href="/biz/connections/6060"><svg></svg>Remove Connection</a></div>
      <div><div><div>About Us</div></div><div><p>Tools and paint since 1990.</p></div></div>
      <div><h3>Posts</h3>
        <div><div><a href="/salem-or/marsh-hardware?user=3"><span>Jo Marsh</span><span>at</span><span>Marsh Hardware</span></a>
            <div><span>2d</span></div></div>
          <p>Spring sale this weekend.</p>
          <div><a href="/biz/likes?resource=8"><span>4</span><span>Like</span></a><a href="/biz/discussions/77">Comment</a></div>
          <div data-testid="discussion-comment"><div><a href="/salem-or/park-florist?user=4">Lee Park</a><span>1d</span></div>
            <div data-testid="discussion-comment-body"><p>See you there.</p></div></div></div></div>
    </section></main></body></html>`,
    { url: 'https://www.alignable.com/salem-or/marsh-hardware' },
  ).window.document;

describe('a report of a page with more found than core keeps', () => {
  const doc = businessWithPosts();
  const read = readLooking(doc, doc.location.href, ALIGNABLE);
  const page = pageFound(read);
  /** The page's own read, and the readers' warnings and notes: what a report keeps whatever else it lets go. */
  const own = Object.fromEntries(
    Object.entries(page).filter(([key]) =>
      /^(business([A-Z].*)?|chat|answerBox|codeBox|warnings|notes)$/.test(key),
    ),
  );
  const empties = [
    'places',
    'edits',
    'businesses',
    'engaged',
    'requests',
    'chats',
    'groups',
    'members',
  ];

  it('is more than a report keeps, as the readers found it', () => {
    expect(Object.keys(page).length).toBeGreaterThan(PROBLEM_FOUND_MOST);
    expect(page).toMatchObject({ threads: 1, answers: 1, businessConnected: true });
    expect(ProblemFound.safeParse({ ...page, sections: ['About Us'] }).success).toBe(false);
  });

  it('keeps within it by folding the lists with none into one, keeping the page’s own read and the job’s facts whole', () => {
    const found = reportFound(read, ['About Us'], { works: false });
    expect(ProblemFound.safeParse(found).success).toBe(true);
    expect(Object.keys(found)).toHaveLength(PROBLEM_FOUND_MOST);
    expect(own).toMatchObject({ businessConnected: true, warnings: 0, notes: 1 });
    expect(found).toMatchObject({
      ...own,
      sections: ['About Us'],
      works: false,
      emptyLists: empties,
      // Nothing else had to go: each list's parts are still counted.
      threads: 1,
      threadsAuthor: 1,
      threadsConnect: 0,
      answers: 1,
      answersReply: 0,
    });
    for (const list of empties) expect(found).not.toHaveProperty(list);
    expect(JSON.stringify(found)).not.toMatch(/Jo|Marsh|Lee|Park|Spring|Tools|Salem/);
  });

  it('folds a list’s parts next, from the read’s last list back, into those some of its rows lacked, the same each time', () => {
    const job = {
      works: false,
      tried: true,
      pressed: false,
      waited: 0,
      boxes: 1,
      seen: ['Remove Connection'],
    };
    const found = reportFound(read, ['About Us'], job);
    expect(ProblemFound.safeParse(found).success).toBe(true);
    expect(Object.keys(found).length).toBeLessThanOrEqual(PROBLEM_FOUND_MOST);
    // The answers' parts first, then the posts'.
    expect(found).toMatchObject({
      ...own,
      ...job,
      emptyLists: empties,
      answers: 1,
      answersLacking: ['connect', 'reply'],
      threads: 1,
      threadsLacking: ['connect'],
    });
    expect(Object.keys(found).filter((key) => key.startsWith('answers'))).toEqual([
      'answers',
      'answersLacking',
    ]);
    expect(Object.keys(found).filter((key) => key.startsWith('threads'))).toEqual([
      'threads',
      'threadsLacking',
    ]);
    expect(reportFound(read, ['About Us'], job)).toEqual(found);
  });

  it('lets the lists go, the read’s last first, before anything of the page’s own, the sections or the job’s', () => {
    const found = reportFound(read, ['About Us'], { works: false }, 25);
    expect(Object.keys(found)).toHaveLength(25);
    expect(found).toMatchObject({ ...own, sections: ['About Us'], works: false });
    expect(Object.keys(found).filter((key) => !(key in own))).toEqual([
      'people',
      'emptyLists',
      'sections',
      'works',
    ]);
  });

  it('leaves a report within the most as it was, the job’s facts over the page’s of the same name', () => {
    const doc = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
      url: 'https://www.alignable.com/biz/my_network',
    }).window.document;
    const small = readLooking(doc, doc.location.href, ALIGNABLE);
    expect(reportFound(small, [], { notes: 3 })).toEqual({ ...pageFound(small), notes: 3 });
  });
});
