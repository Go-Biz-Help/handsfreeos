/**
 * The looking kit's comment and Join (src/networks/looking/kit.ts; docs/outreach.md, decision 92): answered only for a
 * site that declares them (`auto.comment`, `auto.join`), a comment only when it says whose post it is and which, and a
 * site that asks no questions before a Join says there were none to answer. And `writeIn`, shared by the sites
 * (src/networks/looking/looks.ts), which puts the words in a box in place of what was there. On made-up pages and
 * people.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoAsk, JoinAsk } from '../src/messages';
import { ALIGNABLE } from '../src/networks/alignable/site';
import { INSTAGRAM } from '../src/networks/instagram/site';
import { lookingKit, ON_ITS_OWN_ASKS } from '../src/networks/looking/kit';
import { writeIn } from '../src/networks/looking/looks';
import type { CommentOn, LookingSite } from '../src/networks/looking/site';

const IG = 'https://www.instagram.com';
const AL = 'https://www.alignable.com';
const KIM = { id: null, username: 'kim_bakes', url: `${IG}/kim_bakes/` };
const POST = `${IG}/p/C0ffee12345/`;
const GROUP = `${AL}/groups/springfield-small-business`;

const page = (url: string) =>
  new JSDOM('<!doctype html><html><body><main></main></body></html>', { url }).window.document;

/** A site's own presses, less a comment and a Join: what a site declaring neither has. */
function bare(site: LookingSite): LookingSite {
  const own = site.auto!;
  return {
    ...site,
    auto: {
      theirPosts: own.theirPosts,
      like: own.like,
      connect: own.connect,
      message: own.message,
    },
  };
}

/** Works an ask on this site's kit, on a page at `url`, as its tab's script does. */
async function work(site: LookingSite, url: string, ask: AutoAsk | JoinAsk) {
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal('document', page(url));
  return lookingKit(site).work!(ask);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a comment on a good post', () => {
  const comment = {
    type: 'hfos-comment',
    text: 'Lovely sourdough!',
    profile: KIM,
    postUrl: POST,
  } as const;

  it('is one of the runner’s presses the kit answers', () => {
    for (const type of ['hfos-comment', 'hfos-join', 'hfos-join-answer'])
      expect(ON_ITS_OWN_ASKS.has(type)).toBe(true);
  });

  it('goes only on a site that declares it, told whose post it is and which', async () => {
    const asked: { href: string; text: string; on: CommentOn }[] = [];
    const site = bare(INSTAGRAM);
    const commenting: LookingSite = {
      ...site,
      auto: {
        ...site.auto!,
        comment: async (_doc, href, text, on) => {
          asked.push({ href, text, on });
          return 'done';
        },
      },
    };
    expect(await work(commenting, POST, comment)).toEqual({ ok: true, result: 'done' });
    expect(asked).toEqual([
      { href: POST, text: 'Lovely sourdough!', on: { profile: KIM, postUrl: POST } },
    ]);
  });

  it('is never written without whose post it is and which', async () => {
    const site = bare(INSTAGRAM);
    const commenting: LookingSite = {
      ...site,
      auto: { ...site.auto!, comment: async () => 'done' },
    };
    expect(await work(commenting, POST, { ...comment, postUrl: null })).toEqual({
      ok: false,
      error: 'The extension didn’t say whose post it is on Instagram.',
    });
    expect(await work(commenting, POST, { type: 'hfos-comment', text: 'Hi' })).toEqual({
      ok: false,
      error: 'The extension didn’t say whose post it is on Instagram.',
    });
  });

  it('is refused on a site that doesn’t declare it', async () => {
    expect(await work(bare(INSTAGRAM), POST, comment)).toEqual({
      ok: false,
      error: 'The extension doesn’t comment on Instagram on its own.',
    });
  });
});

describe('a group’s Join', () => {
  type AnswerJoin = NonNullable<LookingSite['auto']>['answerJoin'];
  const joining = (answerJoin?: AnswerJoin): LookingSite => {
    const site = bare(ALIGNABLE);
    return {
      ...site,
      auto: {
        ...site.auto!,
        join: async () => ({ result: 'asked' }),
        ...(answerJoin ? { answerJoin } : {}),
      },
    };
  };

  it('is pressed only on a site that declares it', async () => {
    expect(await work(joining(), GROUP, { type: 'hfos-join' })).toEqual({
      ok: true,
      step: { result: 'asked' },
    });
    expect(await work(bare(ALIGNABLE), GROUP, { type: 'hfos-join' })).toEqual({
      ok: false,
      error: 'The extension doesn’t join groups on Alignable.',
    });
    expect(
      await work(bare(ALIGNABLE), GROUP, { type: 'hfos-join-answer', answers: ['A bakery'] }),
    ).toEqual({ ok: false, error: 'The extension doesn’t join groups on Alignable.' });
  });

  it('answers its questions where the site asks them, and says there were none where it asks none', async () => {
    const answered: string[][] = [];
    const asking = joining(async (_doc, answers) => {
      answered.push([...answers]);
      return 'done';
    });
    expect(
      await work(asking, GROUP, { type: 'hfos-join-answer', answers: ['I run a bakery.'] }),
    ).toEqual({ ok: true, result: 'done' });
    expect(answered).toEqual([['I run a bakery.']]);
    expect(
      await work(joining(), GROUP, { type: 'hfos-join-answer', answers: ['I run a bakery.'] }),
    ).toEqual({ ok: true, result: 'none' });
  });
});

describe('writing in a box', () => {
  it('puts the words in place of what was there, and tells the page', () => {
    const doc = new JSDOM(
      '<!doctype html><html><body><textarea aria-label="Add a comment…">Old words</textarea></body></html>',
      { url: POST },
    ).window.document;
    const box = doc.querySelector('textarea')!;
    let told = 0;
    box.addEventListener('input', () => told++);
    writeIn(doc, box, 'Lovely sourdough!');
    expect(box.value).toBe('Lovely sourdough!');
    expect(told).toBeGreaterThan(0);
    writeIn(doc, box, '');
    expect(box.value).toBe('');
  });
});
