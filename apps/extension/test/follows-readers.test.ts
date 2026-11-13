/**
 * Threads' and X's readers and presses (src/networks/follows/, decision 163), on pages written here by hand in the
 * shape each site draws, of made-up accounts: a post found by the link its time sits in and named by its address, a
 * quoted post never taken for another, a post's replies after it on its own page, a profile read off its header, the
 * person's followers off their rows; and the presses, each only on the page it's for: Like, Follow, Unfollow and a
 * reply typed only in the post's own box.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  followThem,
  likeTheirPost,
  unfollowThem,
  writeTheirComment,
} from '../src/networks/follows/auto';
import { countOf, readFollow } from '../src/networks/follows/read';
import { THREADS_SPEC } from '../src/networks/threads/spec';
import { kindOf, postOf, profileOf, X_SPEC, xUrl } from '../src/networks/x/spec';

const X = 'https://x.com';
const TH = 'https://www.threads.com';
const page = (body: string, url: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;

// ------------------------------------------------------------------------------------------------- X's pages

const X_MENU = `<nav><a data-testid="AppTabBar_Profile_Link" href="/casey_owner" aria-label="Profile">Profile</a></nav>`;

/** One of X's posts, as its pages draw it: the time in the link to the post, its writer's handle in that address. */
const tweet = (
  handle: string,
  name: string,
  id: string,
  text: string,
  { at = '2026-11-13T15:00:00.000Z', liked = false, likes = 3, replying = '', inner = '' } = {},
) => `<article data-testid="tweet" tabindex="0">
  <div data-testid="User-Name"><a href="/${handle}"><span>${name}</span></a><a href="/${handle}"><span>@${handle}</span></a>
    <a href="/${handle}/status/${id}"><time datetime="${at}">2h</time></a></div>
  ${replying ? `<div>Replying to <a href="/${replying}">@${replying}</a></div>` : ''}
  <div data-testid="tweetText" lang="en">${text}</div>
  ${inner}
  <div role="group">
    <button data-testid="reply" aria-label="4 Replies. Reply"><span>4</span></button>
    <button data-testid="${liked ? 'unlike' : 'like'}" aria-label="${likes} Likes. Like"><span>${likes}</span></button>
  </div></article>`;

describe('X’s addresses', () => {
  it('knows an account, a post and its own places by their addresses, at twitter.com too', () => {
    const at = (href: string) => xUrl(href)!;
    expect(kindOf(at(`${X}/home`))).toBe('feed');
    expect(kindOf(at(`${X}/dana_reyes`))).toBe('profile');
    expect(kindOf(at(`${X}/dana_reyes/status/1850000000000000001`))).toBe('post');
    expect(kindOf(at(`${X}/casey_owner/followers`))).toBe('followers');
    expect(kindOf(at(`${X}/notifications/mentions`))).toBe('notifications');
    expect(kindOf(at(`${X}/i/flow/login`))).toBe('login');
    expect(profileOf(at('https://twitter.com/Dana_Reyes'))).toEqual({
      username: 'Dana_Reyes',
      url: `${X}/Dana_Reyes`,
    });
    expect(postOf(at('https://mobile.twitter.com/dana_reyes/status/99/photo/1'))).toBe(
      `${X}/dana_reyes/status/99`,
    );
    // X's own places are never an account.
    for (const own of ['explore', 'search', 'settings', 'messages', 'i'])
      expect(profileOf(at(`${X}/${own}`))).toBeNull();
    expect(xUrl('https://x.com.example.com/dana')).toBeNull();
  });

  it('reads its counts as numbers', () => {
    expect(countOf('1.2K')).toBe(1200);
    expect(countOf('3,410 Followers')).toBe(3410);
    expect(countOf('12 Likes. Like')).toBe(12);
    expect(countOf('Like')).toBeNull();
  });
});

describe('X’s readers', () => {
  it('reads a search’s posts by their own links, never a quoted post as one of them', () => {
    // A quoted post shows its writer, its time in a link to it and its words, and no buttons of its own.
    const quoted = `<div role="link"><div data-testid="User-Name"><a href="/sam_lee"><span>Sam Lee</span></a>
      <a href="/sam_lee/status/222"><time datetime="2026-11-09T10:00:00.000Z">Nov 9</time></a></div>
      <div data-testid="tweetText">Quoted words</div></div>`;
    const doc = page(
      `${X_MENU}<div data-testid="primaryColumn">
        ${tweet('dana_reyes', 'Dana Reyes', '111', 'Who do you use for a CRM that texts leads?', { inner: quoted, likes: 12 })}
        ${tweet('avery_lane', 'Avery Lane', '333', 'Closing day 🎉', { liked: true })}
      </div>`,
      `${X}/search?q=crm&f=live`,
    );
    const found = readFollow(doc, doc.location.href, X_SPEC);
    expect(found.me).toBe('casey_owner');
    expect(found.posts.map((p) => [p.url, p.author.username, p.name, p.liked])).toEqual([
      [`${X}/dana_reyes/status/111`, 'dana_reyes', 'Dana Reyes', false],
      [`${X}/avery_lane/status/333`, 'avery_lane', 'Avery Lane', true],
    ]);
    expect(found.posts[0]).toMatchObject({
      text: 'Who do you use for a CRM that texts leads?',
      at: '2026-11-13T15:00:00.000Z',
      likes: 12,
      replies: 4,
    });
    expect(found.post).toBeNull();
    expect(found.replies).toEqual([]);
  });

  it('reads a post’s replies after it on its own page, with who each answers', () => {
    const doc = page(
      `${X_MENU}<div data-testid="primaryColumn">
        ${tweet('dana_reyes', 'Dana Reyes', '111', 'Who do you use for a CRM?')}
        ${tweet('avery_lane', 'Avery Lane', '444', 'Following for answers', { replying: 'dana_reyes' })}
        ${tweet('casey_owner', 'Casey Owner', '555', 'Happy to show you ours', { replying: 'dana_reyes' })}
      </div>`,
      `${X}/dana_reyes/status/111`,
    );
    const found = readFollow(doc, doc.location.href, X_SPEC);
    expect(found.post?.url).toBe(`${X}/dana_reyes/status/111`);
    expect(found.replies.map((r) => [r.author.username, r.replyingTo])).toEqual([
      ['avery_lane', ['dana_reyes']],
      ['casey_owner', ['dana_reyes']],
    ]);
  });

  it('says a mention answers the person when it says it replies to them', () => {
    const doc = page(
      `${X_MENU}<div data-testid="primaryColumn">
        ${tweet('dana_reyes', 'Dana Reyes', '777', 'Yes, I’d love a demo', { replying: 'casey_owner' })}
      </div>`,
      `${X}/notifications/mentions`,
    );
    expect(readFollow(doc, doc.location.href, X_SPEC).posts[0]?.replyingTo).toEqual([
      'casey_owner',
    ]);
  });

  const PROFILE = (
    button: string,
    follows = true,
  ) => `${X_MENU}<div data-testid="primaryColumn"><div>
    <div><div>${button}</div>
      <div data-testid="UserName"><div><span>Dana Reyes</span></div><div><span>@dana_reyes</span></div></div>
      <div data-testid="UserDescription">Realtor in Austin. Coffee first.</div>
      <a data-testid="UserUrl" href="https://t.co/abc">danasells.example</a>
      <div><a href="/dana_reyes/following"><span>210</span> Following</a>
        <a href="/dana_reyes/verified_followers"><span>1,204</span> Followers</a></div>
      ${follows ? '<span data-testid="userFollowIndicator">Follows you</span>' : ''}
    </div>
    ${tweet('dana_reyes', 'Dana Reyes', '901', 'Just listed in Hyde Park')}
  </div></div>`;
  const FOLLOW =
    '<button data-testid="1234-follow" aria-label="Follow @dana_reyes"><span>Follow</span></button>';
  const FOLLOWING =
    '<button data-testid="1234-unfollow" aria-label="Following @dana_reyes"><span>Following</span></button>';

  it('reads a profile off its header: name, bio, link, followers, and where things stand', () => {
    const doc = page(PROFILE(FOLLOW), `${X}/dana_reyes`);
    const found = readFollow(doc, doc.location.href, X_SPEC);
    expect(found.profile).toMatchObject({
      username: 'dana_reyes',
      url: `${X}/dana_reyes`,
      name: 'Dana Reyes',
      bio: 'Realtor in Austin. Coffee first.',
      links: ['Link: danasells.example'],
      followers: 1204,
      followsYou: true,
      following: 'no',
    });
    expect(found.profile?.posts.map((p) => p.url)).toEqual([`${X}/dana_reyes/status/901`]);
    const followed = page(PROFILE(FOLLOWING, false), `${X}/dana_reyes`);
    expect(readFollow(followed, followed.location.href, X_SPEC).profile).toMatchObject({
      following: 'following',
      followsYou: false,
    });
  });

  it('reads the person’s followers off their rows, each once, never the person', () => {
    const row = (handle: string, name: string, button: string) => `<div data-testid="UserCell">
      <a href="/${handle}"><span>${name}</span></a><a href="/${handle}"><span>@${handle}</span></a>${button}</div>`;
    const doc = page(
      `${X_MENU}<div data-testid="primaryColumn">
        ${row('avery_lane', 'Avery Lane', '<button data-testid="11-follow">Follow back</button>')}
        ${row('sam_lee', 'Sam Lee', '<button data-testid="12-unfollow">Following</button>')}
        ${row('avery_lane', 'Avery Lane', '<button data-testid="11-follow">Follow back</button>')}
        ${row('casey_owner', 'Casey Owner', '')}
      </div>`,
      `${X}/casey_owner/followers`,
    );
    expect(readFollow(doc, doc.location.href, X_SPEC).people).toEqual([
      { username: 'avery_lane', url: `${X}/avery_lane`, name: 'Avery Lane', following: 'no' },
      { username: 'sam_lee', url: `${X}/sam_lee`, name: 'Sam Lee', following: 'following' },
    ]);
  });

  it('likes only the post its page is for, by its own Like, once it says so', async () => {
    const doc = page(
      tweet('dana_reyes', 'Dana Reyes', '111', 'Who do you use?'),
      `${X}/dana_reyes/status/111`,
    );
    const like = doc.querySelector('[data-testid="like"]')!;
    like.addEventListener('click', () => like.setAttribute('data-testid', 'unlike'));
    const dana = { id: null, username: 'dana_reyes', url: `${X}/dana_reyes` };
    // Someone else's name, or another post asked for: nothing pressed.
    expect(
      await likeTheirPost(X_SPEC)(
        doc,
        doc.location.href,
        { ...dana, username: 'sam_lee' },
        { index: 0, url: null },
      ),
    ).toMatchObject({ result: 'none' });
    expect(
      await likeTheirPost(X_SPEC)(doc, doc.location.href, dana, {
        index: 0,
        url: `${X}/dana_reyes/status/999`,
      }),
    ).toMatchObject({ result: 'none' });
    expect(like.getAttribute('data-testid')).toBe('like');
    expect(
      await likeTheirPost(X_SPEC)(doc, doc.location.href, dana, {
        index: 0,
        url: `https://twitter.com/dana_reyes/status/111`,
      }),
    ).toEqual({ result: 'done', postUrl: `${X}/dana_reyes/status/111` });
    expect(
      await likeTheirPost(X_SPEC)(doc, doc.location.href, dana, { index: 0, url: null }),
    ).toMatchObject({ result: 'already' });
  });

  it('follows on their own profile, and unfollows by Following and the Unfollow X asks to be sure with', async () => {
    const doc = page(PROFILE(FOLLOW), `${X}/dana_reyes`);
    const swap = (to: string) => {
      const button = doc.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]')!;
      button.outerHTML = to;
      wire();
    };
    const wire = () => {
      doc
        .querySelector('[data-testid="1234-follow"]')
        ?.addEventListener('click', () => swap(FOLLOWING));
      doc.querySelector('[data-testid="1234-unfollow"]')?.addEventListener('click', () => {
        doc.body.insertAdjacentHTML(
          'beforeend',
          '<div role="alertdialog"><button data-testid="confirmationSheetConfirm">Unfollow</button></div>',
        );
        doc
          .querySelector('[data-testid="confirmationSheetConfirm"]')!
          .addEventListener('click', () => {
            doc.querySelector('[role="alertdialog"]')!.remove();
            swap(FOLLOW);
          });
      });
    };
    wire();
    const dana = { id: null, username: 'dana_reyes', url: `${X}/dana_reyes` };
    expect(await followThem(X_SPEC)(doc, `${X}/sam_lee`, dana)).toBe('none');
    expect(await followThem(X_SPEC)(doc, doc.location.href, dana)).toBe('done');
    expect(await followThem(X_SPEC)(doc, doc.location.href, dana)).toBe('already');
    expect(await unfollowThem(X_SPEC)(doc)).toBe('done');
    expect(await unfollowThem(X_SPEC)(doc)).toBe('not_found');
  });

  it('replies only in the box under their post, sent with its own button, never over writing there', async () => {
    const BOX = `<div><div data-testid="tweetTextarea_0"><div contenteditable="true" role="textbox" aria-label="Post text"></div></div>
      <button data-testid="tweetButtonInline">Reply</button></div>`;
    const doc = page(
      `${tweet('dana_reyes', 'Dana Reyes', '111', 'Who do you use?')}${BOX}`,
      `${X}/dana_reyes/status/111`,
    );
    const box = () => doc.querySelector<HTMLElement>('[contenteditable="true"]')!;
    // jsdom has no typing: the box clicked takes the words, as Chrome's does.
    doc.execCommand = (_c: string, _u?: boolean, words?: string) => {
      box().textContent = words ?? '';
      return true;
    };
    const sent: string[] = [];
    doc.querySelector('[data-testid="tweetButtonInline"]')!.addEventListener('click', () => {
      sent.push(box().textContent ?? '');
      box().textContent = '';
    });
    const on = (postUrl: string, username = 'dana_reyes') => ({
      profile: { id: null, username, url: `${X}/${username}` },
      postUrl,
    });
    const text = 'We text leads for you. Happy to show you how it works.';
    expect(
      await writeTheirComment(X_SPEC)(doc, doc.location.href, text, on(`${X}/dana_reyes/status/2`)),
    ).toBe('none');
    expect(
      await writeTheirComment(X_SPEC)(
        doc,
        doc.location.href,
        text,
        on(`${X}/dana_reyes/status/111`, 'sam_lee'),
      ),
    ).toBe('none');
    box().textContent = 'the person’s own words';
    expect(
      await writeTheirComment(X_SPEC)(
        doc,
        doc.location.href,
        text,
        on(`${X}/dana_reyes/status/111`),
      ),
    ).toBe('not_sent');
    box().textContent = '';
    expect(
      await writeTheirComment(X_SPEC)(
        doc,
        doc.location.href,
        text,
        on(`${X}/dana_reyes/status/111`),
      ),
    ).toBe('done');
    expect(sent).toEqual([text]);
  });
});

// ------------------------------------------------------------------------------------------------- Threads' pages

const TH_MENU = `<nav><a href="/" aria-label="Home">Home</a><a href="/@casey.owner" aria-label="Profile"><svg aria-label="Profile"></svg></a></nav>`;

/** One of Threads' posts: its part marked as one, the time in the link to it, its buttons labelled icons. */
const thread = (name: string, code: string, text: string, { liked = false, extra = '' } = {}) =>
  `<div data-pressable-container="true">
    <a href="/@${name}"><span dir="auto">${name}</span></a>
    <a href="/@${name}/post/${code}"><time datetime="2026-11-13T15:00:00.000Z">2h</time></a>
    <div><span dir="auto">${text}</span></div>${extra}
    <div role="button"><svg aria-label="${liked ? 'Unlike' : 'Like'}"></svg><span>7</span></div>
    <div role="button"><svg aria-label="Reply"></svg><span>2</span></div>
  </div>`;

describe('Threads’ readers', () => {
  it('reads posts by their own links, with their words, likes and replies', () => {
    const doc = page(
      `${TH_MENU}<main>${thread('dana.reyes', 'DAbc123xyz', 'Any realtors using a CRM that texts?')}
        ${thread('avery.lane', 'DXyz987abc', 'Open house Sunday', { liked: true })}</main>`,
      `${TH}/search?q=crm&filter=recent`,
    );
    const found = readFollow(doc, doc.location.href, THREADS_SPEC);
    expect(found.me).toBe('casey.owner');
    expect(found.posts.map((p) => [p.url, p.author.username, p.text, p.liked, p.replies])).toEqual([
      [
        `${TH}/@dana.reyes/post/DAbc123xyz`,
        'dana.reyes',
        'Any realtors using a CRM that texts?',
        false,
        2,
      ],
      [`${TH}/@avery.lane/post/DXyz987abc`, 'avery.lane', 'Open house Sunday', true, 2],
    ]);
  });

  it('says a post on their activity answers the person only there, where it says it replied', () => {
    const body = `${TH_MENU}<main>${thread('dana.reyes', 'DRep111aaa', 'Yes please, show me', { extra: '<span>replied to you</span>' })}</main>`;
    const activity = page(body, `${TH}/activity`);
    expect(readFollow(activity, activity.location.href, THREADS_SPEC).posts[0]?.replyingTo).toEqual(
      ['casey.owner'],
    );
    const elsewhere = page(body, `${TH}/search?q=crm`);
    expect(
      readFollow(elsewhere, elsewhere.location.href, THREADS_SPEC).posts[0]?.replyingTo,
    ).toEqual([]);
  });

  it('reads a profile off its header, by its Follow and its count of followers', () => {
    const doc = page(
      `${TH_MENU}<main><div>
        <h1>Dana Reyes</h1><span dir="auto">dana.reyes</span>
        <span dir="auto">Realtor in Austin</span>
        <a href="https://l.threads.com/?u=danasells.example">danasells.example</a>
        <div role="button"><span>1,204 followers</span></div>
        <div role="button">Follow back</div>
      </div>${thread('dana.reyes', 'DPost22bbb', 'Just listed')}</main>`,
      `${TH}/@dana.reyes`,
    );
    expect(readFollow(doc, doc.location.href, THREADS_SPEC).profile).toMatchObject({
      username: 'dana.reyes',
      name: 'Dana Reyes',
      bio: 'Realtor in Austin',
      links: ['Link: danasells.example'],
      followers: 1204,
      followsYou: true,
      following: 'no',
    });
  });
});
