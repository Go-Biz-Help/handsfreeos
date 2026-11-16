/**
 * The look at a post before its comment is drafted on every network but Instagram (docs/outreach.md, decision 172):
 * each site's own part of the post's page, as a comment there goes, on made-up pages. Facebook's and LinkedIn's
 * (`lookStep` in each one's work.ts): the first post box on the post's own page, theirs by its writer's link, never a
 * comment's picture; Alignable's (`theirPostPart`): the discussion's post, by its id, never an answer; Threads' and
 * X's: the post the page is, by its address, never one it quotes. Anything else is nothing seen.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOK_WANT } from '../src/auto/post-look';
import type { PostLookAnswer, PostLookAsk } from '../src/messages';
import { ALIGNABLE } from '../src/networks/alignable/site';
import { work as facebookWork } from '../src/networks/facebook/work';
import { work as linkedInWork } from '../src/networks/linkedin/work';
import type { CommentOn } from '../src/networks/looking/site';
import { X } from '../src/networks/x/kit';
import { load } from './load';

afterEach(() => vi.unstubAllGlobals());

/** A page in the tab, as the tab's own script sees it. */
function inTab(doc: Document, href: string) {
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', new URL(href));
}

/** The runner's ask for a look at their post. */
const look = (profile: PostLookAsk['profile'], postUrl: string): PostLookAsk => ({
  type: 'hfos-post-look',
  profile,
  postUrl,
  want: LOOK_WANT,
});

const photoIn = (answer: unknown) => {
  const seen = (answer as PostLookAnswer & { ok: true }).seen;
  return seen?.kind === 'photo' ? seen.url : seen;
};

// ------------------------------------------------------------------------------------------------ Facebook

describe('the look at a post on Facebook', () => {
  const FB = 'https://www.facebook.com';
  const POST = `${FB}/dana.reyes.12/posts/pfbid0aaaa1111bbbb2222/`;
  const PHOTO = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/kitchen.jpg';
  const page = (by = 'dana.reyes.12') =>
    new JSDOM(
      `<!doctype html><html><body><div role="main"><div role="article">
        <h2><strong><a href="/${by}">Dana Reyes</a></strong></h2>
        <div data-ad-preview="message"><span dir="auto">New tiles in the kitchen</span></div>
        <img src="${PHOTO}" width="720" height="540">
        <div role="article" aria-label="Comment by Sam Lee 1 week ago">
          <a href="/sam.lee?comment_id=1">Sam Lee</a><span dir="auto">Ours next!</span>
          <img src="https://scontent.xx.fbcdn.net/v/sam-kitchen.jpg" width="900" height="900"></div>
      </div></div></body></html>`,
      { url: POST },
    ).window.document;
  const ask = (username: string, postUrl = POST) =>
    facebookWork(look({ id: null, username, url: `${FB}/${username}` }, postUrl));

  it('sees the post’s own photo, never a picture in a comment under it', async () => {
    inTab(page(), POST);
    expect(photoIn(await ask('dana.reyes.12'))).toBe(PHOTO);
  });

  it('sees nothing of a post that isn’t theirs, or on a page that isn’t a post', async () => {
    inTab(page('someone.else'), POST);
    expect(photoIn(await ask('dana.reyes.12'))).toBeNull();
    inTab(page(), `${FB}/groups/austin-homes/`);
    expect(photoIn(await ask('dana.reyes.12'))).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ LinkedIn

describe('the look at a post on LinkedIn', () => {
  const LI = 'https://www.linkedin.com';
  const POST = `${LI}/feed/update/urn:li:activity:7380000000000000101/`;
  const PHOTO = 'https://media.licdn.com/dms/image/v2/D4E22AQ/feedshare-shrink_800/0/1.jpg';
  const writer = () => {
    const doc = load('linkedin-post.html', POST);
    inTab(doc, POST);
    return doc;
  };

  it('sees the post’s own photo, from the post’s own box, when it’s theirs', async () => {
    const doc = writer();
    // Who wrote the fixture's post, as LinkedIn's reader has it: asked for by that member.
    const { readPost } = await import('../src/networks/linkedin/posts');
    const { postOnPage } = await import('../src/networks/linkedin/auto');
    const box = postOnPage(doc)!;
    const author = readPost(box, POST)!.author!.profile!;
    const img = doc.createElement('img');
    img.setAttribute('src', PHOTO);
    img.setAttribute('width', '800');
    img.setAttribute('height', '600');
    box.prepend(img);
    const asked = (profile: typeof author, postUrl = POST) => linkedInWork(look(profile, postUrl));
    expect(photoIn(await asked(author))).toBe(PHOTO);
    // Someone else's name asked for, or another post's address: nothing seen.
    expect(
      photoIn(
        await asked({ id: null, username: 'someone-else-9', url: `${LI}/in/someone-else-9/` }),
      ),
    ).toBeNull();
    expect(
      photoIn(await asked(author, `${LI}/feed/update/urn:li:activity:7380000000000000999/`)),
    ).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ Alignable

describe('the look at a post on Alignable', () => {
  const AL = 'https://www.alignable.com';
  const AT = `${AL}/biz/discussions/93`;
  const PHOTO = 'https://assets.alignable.com/discussions/93/heater.jpg';
  const page = () =>
    new JSDOM(
      `<!doctype html><html><body><main><section>
        <div><div><a href="/austin-tx/acme-plumbing?user=5"><span>Dana Reyes</span><span>at</span>
            <span>Acme Plumbing</span></a><span>4h</span></div>
          <div><div title="An update">Who has tips for a water heater that keeps tripping?</div>
            <img src="${PHOTO}" width="640" height="480"></div>
          <div><div><a href="/biz/discussions/93">Comment</a></div></div></div>
        <div data-testid="discussion-comment"><a href="/salem-or/park-florist?user=4">Lee Park</a>
          <div data-testid="discussion-comment-body">Check the breaker first.</div>
          <img src="https://assets.alignable.com/answers/breaker.jpg" width="640" height="480"></div>
      </section></main></body></html>`,
      { url: AT },
    ).window.document;
  // A business as Alignable's readers keep it: its town and name in one.
  const on = (business: string, postUrl = AT): CommentOn => ({
    profile: { id: null, username: business.replace('/', '-'), url: `${AL}/${business}` },
    postUrl,
  });

  it('is the discussion’s post asked for, never an answer under it', async () => {
    const doc = page();
    const part = ALIGNABLE.auto!.postPart!(doc, AT, on('austin-tx/acme-plumbing'))!;
    expect(part).not.toBeNull();
    expect(part.root.querySelector(`img[src="${PHOTO}"]`)).not.toBeNull();
    const answer = doc.querySelector('[data-testid="discussion-comment"] img')!;
    expect(part.skip(answer)).toBe(true);
    // Another business's, or another discussion asked for: nothing.
    expect(ALIGNABLE.auto!.postPart!(doc, AT, on('salem-or/park-florist'))).toBeNull();
    expect(
      ALIGNABLE.auto!.postPart!(doc, AT, on('austin-tx/acme-plumbing', `${AL}/biz/discussions/94`)),
    ).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ Threads and X

describe('the look at a post on Threads and X', () => {
  const XC = 'https://x.com';
  const AT = `${XC}/dana_reyes/status/1111`;
  const page = () =>
    new JSDOM(
      `<!doctype html><html><body><nav><a data-testid="AppTabBar_Profile_Link" href="/casey_owner">Profile</a></nav>
      <div data-testid="primaryColumn"><article data-testid="tweet">
        <div data-testid="User-Name"><a href="/dana_reyes"><span>Dana Reyes</span></a>
          <a href="/dana_reyes/status/1111"><time datetime="2026-11-16T10:00:00.000Z">2h</time></a></div>
        <div data-testid="tweetText">Day 3 of the road trip</div>
        <a href="/dana_reyes/status/1111/photo/1"><img src="https://pbs.twimg.com/media/Road.jpg" width="600" height="400"></a>
        <a href="/sam_lee/status/2222"><img id="quoted" src="https://pbs.twimg.com/media/Quoted.jpg" width="600" height="400"></a>
        <div role="group"><button data-testid="reply" aria-label="Reply"></button></div></article></div>
      </body></html>`,
      { url: AT },
    ).window.document;
  const on = (username: string, postUrl = AT): CommentOn => ({
    profile: { id: null, username, url: `${XC}/${username}` },
    postUrl,
  });

  it('is the post the page is, theirs by its address, never a post it quotes', () => {
    const doc = page();
    const part = X.auto!.postPart!(doc, AT, on('dana_reyes'))!;
    expect(part).not.toBeNull();
    expect(part.skip(doc.querySelector('#quoted')!)).toBe(true);
    expect(part.skip(doc.querySelector('img[src*="Road"]')!)).toBe(false);
    // Someone else's post, or another post asked for: nothing.
    expect(X.auto!.postPart!(doc, AT, on('sam_lee'))).toBeNull();
    expect(X.auto!.postPart!(doc, AT, on('dana_reyes', `${XC}/dana_reyes/status/3333`))).toBeNull();
  });
});
