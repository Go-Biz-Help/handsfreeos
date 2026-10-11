/**
 * Helpful posts in the groups, and the people who engage (docs/outreach.md, decision 50), in the extension: a post put
 * up through the box Facebook opens over a group's page, on a made-up page; who commented on and reacted to the
 * person's own post, never the person; and the jobs that put one up and read who engaged, against made-up pages and
 * HandsFreeOS.
 */
import { describe, expect, it, vi } from 'vitest';
import { readComments, readReactions, writeGroupPost } from '../src/facebook/compose';
import { readPage } from '../src/facebook/page';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));
// The page's own waits, the same.
vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });

const { foundPost, postHelpful, readEngaged } = await import('../src/jobs/helpful');

const FB = 'https://www.facebook.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const HELPFUL = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const GROUP_URL = `${FB}/groups/texascontractors/`;
const POST_URL = `${FB}/groups/7766554433221100/posts/5555666677778888/`;

/** The group's page, where Write something opens the box, typing goes where the caret is, and Post closes it. */
function composerPage(after: 'close' | 'pending' | 'stay' = 'close') {
  const doc = load('group-compose-2026.html', GROUP_URL);
  const composer = doc.getElementById('composer')!;
  const box = doc.getElementById('box')!;
  doc.getElementById('start')!.addEventListener('click', () => composer.removeAttribute('hidden'));
  doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
    box.textContent = text ?? '';
    return true;
  };
  const posted: string[] = [];
  doc.getElementById('post')!.addEventListener('click', () => {
    posted.push(box.textContent ?? '');
    if (after === 'stay') return;
    composer.setAttribute('hidden', '');
    if (after === 'pending')
      doc.querySelector('[role="main"]')!.append('Your post is pending. Admins will review it.');
  });
  return { doc, posted };
}

describe('putting a helpful post up', () => {
  it('opens the box, types the post, and presses Post', async () => {
    const { doc, posted } = composerPage();
    expect(await writeGroupPost(doc, 'One habit that won me more jobs.')).toBe('done');
    expect(posted).toEqual(['One habit that won me more jobs.']);
  });

  it('says when the admins approve posts first, and when Facebook didn’t take it', async () => {
    expect(await writeGroupPost(composerPage('pending').doc, 'A tip.')).toBe('pending');
    const stays = writeGroupPost(composerPage('stay').doc, 'A tip.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await stays).toBe('not_sent');
    const none = composerPage();
    none.doc.getElementById('start')!.remove();
    expect(await writeGroupPost(none.doc, 'A tip.')).toBe('none');
  });
});

describe('who engaged with the person’s post', () => {
  it('reads each comment once, with what it says, and who reacted, never the person', async () => {
    const doc = load('group-post-2026.html', POST_URL);
    const comments = readComments(doc, POST_URL);
    expect(comments.map((c) => [c.name, c.profile.id, c.comment])).toEqual([
      ['Priya Shah', '100005000000002', 'We do. Send me the address.'],
      ['Leo Grant', '100005000000003', 'Following.'],
    ]);
    // See who reacted to this opens the box with the people; the person is in it too.
    const reacted = doc.querySelector('[aria-label="See who reacted to this"] [role="button"]')!;
    reacted.addEventListener('click', () => {
      const box = doc.createElement('div');
      box.setAttribute('role', 'dialog');
      box.innerHTML = `
        <a href="/groups/7766554433221100/user/100005000000002/">Priya Shah</a>
        <a href="/robin.hale.77">Robin Hale</a>
        <a href="/sam.carter.71">Sam Carter</a>
        <div role="button" aria-label="Close"></div>`;
      box.querySelector('[aria-label="Close"]')!.addEventListener('click', () => box.remove());
      doc.body.append(box);
    });
    const reactions = await readReactions(doc, POST_URL);
    expect(reactions.map((r) => r.name)).toEqual(['Priya Shah', 'Sam Carter']);
    // Closed after.
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
  });
});

/** A tab that opens made-up pages by address and answers the page's steps with `step`. */
function fakeTab(pages: (url: string) => string, step: (message: { type: string }) => unknown) {
  let at = '';
  const opened: string[] = [];
  const tab = {
    async open(url: string) {
      at = url;
      opened.push(url);
    },
    async ask(message: { readonly type: string }) {
      if (message.type === 'hfos-read')
        return { ok: true, result: readPage(load(pages(at), at), at) };
      return step(message);
    },
  } as unknown as JobTab;
  return { tab, opened };
}

function fakeHfos(answers: Partial<Record<HfosAsk['type'], (ask: HfosAsk) => unknown>>) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    const answer = answers[ask.type];
    if (!answer) throw new Error(`Not expected: ${ask.type}`);
    return { ok: true, value: answer(ask) };
  }) as unknown as Hfos;
  return { hfos, sent };
}

const jobWith = (tab: JobTab, hfos: Hfos): Job => ({
  tab,
  hfos,
  businessId: BUSINESS,
  stopped: () => false,
  progress: () => undefined,
  warn: async () => undefined,
});

const MEETUP = 'Reminder: our monthly meetup is Thursday at 6.';

describe('the jobs', () => {
  it('finds a post by its first words, as Facebook may cut it short', () => {
    const page = readPage(load('group-feed.html', GROUP_URL), GROUP_URL);
    expect(foundPost(page, `${MEETUP} Bring a friend!`)).toMatch(/2233445566778899/);
    expect(foundPost(page, 'Something nobody posted at all, ever.')).toBeNull();
  });

  it('puts the OK’d post up, finds its link at the top of the newest, and notes it', async () => {
    const steps: string[] = [];
    const { tab, opened } = fakeTab(
      (at) => (at.includes('sorting_setting') ? 'group-feed.html' : 'group-compose-2026.html'),
      (message) => {
        steps.push(message.type);
        return { ok: true, result: 'done' };
      },
    );
    const { hfos, sent } = fakeHfos({
      'hfos-helpful-next': () => ({
        post: {
          helpfulId: HELPFUL,
          groupName: 'Texas Contractors Network',
          groupUrl: GROUP_URL,
          text: MEETUP,
        },
        read: [],
      }),
      'hfos-helpful-posted': () => ({ helpfulId: HELPFUL, state: 'posted' }),
    });
    const end = await postHelpful(jobWith(tab, hfos), HELPFUL);
    expect(steps).toEqual(['hfos-group-post']);
    expect(opened).toEqual([GROUP_URL, `${GROUP_URL}?sorting_setting=CHRONOLOGICAL`]);
    const note = sent.find((a) => a.type === 'hfos-helpful-posted') as Extract<
      HfosAsk,
      { type: 'hfos-helpful-posted' }
    >;
    expect(note.input).toMatchObject({ helpfulId: HELPFUL, posted: true });
    expect(note.input.url).toMatch(/2233445566778899/);
    expect(end).toMatchObject({
      line: 'Put your helpful post up in Texas Contractors Network.',
      posted: true,
    });
  });

  it('notes why when Facebook didn’t take it', async () => {
    const { tab } = fakeTab(
      () => 'group-compose-2026.html',
      () => ({ ok: true, result: 'none' }),
    );
    const { hfos, sent } = fakeHfos({
      'hfos-helpful-next': () => ({
        post: { helpfulId: HELPFUL, groupName: null, groupUrl: GROUP_URL, text: MEETUP },
        read: [],
      }),
      'hfos-helpful-posted': () => ({ helpfulId: HELPFUL, state: 'failed' }),
    });
    const end = await postHelpful(jobWith(tab, hfos), null);
    expect(sent.find((a) => a.type === 'hfos-helpful-posted')).toMatchObject({
      input: {
        posted: false,
        why: 'Facebook didn’t show the box to write a post. Copy it and post it yourself, or skip it.',
      },
    });
    expect(end.failed).toBe(true);
  });

  it('reads who engaged with each post up lately, and sends them', async () => {
    const { tab, opened } = fakeTab(
      () => 'group-post-2026.html',
      () => ({
        ok: true,
        comments: [
          {
            name: 'Priya Shah',
            profile: {
              id: '100005000000002',
              username: null,
              url: `${FB}/profile.php?id=100005000000002`,
            },
            comment: 'We do.',
          },
        ],
        reactions: [],
      }),
    );
    const { hfos, sent } = fakeHfos({
      'hfos-helpful-next': () => ({
        post: null,
        read: [
          {
            helpfulId: HELPFUL,
            groupName: 'Riverside Home Pros',
            groupUrl: GROUP_URL,
            postUrl: POST_URL,
            text: 'x',
          },
        ],
      }),
      'hfos-helpful-engaged': () => ({ helpfulId: HELPFUL, added: 1 }),
    });
    const end = await readEngaged(jobWith(tab, hfos));
    expect(opened).toEqual([POST_URL]);
    expect(sent.find((a) => a.type === 'hfos-helpful-engaged')).toMatchObject({
      input: {
        helpfulId: HELPFUL,
        url: POST_URL,
        comments: [{ name: 'Priya Shah', comment: 'We do.' }],
      },
    });
    expect(end.line).toBe('Read 1 post: 1 new person engaged. They’re on your list for today.');
  });
});
