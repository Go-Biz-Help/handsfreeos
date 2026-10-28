/**
 * A comment on a good post on Instagram (src/networks/instagram/auto.ts `writeTheirComment`, docs/outreach.md decision
 * 92): once the person OK'd it, or the comment hold is past, it's written only on the post asked for, whose own link
 * names them; only in the post's own box, never one drawn to reply under someone's comment, and never one with writing
 * in it; and sent with that box's own form's Post. On a post written here by hand from Instagram's usual markup, with
 * made-up people.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTAGRAM } from '../src/networks/instagram/site';
import type { CommentOn } from '../src/networks/looking/site';

const IG = 'https://www.instagram.com';

const ON: CommentOn = {
  profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
  postUrl: `${IG}/p/C3xyzabcd/`,
};
const TEXT = 'Those tiles came out lovely. How long did the grout take to set?';

/** A comment under the post, with its own link on its time, its likes and its Reply. */
const comment = (username: string, id: string, text: string) =>
  `<div><a role="link" href="/${username}/"><span dir="auto">${username}</span></a>
    <a role="link" href="/p/C3xyzabcd/c/${id}/"><time>2w</time></a><span dir="auto">${text}</span>
    <div role="button"><span>Reply</span></div><div role="button"><svg aria-label="Like"></svg></div></div>`;

/**
 * The post's own page: who wrote it, a comment with a box drawn under it to reply in (`reply`), the post's bar, its own
 * link (naming who wrote it), and its own box to comment in, in its form.
 */
const postPage = ({
  path = '/p/C3xyzabcd/',
  by = 'dana.reyes',
  reply = true,
  own = true,
  written = '',
} = {}) =>
  new JSDOM(
    `<!doctype html><html><body><main role="main"><article>
      <div><a role="link" href="/${by}/"><span dir="auto">${by}</span></a>
        <div role="button"><svg aria-label="More options"></svg></div></div>
      <div id="comments"><div>${comment('sam.lee', '17900000000000001', 'Great work!')}
        ${reply ? '<form id="reply"><textarea aria-label="Add a comment…">@sam.lee </textarea></form>' : ''}</div></div>
      <section><div role="button" id="post-like"><svg aria-label="Like"></svg></div>
        <div role="button"><svg aria-label="Comment"></svg></div></section>
      <section><span>14 likes</span></section>
      <div dir="auto"><a role="link" href="/${by}/p/C3xyzabcd/"><time>October 1</time></a></div>
      ${own ? `<section><form id="own"><textarea aria-label="Add a comment…" placeholder="Add a comment…">${written}</textarea></form></section>` : ''}
    </article></main></body></html>`,
    { url: `${IG}${path}` },
  ).window.document;

/**
 * As Instagram draws the post's own form: Post shows only while something's written, and pressing it takes the comment
 * (`posted`) and empties the box, unless `takes` is false.
 */
function postable(doc: Document, takes = true): string[] {
  const posted: string[] = [];
  const form = doc.querySelector('#own');
  const box = form?.querySelector('textarea');
  if (!form || !box) return posted;
  const draw = () => {
    form.querySelector('[data-post]')?.remove();
    if (!box.value.trim()) return;
    const post = doc.createElement('div');
    post.setAttribute('role', 'button');
    post.setAttribute('data-post', '');
    post.textContent = 'Post';
    post.addEventListener('click', () => {
      posted.push(box.value);
      if (!takes) return;
      box.value = '';
      draw();
    });
    form.append(post);
  };
  box.addEventListener('input', draw);
  draw();
  return posted;
}

/** Runs it as the looking kit does (`auto.comment`), with Instagram's waits skipped. */
async function commenting(
  doc: Document,
  on: CommentOn = ON,
  text = TEXT,
  href = doc.location.href,
) {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const going = INSTAGRAM.auto!.comment!(doc, href, text, on);
  await vi.advanceTimersByTimeAsync(30_000);
  return going;
}

afterEach(() => vi.useRealTimers());

describe('a comment on their post on Instagram', () => {
  it('writes only in the post’s own box, never the box under someone’s comment, and presses its form’s Post', async () => {
    const doc = postPage();
    const posted = postable(doc);
    let replied = 0;
    doc.querySelector('#reply')!.addEventListener('submit', () => replied++);
    expect(await commenting(doc)).toBe('done');
    expect(posted).toEqual([TEXT]);
    expect(doc.querySelector<HTMLTextAreaElement>('#own textarea')!.value).toBe('');
    // The box under sam.lee's comment is left as it was.
    expect(doc.querySelector<HTMLTextAreaElement>('#reply textarea')!.value).toBe('@sam.lee ');
    expect(replied).toBe(0);
  });

  it('works on the post’s page with their name first in its address', async () => {
    const doc = postPage({ path: '/dana.reyes/p/C3xyzabcd/' });
    const posted = postable(doc);
    expect(await commenting(doc)).toBe('done');
    expect(posted).toEqual([TEXT]);
  });

  it('leaves a box with writing in it alone: that’s the person’s', async () => {
    const doc = postPage({ written: 'Half a thought' });
    const posted = postable(doc);
    expect(await commenting(doc)).toBe('not_sent');
    expect(posted).toEqual([]);
    expect(doc.querySelector<HTMLTextAreaElement>('#own textarea')!.value).toBe('Half a thought');
  });

  it('writes nothing on a post that isn’t the one asked for, or isn’t theirs, or with nothing to say', async () => {
    const theirs = postPage({ by: 'kim_bakes' });
    expect(await commenting(theirs)).toBe('none');
    const other = postPage();
    expect(await commenting(other, { ...ON, postUrl: `${IG}/p/C9other12/` })).toBe('none');
    const offPost = postPage();
    expect(await commenting(offPost, ON, TEXT, `${IG}/dana.reyes/`)).toBe('none');
    const empty = postPage();
    expect(await commenting(empty, ON, '   ')).toBe('none');
    for (const doc of [theirs, other, offPost, empty])
      expect(doc.querySelector<HTMLTextAreaElement>('#own textarea')!.value).toBe('');
  });

  it('writes nothing with only a box under someone’s comment to write in', async () => {
    const doc = postPage({ own: false });
    expect(await commenting(doc)).toBe('none');
    expect(doc.querySelector<HTMLTextAreaElement>('#reply textarea')!.value).toBe('@sam.lee ');
  });

  it('takes out what it typed when no Post shows by the box', async () => {
    const doc = postPage();
    const box = doc.querySelector<HTMLTextAreaElement>('#own textarea')!;
    const typed: string[] = [];
    box.addEventListener('input', () => typed.push(box.value));
    expect(await commenting(doc)).toBe('none');
    expect(typed).toEqual([TEXT, '']);
    expect(box.value).toBe('');
  });

  it('says it didn’t go when Instagram doesn’t take it', async () => {
    const doc = postPage();
    const posted = postable(doc, false);
    expect(await commenting(doc)).toBe('not_sent');
    expect(posted).toEqual([TEXT]);
  });
});
