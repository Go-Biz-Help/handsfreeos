/**
 * The week's helpful post on Alignable and Instagram (docs/outreach.md, decision 109): Alignable's put up from the
 * person's home page once they OK'd it, only in a box for a post and only while it's empty, with that box's own Post;
 * Check Alignable's look for it; and the once-a-day ask for the week's post on both networks, which says so when the
 * week's is done.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ALIGNABLE_DAILY } from '../src/auto/alignable';
import { INSTAGRAM_DAILY } from '../src/auto/instagram';
import { ALIGNABLE_POST_NONE, HOME, postOnAlignable } from '../src/jobs/alignable/helpful';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { askWeeklyPost } from '../src/jobs/weekly-post';
import { KITS } from '../src/networks';
import { postLook, writeAlignablePost } from '../src/networks/alignable/compose';
import { ALIGNABLE } from '../src/networks/alignable/site';

vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const AL = 'https://www.alignable.com';

const page = (body: string, url = `${AL}/biz`) =>
  new JSDOM(`<!doctype html><html><body><main>${body}</main></body></html>`, { url }).window
    .document;

/**
 * Their home page: Start a post, which opens a box over the page to write in with its own Post; a Post that goes takes
 * the box away and puts the post at the top of the page. Each post that went is kept in `posted`.
 */
function home(options: { written?: string } = {}) {
  const doc = page(`
    <button id="start">Start a post</button>
    <section id="feed"></section>`);
  const posted: string[] = [];
  doc.querySelector('#start')!.addEventListener('click', () => {
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    box.innerHTML = `<textarea placeholder="What would you like to share?"></textarea><button>Post</button>`;
    const writing = box.querySelector('textarea')!;
    if (options.written) writing.value = options.written;
    box.querySelector('button')!.addEventListener('click', () => {
      posted.push(writing.value);
      box.remove();
      doc.querySelector('#feed')!.innerHTML = `
        <div><a href="/denver-co/pine-street-bakery?user=1"><span>Pat Owner</span></a>
          <p>${writing.value}</p><div><a href="/biz/discussions/501">Comment</a></div></div>`;
    });
    doc.body.append(box);
  });
  return { doc, posted };
}

describe('the week’s helpful post on Alignable (decision 109)', () => {
  it('opens the box with Start a post, writes the post in it and presses its own Post', async () => {
    const { doc, posted } = home();
    const text = 'One habit that won me more jobs this year: I follow up on every quote.';
    expect(await writeAlignablePost(doc, doc.location.href, text)).toMatchObject({
      result: 'done',
    });
    expect(posted).toEqual([text]);
  }, 30_000);

  it('writes in a box for a post already open in the page, with its own Post', async () => {
    const doc = page(
      `<form id="share"><textarea placeholder="Share an update"></textarea><button type="button">Post</button></form>`,
    );
    const posted: string[] = [];
    doc.querySelector('#share button')!.addEventListener('click', () => {
      const box = doc.querySelector<HTMLTextAreaElement>('#share textarea')!;
      posted.push(box.value);
      box.value = '';
    });
    expect(await writeAlignablePost(doc, doc.location.href, 'A tip.')).toEqual({
      result: 'done',
      url: null,
    });
    expect(posted).toEqual(['A tip.']);
  }, 30_000);

  it('leaves what the person wrote there, and never writes in a box to comment in', async () => {
    const written = home({ written: 'My own words' });
    expect(await writeAlignablePost(written.doc, written.doc.location.href, 'A tip.')).toEqual({
      result: 'not_sent',
      url: null,
    });
    expect(written.posted).toEqual([]);
    const onlyComment = page(
      '<form><textarea placeholder="Write a comment"></textarea><button type="button">Post</button></form>',
    );
    expect(await writeAlignablePost(onlyComment, onlyComment.location.href, 'A tip.')).toEqual({
      result: 'none',
      url: null,
    });
    expect(onlyComment.querySelector('textarea')!.value).toBe('');
  }, 30_000);

  it('is looked for by Check Alignable on the home page, never written in', () => {
    const { doc, posted } = home();
    expect(postLook(doc, ALIGNABLE)).toMatchObject({ step: 'post', works: true });
    expect(posted).toEqual([]);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
    expect(postLook(page('<button>Connect</button>'), ALIGNABLE)).toMatchObject({
      works: false,
      missing: ['no box to start a post, and nothing that opens one, on the page'],
    });
  });

  it('puts up the one OK’d from its ask, and notes it up, or why it couldn’t', async () => {
    const run = async (make: () => Document) => {
      const kit = KITS.alignable;
      let doc: Document | null = null;
      const opened: string[] = [];
      const tab = {
        async open(url: string) {
          opened.push(url);
          doc = make();
          return 1;
        },
        async close() {},
        async ask(message: { readonly type: string }) {
          const at = doc!.location.href;
          if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc!, at) };
          vi.stubGlobal('location', new URL(at));
          vi.stubGlobal('document', doc);
          try {
            return (
              (await kit.work!(message)) ?? { ok: false, error: `Not expected: ${message.type}` }
            );
          } finally {
            vi.unstubAllGlobals();
          }
        },
      } as unknown as JobTab;
      const sent: { type: string; input: unknown }[] = [];
      const job: Job = {
        tab,
        hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
          sent.push({ type: ask.type, input: ask.input });
          return {
            ok: true,
            value:
              ask.type === 'hfos-helpful-next'
                ? {
                    post: { helpfulId: 'h1', groupName: null, groupUrl: null, text: 'A tip.' },
                    read: [],
                  }
                : {},
          };
        }) as unknown as Hfos,
        businessId: 'b',
        stopped: () => false,
        progress: () => undefined,
        warn: async () => undefined,
      };
      return { end: await postOnAlignable(job, 'h1'), sent, opened };
    };
    let posted: string[] = [];
    const up = await run(() => {
      const made = home();
      posted = made.posted;
      return made.doc;
    });
    expect(up.opened).toEqual([HOME]);
    expect(up.end).toMatchObject({ line: 'Put your helpful post up on Alignable.', posted: true });
    expect(posted).toEqual(['A tip.']);
    expect(up.sent[0]).toEqual({
      type: 'hfos-helpful-next',
      input: { workspaceId: 'b', platform: 'alignable', helpfulId: 'h1' },
    });
    expect(up.sent[1]).toMatchObject({
      type: 'hfos-helpful-posted',
      input: { helpfulId: 'h1', posted: true },
    });
    const none = await run(() => page('<button>Connect</button>'));
    expect(none.end).toMatchObject({ failed: true });
    expect(none.sent[1]).toMatchObject({
      type: 'hfos-helpful-posted',
      input: { helpfulId: 'h1', posted: false, why: ALIGNABLE_POST_NONE },
    });
  }, 30_000);
});

describe('the week’s helpful post asked for once a day (decision 109)', () => {
  const jobAnswering = (answer: unknown) => {
    const sent: unknown[] = [];
    const job = {
      hfos: (async (ask: { readonly input?: unknown }) => {
        sent.push(ask.input);
        return answer;
      }) as unknown as Hfos,
      businessId: 'b',
      progress: () => undefined,
    } as unknown as Job;
    return { job, sent };
  };

  it('asks after who engaged on both networks, and says when the week’s is done', async () => {
    expect(INSTAGRAM_DAILY.indexOf('weekly_post')).toBe(INSTAGRAM_DAILY.indexOf('helpful') + 1);
    expect(ALIGNABLE_DAILY.indexOf('weekly_post')).toBe(ALIGNABLE_DAILY.indexOf('helpful') + 1);
    const fresh = jobAnswering({
      ok: true,
      value: { helpfulId: 'h', groupName: null, fresh: true },
    });
    expect(await askWeeklyPost(fresh.job, 'instagram')).toEqual({
      line: 'The AI is writing this week’s helpful post for Instagram. It’s on Today for you.',
      warned: false,
    });
    expect(fresh.sent).toEqual([{ workspaceId: 'b', platform: 'instagram' }]);
    const again = jobAnswering({
      ok: true,
      value: { helpfulId: 'h', groupName: null, fresh: false },
    });
    expect((await askWeeklyPost(again.job, 'alignable')).line).toBe(
      'This week’s helpful post for Alignable is asked for already: it’s on Today.',
    );
    const done = jobAnswering({
      ok: false,
      problem: {
        message: 'This week’s helpful post on Alignable is done. The next one comes in 3 days.',
      },
    });
    expect((await askWeeklyPost(done.job, 'alignable')).line).toBe(
      'This week’s helpful post on Alignable is done. The next one comes in 3 days.',
    );
  });
});
