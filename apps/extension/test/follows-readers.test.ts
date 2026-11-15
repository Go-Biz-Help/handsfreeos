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
import { THREADS } from '../src/networks/threads/kit';
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

// ------------------------------------------------------- Threads' pages as the owner's Check Threads drew them

/**
 * An icon as Threads draws its posts' buttons (the owner's Check Threads, 15 Nov 2026, 0.140.5): named by a `title` on
 * it and a <title> inside, with no aria-label.
 */
const titled = (name: string) =>
  `<svg role="img" title="${name}" viewBox="0 0 18 18"><title>${name}</title><path d=""></path></svg>`;

/** A post on its own page, as that Check's outline drew it, with the box to reply in under it when `under`. */
const threadNow = (
  name: string,
  code: string,
  text: string,
  { liked = false, likes = 1, under = '' } = {},
) => `<div role="region" aria-label="Thread"><div><div data-pagelet="threads_post_page_1"><div>
  <div role="button"><img alt="${name}'s profile picture"><div role="button">${titled('Follow')}</div></div>
  <div><div><a href="/@${name}"><span dir="auto"><span>${name}</span></span></a>
    <span dir="auto"><a href="/@${name}/post/${code}"><time datetime="2026-11-15T14:40:00.000Z" title="Sunday, November 15, 2026 at 2:40 PM"><abbr aria-label="1 minute ago"><span>1m</span></abbr></time></a></span></div>
    <div role="button" aria-expanded="false">${titled('More')}</div></div>
  <div><span dir="auto"><span>${text}</span></span>
    <div><div role="button"><div>${titled(liked ? 'Unlike' : 'Like')}<span dir="auto"><span>${likes}</span></span></div></div>
      <div role="button">${titled('Reply')}<span dir="auto"><span>3</span></span></div>
      <div role="button" aria-expanded="false">${titled('Repost')}</div>
      <div role="button">${titled('Share')}</div></div></div>
  <div><span dir="auto">Liked by someone</span><div role="button"><span dir="auto">View activity${titled('View activity')}</span></div></div>
  ${under}
</div></div></div></div>`;

/** The box to reply in under a post on its own page: its "Reply to …" a placeholder beside it, never its name. */
const UNDER = `<div role="none"><div><img alt="casey.owner's profile picture"><div>
    <div role="textbox" aria-label="Empty text field. Type to compose a new post." contenteditable="true"><p dir="auto"><br></p></div>
    <div aria-hidden="true" class="placeholder"><span dir="auto"><span>Reply to dana.reyes...</span></span></div></div>
  <div class="tools"><div><div role="button" aria-label="Attach media"><svg></svg></div><div role="button" aria-label="Add a GIF"><svg></svg></div></div>
    <div role="button" aria-label="Expand composer"><svg></svg></div></div></div></div>`;

describe('Threads’ Like and box to reply in, as its pages drew them on 15 Nov 2026', () => {
  const POST = `${TH}/@dana.reyes/post/DQx7Ab12cd`;
  const dana = { id: null, username: 'dana.reyes', url: `${TH}/@dana.reyes` };

  /**
   * The box under the post, drawn as Threads draws it, its editor (Lexical) as the owner's second Check Threads found it
   * (15 Nov 2026, 0.140.7): typing goes in at the caret, and replaces what's selected once the editor has seen the
   * selection, a moment after select-all; delete takes out the letter before the caret, and nothing with all of it
   * selected. Words in it take the placeholder away and show its arrow named Reply (unless `arrow` is off), which sends
   * them and empties the box.
   */
  const wireUnder = (doc: Document, sent: string[], { arrow = true } = {}) => {
    const box = () => doc.querySelector<HTMLElement>('[role="none"] [contenteditable="true"]')!;
    let selecting: ReturnType<typeof setTimeout> | null = null;
    let whole = false;
    const drawn = () => {
      const words = box().textContent ?? '';
      doc.querySelector('.placeholder')?.toggleAttribute('hidden', words !== '');
      const had = doc.querySelector('.send');
      if (words && arrow && !had) {
        doc
          .querySelector('.tools')!
          .insertAdjacentHTML(
            'afterend',
            '<div class="send"><div role="button"><span><svg aria-label="Reply" role="img"><title>Reply</title></svg></span></div></div>',
          );
        doc.querySelector('.send [role="button"]')!.addEventListener('click', () => {
          sent.push(box().textContent ?? '');
          box().textContent = '';
          drawn();
        });
      } else if (!words && had) had.remove();
    };
    doc.execCommand = (command: string, _u?: boolean, words?: string) => {
      const now = box().textContent ?? '';
      if (command === 'selectAll') {
        if (selecting) clearTimeout(selecting);
        selecting = setTimeout(() => (whole = true), 100);
      } else if (command === 'insertText') {
        box().textContent = whole || !now ? (words ?? '') : now + (words ?? '');
        whole = false;
      } else if (command === 'delete' && !whole) box().textContent = now.slice(0, -1);
      drawn();
      return true;
    };
    return box;
  };

  it('reads a post’s Like, its likes and its replies off icons named by their title', () => {
    const doc = page(
      `${TH_MENU}${threadNow('dana.reyes', 'DQx7Ab12cd', 'Who do you use for follow-ups?', { likes: 12, under: UNDER })}`,
      POST,
    );
    const found = readFollow(doc, doc.location.href, THREADS_SPEC);
    expect(found.post).toMatchObject({ url: POST, likes: 12, replies: 3, liked: false });
    const root = doc.querySelector('[data-pagelet] > div')!;
    expect(THREADS_SPEC.likeIn(root)?.liked).toBe(false);
    expect(THREADS_SPEC.replyIn(root)).not.toBeNull();
  });

  it('likes the post with its Like, done once its icon says Unlike', async () => {
    const doc = page(`${TH_MENU}${threadNow('dana.reyes', 'DQx7Ab12cd', 'Hello')}`, POST);
    const like = doc.querySelector('svg[title="Like"]')!.closest('[role="button"]')!;
    like.addEventListener('click', () => {
      const icon = like.querySelector('svg')!;
      icon.setAttribute('title', 'Unlike');
      icon.querySelector('title')!.textContent = 'Unlike';
    });
    expect(await likeTheirPost(THREADS_SPEC)(doc, POST, dana, { index: 0, url: POST })).toEqual({
      result: 'done',
      postUrl: POST,
    });
    expect(
      await likeTheirPost(THREADS_SPEC)(doc, POST, dana, { index: 0, url: POST }),
    ).toMatchObject({ result: 'already' });
  });

  it('replies in the box under the post, sent with its arrow named Reply, never the post’s own Reply', async () => {
    const doc = page(
      `${TH_MENU}${threadNow('dana.reyes', 'DQx7Ab12cd', 'Who do you use?', { under: UNDER })}`,
      POST,
    );
    const sent: string[] = [];
    const box = wireUnder(doc, sent);
    let opened = 0;
    doc
      .querySelector('svg[title="Reply"]')!
      .closest('[role="button"]')!
      .addEventListener('click', () => opened++);
    // The box empty, nothing beside it sends: the post's own Reply is never taken for its button.
    expect(THREADS_SPEC.sendFor(box())).toBeNull();
    const on = { profile: dana, postUrl: POST };
    const text = 'We follow up for you by text. Happy to show you how.';
    box().textContent = 'the person’s own words';
    expect(await writeTheirComment(THREADS_SPEC)(doc, POST, text, on)).toBe('not_sent');
    box().textContent = '';
    expect(await writeTheirComment(THREADS_SPEC)(doc, POST, text, on)).toBe('done');
    expect(sent).toEqual([text]);
    expect(opened).toBe(0);
  });

  it('takes what it typed out of the box under the post again when no arrow shows to send it', async () => {
    const doc = page(
      `${TH_MENU}${threadNow('dana.reyes', 'DQx7Ab12cd', 'Who do you use?', { under: UNDER })}`,
      POST,
    );
    const sent: string[] = [];
    const box = wireUnder(doc, sent, { arrow: false });
    const text = 'Happy to show you how we do it.';
    expect(
      await writeTheirComment(THREADS_SPEC)(doc, POST, text, { profile: dana, postUrl: POST }),
    ).toBe('none');
    expect(box().textContent).toBe('');
    expect(sent).toEqual([]);
    // Real waits: 3 s for an arrow that never shows, then emptying the box. Over vitest's 5 s on a busy runner.
  }, 15_000);

  it('with no box under the post, replies in the one its own Reply opens over it, sent with Post', async () => {
    const doc = page(`${TH_MENU}${threadNow('dana.reyes', 'DQx7Ab12cd', 'Who do you use?')}`, POST);
    const sent: string[] = [];
    doc
      .querySelector('svg[title="Reply"]')!
      .closest('[role="button"]')!
      .addEventListener('click', () => {
        doc.body.insertAdjacentHTML(
          'beforeend',
          `<div role="dialog"><div><div contenteditable="true" role="textbox" aria-label="Empty text field. Type to compose a new post."></div></div>
            <div><span>Anyone can reply &amp; quote</span><div role="button">Post</div></div></div>`,
        );
        const box = () => doc.querySelector<HTMLElement>('[role="dialog"] [contenteditable]')!;
        doc.execCommand = (_c: string, _u?: boolean, words?: string) => {
          box().textContent = words ?? '';
          return true;
        };
        doc.querySelector('[role="dialog"] [role="button"]')!.addEventListener('click', () => {
          sent.push(box().textContent ?? '');
          doc.querySelector('[role="dialog"]')!.remove();
        });
      });
    const text = 'Happy to show you how we do it.';
    expect(
      await writeTheirComment(THREADS_SPEC)(doc, POST, text, { profile: dana, postUrl: POST }),
    ).toBe('done');
    expect(sent).toEqual([text]);
  });

  it('Check Threads finds the post’s Like and its box to reply in, pressing neither', async () => {
    const doc = page(
      `${TH_MENU}${threadNow('dana.reyes', 'DQx7Ab12cd', 'Who do you use?', { under: UNDER })}`,
      POST,
    );
    const sent: string[] = [];
    const box = wireUnder(doc, sent);
    let pressed = 0;
    for (const button of doc.querySelectorAll('[data-pagelet] [role="button"]'))
      button.addEventListener('click', () => pressed++);
    const like = await THREADS.looks.like!.look(doc, POST);
    expect(like).toMatchObject({ works: true, found: { like: true, liked: false } });
    const comment = await THREADS.looks.comment!.look(doc, POST);
    expect(comment).toMatchObject({
      works: true,
      found: { box: true, opened: false, typed: true, send: 1, emptied: true },
    });
    expect(box().textContent).toBe('');
    expect(sent).toEqual([]);
    expect(pressed).toBe(0);
  });
});
