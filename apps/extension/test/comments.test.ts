/**
 * Comments on good posts through `sends` (src/auto/comments.ts; docs/outreach.md, decision 92), as Instagram's and
 * Alignable's runners draft and send them, with HandsFreeOS, the notes and the network's tab stood in for: drafted
 * from the post and queued with it; sent once OK'd only on the post's own page, told whose post it is, then noted as
 * the extension's own with what the post said and the comment; and one that couldn't go told to HandsFreeOS as not
 * sent, with why, so it hands it to the person. On made-up people and posts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayListItem } from '../src/hfos/messages';
import type { AutoAnswer, AutoAsk } from '../src/messages';

const world = vi.hoisted(() => ({
  asked: [] as { type: string; input?: unknown }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
  noted: [] as { note: unknown; platform: unknown }[],
  draft: ['Lovely crumb! What flour do you use?'] as string[],
  queued: 'waiting' as string,
  /** The status HandsFreeOS answers send.done with: 404 once the person skipped it meanwhile. */
  doneStatus: 200,
}));

vi.mock('../src/hfos/session', () => {
  class Refused extends Error {
    constructor(readonly problem: { readonly message: string; readonly status?: number | null }) {
      super(problem.message);
    }
  }
  return {
    Refused,
    answer: async (ask: { type: string; input?: unknown }) => {
      world.asked.push(ask);
      return { ok: true, value: { drafts: world.draft } };
    },
    api: () => ({
      POST: async (path: string, options: { body: Record<string, unknown> }) => {
        world.posted.push({ path, body: options.body });
        if (path.endsWith('outreach.send.queue'))
          return {
            data: { sendId: 's-1', state: world.queued },
            response: { ok: true, status: 200 },
          };
        const ok = world.doneStatus === 200;
        return { data: ok ? {} : undefined, response: { ok, status: world.doneStatus } };
      },
    }),
    call: async (
      request: Promise<{ data?: unknown; response: { ok: boolean; status: number } }>,
    ) => {
      const result = await request;
      if (result.response.ok) return result.data;
      throw new Refused({ message: 'Not found.', status: result.response.status });
    },
  };
});
vi.mock('../src/hfos/noting', () => ({
  takeNote: async (note: unknown, platform: unknown) => {
    world.noted.push({ note, platform });
  },
}));
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { commentDoing, draftComment, sendComment } = await import('../src/auto/comments');

const IG = 'https://www.instagram.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PROFILE_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const POST_ID = 'e0e0e0e0-0000-4000-8000-000000000001';
const POST = `${IG}/p/C0ffee12345/`;
const KIM = { id: null, username: 'kim_bakes', url: `${IG}/kim_bakes/` };

const item = (more: Partial<TodayListItem> = {}): TodayListItem =>
  ({
    kind: 'comment',
    name: 'Kim Baker',
    profileId: PROFILE_ID,
    profileUrl: KIM.url,
    chatId: null,
    threadKey: null,
    postId: POST_ID,
    postUrl: POST,
    posted: null,
    post: 'Fresh sourdough this morning',
    asking: false,
    why: [],
    summary: null,
    nextStep: null,
    playbookName: null,
    demoLink: null,
    videoLink: null,
    personId: null,
    demoBooked: false,
    send: null,
    recent: [],
    ...more,
  }) as TodayListItem;

const sending = (more: Partial<TodayListItem> = {}) =>
  item({
    send: {
      sendId: 'c0c0c0c0-0000-4000-8000-000000000001',
      state: 'approved',
      text: 'Lovely crumb! What flour do you use?',
      handedOver: false,
      needsYou: null,
    },
    ...more,
  });

/** Instagram's tab on the post, answering the comment as `wrote` says; and the runner's look at its page. */
function runner(wrote: AutoAnswer, pageSays: ({ stop: string } | { again: string } | null)[] = []) {
  const opened: string[] = [];
  const asks: AutoAsk[] = [];
  return {
    opened,
    asks,
    runner: {
      platform: 'instagram' as const,
      tab: {
        open: async (url: string) => {
          opened.push(url);
          return 1;
        },
        ask: async (message: AutoAsk) => {
          asks.push(message);
          return wrote;
        },
      },
      onPage: async () => pageSays.shift() ?? null,
    },
  };
}

const done = () => world.posted.filter((p) => p.path.endsWith('outreach.send.done'));

beforeEach(() => {
  world.asked.length = 0;
  world.posted.length = 0;
  world.noted.length = 0;
  world.draft = ['Lovely crumb! What flour do you use?'];
  world.queued = 'waiting';
  world.doneStatus = 200;
});

describe('a comment’s draft', () => {
  it('is written from the post and queued with it, waiting for an OK or going soon', async () => {
    expect(await draftComment(item(), BUSINESS)).toEqual({
      done: true,
      line: 'Wrote a comment on Kim Baker’s post: it waits for your OK',
    });
    expect(world.asked).toEqual([
      {
        type: 'hfos-draft',
        workspaceId: BUSINESS,
        input: { kind: 'comment', profileId: PROFILE_ID, postId: POST_ID },
      },
    ]);
    expect(world.posted).toEqual([
      {
        path: '/v1/commands/outreach.send.queue',
        body: {
          workspaceId: BUSINESS,
          profileId: PROFILE_ID,
          kind: 'comment',
          chatId: null,
          threadKey: null,
          text: 'Lovely crumb! What flour do you use?',
          opener: null,
          simple: false,
          postId: POST_ID,
        },
      },
    ]);
    world.queued = 'approved';
    expect(await draftComment(item(), BUSINESS)).toMatchObject({
      line: 'Wrote a comment on Kim Baker’s post: it goes soon',
    });
  });

  it('isn’t written without its post, or queued when the AI had nothing to say', async () => {
    expect(await draftComment(item({ postId: null }), BUSINESS)).toEqual({
      done: false,
      line: 'Kim Baker’s post: no post kept',
    });
    world.draft = [];
    expect(await draftComment(item(), BUSINESS)).toEqual({
      done: false,
      line: 'Kim Baker’s post: the AI had nothing to say on it',
    });
    expect(world.posted).toEqual([]);
  });

  it('says what the runner’s doing', () => {
    expect(commentDoing({ do: 'draft', item: item() })).toBe(
      'Writing a comment on Kim Baker’s post…',
    );
    expect(commentDoing({ do: 'send', item: sending() })).toBe('Commenting on Kim Baker’s post…');
    expect(commentDoing({ do: 'draft', item: item({ kind: 'opener' }) })).toBeNull();
  });
});

describe('a comment’s send', () => {
  it('goes on the post’s own page, told whose post it is, and is noted as the extension’s own', async () => {
    const tab = runner({ ok: true, result: 'done' });
    expect(await sendComment(sending(), KIM, BUSINESS, tab.runner)).toEqual({
      done: true,
      line: 'Commented on Kim Baker’s post',
    });
    expect(tab.opened).toEqual([POST]);
    expect(tab.asks).toEqual([
      {
        type: 'hfos-comment',
        text: 'Lovely crumb! What flour do you use?',
        profile: KIM,
        postUrl: POST,
      },
    ]);
    expect(world.noted).toEqual([
      {
        note: {
          type: 'hfos-noted',
          step: {
            kind: 'comment',
            to: { name: 'Kim Baker', profile: KIM },
            group: null,
            postUrl: POST,
            thread: null,
            replying: null,
            auto: true,
            postText: 'Fresh sourdough this morning',
            commentText: 'Lovely crumb! What flour do you use?',
          },
          at: expect.any(String),
        },
        platform: 'instagram',
      },
    ]);
    expect(done().map((p) => p.body)).toEqual([
      {
        workspaceId: BUSINESS,
        sendId: 'c0c0c0c0-0000-4000-8000-000000000001',
        sent: true,
        why: null,
      },
    ]);
  });

  it('tells HandsFreeOS it didn’t go, with why, when there’s no box or the network didn’t take it', async () => {
    expect(
      await sendComment(sending(), KIM, BUSINESS, runner({ ok: true, result: 'none' }).runner),
    ).toEqual({
      done: false,
      line: 'Kim Baker’s post: couldn’t find the post’s own box to comment in',
    });
    expect(
      await sendComment(sending(), KIM, BUSINESS, runner({ ok: true, result: 'not_sent' }).runner),
    ).toEqual({ done: false, line: 'Kim Baker’s post: Instagram didn’t take the comment' });
    expect(
      await sendComment(
        sending(),
        KIM,
        BUSINESS,
        runner({ ok: false, error: 'The extension doesn’t comment on Instagram on its own.' })
          .runner,
      ),
    ).toEqual({
      done: false,
      line: 'Kim Baker’s post: The extension doesn’t comment on Instagram on its own.',
    });
    expect(done().map((p) => [p.body.sent, p.body.why])).toEqual([
      [false, 'couldn’t find the post’s own box to comment in'],
      [false, 'Instagram didn’t take the comment'],
      [false, 'The extension doesn’t comment on Instagram on its own.'],
    ]);
    expect(world.noted).toEqual([]);
  });

  it('isn’t tried without the post’s link, and a warning or a sign-in stops it before anything’s written', async () => {
    const nowhere = runner({ ok: true, result: 'done' });
    expect(await sendComment(sending({ postUrl: null }), KIM, BUSINESS, nowhere.runner)).toEqual({
      done: false,
      line: 'Kim Baker’s post: no link to it kept',
    });
    expect(nowhere.opened).toEqual([]);

    const warned = runner({ ok: true, result: 'done' }, [{ stop: 'Instagram warned you.' }]);
    expect(await sendComment(sending(), KIM, BUSINESS, warned.runner)).toEqual({
      stop: 'Instagram warned you.',
    });
    const signedOut = runner({ ok: true, result: 'done' }, [{ again: 'Sign in to Instagram.' }]);
    expect(await sendComment(sending(), KIM, BUSINESS, signedOut.runner)).toEqual({
      again: 'Sign in to Instagram.',
    });
    expect(warned.asks).toEqual([]);
    expect(signedOut.asks).toEqual([]);
    // Only the missing link was told as not sent; a stop leaves it for later.
    expect(done()).toHaveLength(1);
  });

  it('stops for the day on a warning once it went, and goes on when the person skipped it meanwhile', async () => {
    const warned = runner({ ok: true, result: 'done' }, [null, { stop: 'Instagram warned you.' }]);
    expect(await sendComment(sending(), KIM, BUSINESS, warned.runner)).toEqual({
      stop: 'Instagram warned you.',
    });
    world.doneStatus = 404;
    expect(
      await sendComment(sending(), KIM, BUSINESS, runner({ ok: true, result: 'done' }).runner),
    ).toEqual({ done: true, line: 'Commented on Kim Baker’s post' });
  });
});
