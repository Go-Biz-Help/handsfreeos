/**
 * Instagram's own readers (src/networks/instagram/read.ts; the Instagram and Alignable plan's part 10): someone's
 * profile and a post on pages drawn as the owner's Check Instagram outlined them (0.62.0, 18 Oct 2026), with
 * Instagram's own words, labels, roles and link shapes where it put them; their followers, a hashtag, a place, their
 * notifications, their messages and a chat from Instagram's usual markup, till his next Check outlines them. What a
 * report of each says: how many of each, never what they say.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { pageFound } from '../src/jobs/report';
import { readInstagram } from '../src/networks/instagram/read';
import { INSTAGRAM } from '../src/networks/instagram/site';
import { readLooking } from '../src/networks/looking/read';

const IG = 'https://www.instagram.com';
const page = (path: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: `${IG}${path}` }).window
    .document;
const read = (doc: Document) => readInstagram(doc, doc.location.href);

/** The menu down the side, with the person's own Profile (me.owner). */
const MENU = `<div><a role="link" href="/"><span>Home</span></a>
  <a role="link" href="/direct/inbox/"><span>Messages</span></a>
  <a role="link" href="/me.owner/"><span role="link"><img alt="me.owner's profile picture"></span><span dir="auto"><span>Profile</span></span></a></div>`;

/** Someone's profile as the owner's Check outlined it: the header's sections, then their posts. */
const profile = (buttons: string, more = '') =>
  page(
    '/dana.reyes/',
    `${MENU}<section><main role="main"><div>
      <header><div>
        <section><a role="link" href="/dana.reyes/"><img alt="dana.reyes's profile picture"></a></section>
        <section><div><div><div>
          <a role="link" href="#"><h2 dir="auto"><span>dana.reyes</span></h2></a>
          <svg role="img" aria-label="Verified"></svg>
          <div role="button" aria-expanded="false"><svg role="img" aria-label="Options"></svg></div></div>
          <span dir="auto">Dana Reyes</span>
          <div><span dir="auto"><span>504</span> posts</span>
            <a role="link" href="#"><span dir="auto"><span title="321,861"><span>321K</span></span> followers</span></a>
            <a role="link" href="#"><span dir="auto"><span>1,769</span> following</span></a></div></div></div></section></div>
        <section><div><div><div dir="auto">Plumber</div>
          <span dir="auto"><div role="button"><span dir="auto">Fixing Austin leaks since 2009</span></div></span></div>
          <a role="link" href="/dana.reyes/followers/mutualOnly"><span dir="auto">Followed by sam.lee and 2 others</span></a></div></section>
        <section><div>${buttons}<div role="button"><svg role="img" aria-label="Similar accounts"></svg></div></div></section>
        ${more}
      </header>
      <div role="tablist"><a role="link" aria-selected="true" href="/dana.reyes/"><svg role="img" aria-label="Posts"></svg></a>
        <a role="link" aria-selected="false" href="/dana.reyes/reels/"><svg role="img" aria-label="Reels"></svg></a></div>
      <div><div><a role="link" href="/dana.reyes/p/C1aaaaaaa/"><img alt="A new water heater"></a>
        <a role="link" href="/dana.reyes/reel/C2bbbbbbb/"><img alt="Before and after"></a>
        <a role="link" href="/dana.reyes/p/C1aaaaaaa/"><img alt="again"></a></div></div>
    </div></main></section>`,
  );

const FOLLOWING = `<button><div><div dir="auto">Following</div><svg role="img" aria-label="Down chevron icon"></svg></div></button>
  <div role="button">Message</div>`;

describe('someone’s profile on Instagram', () => {
  it('reads their name and username, that you follow them, their followers and their latest posts', () => {
    expect(read(profile(FOLLOWING)).profile).toEqual({
      username: 'dana.reyes',
      url: `${IG}/dana.reyes/`,
      name: 'Dana Reyes',
      following: 'following',
      followsYou: null,
      followers: 321_861,
      posts: [`${IG}/p/C1aaaaaaa/`, `${IG}/reel/C2bbbbbbb/`],
    });
  });

  it('reads Follow Back and Follows you as following you, and Requested as asked', () => {
    const back = read(profile('<button><div dir="auto">Follow Back</div></button>')).profile!;
    expect([back.following, back.followsYou]).toEqual(['no', true]);
    const follow = read(profile('<button><div dir="auto">Follow</div></button>')).profile!;
    expect([follow.following, follow.followsYou]).toEqual(['no', false]);
    const asked = read(
      profile(
        '<button><div dir="auto">Requested</div></button>',
        '<section><span dir="auto">Follows you</span></section>',
      ),
    ).profile!;
    expect([asked.following, asked.followsYou]).toEqual(['requested', true]);
  });

  it('reads no profile on the person’s own account, nor on a page that isn’t one', () => {
    const own = page(
      '/me.owner/',
      `${MENU}<main><header><section><h2>me.owner</h2><a href="/accounts/edit/">Edit profile</a></section></header></main>`,
    );
    expect(read(own).profile).toBeNull();
    expect(read(page('/explore/', `${MENU}<main></main>`)).profile).toBeNull();
  });
});

/** A row of the person's followers list, as Instagram draws it in the box over their profile. */
const follower = (username: string, name: string, extra: string) =>
  `<div><a role="link" href="/${username}/"><img alt="${username}'s profile picture"></a>
    <div><div><a role="link" href="/${username}/"><span dir="auto">${username}</span></a>${extra}</div>
      <span dir="auto">${name}</span></div>
    <div><button><div dir="auto">Remove</div></button></div></div>`;

describe('your followers on Instagram', () => {
  const list = () =>
    page(
      '/me.owner/followers/',
      `${MENU}<main><header><h2>me.owner</h2></header></main>
      <div role="dialog"><div><h1>Followers</h1><input placeholder="Search"><div>
        ${follower('dana.reyes', 'Dana Reyes', '<span>·</span><div role="button">Follow</div>')}
        ${follower('sam.lee', 'Sam Lee', '')}
        ${follower('kim_bakes', '', '')}
      </div></div></div>`,
    );

  it('reads each with their username, name and link, and whether you follow them back', () => {
    expect(read(list()).followers).toEqual([
      { username: 'dana.reyes', url: `${IG}/dana.reyes/`, name: 'Dana Reyes', followBack: false },
      { username: 'sam.lee', url: `${IG}/sam.lee/`, name: 'Sam Lee', followBack: true },
      { username: 'kim_bakes', url: `${IG}/kim_bakes/`, name: null, followBack: true },
    ]);
  });

  it('reads them on the followers list alone, and counts them in a report, never their names', () => {
    expect(read(profile(FOLLOWING)).followers).toEqual([]);
    const doc = list();
    const found = pageFound(readLooking(doc, doc.location.href, INSTAGRAM));
    expect(found).toMatchObject({ followers: 3, followersName: 2, followersFollowBack: 2 });
    expect(JSON.stringify(found)).not.toContain('Dana');
  });
});

/** A post's own page as the owner's Check outlined it: its pictures, its header, its caption and comments, its bar. */
const POST = page(
  '/p/C3xyzabcd/',
  `${MENU}<section><main role="main"><div><div>
    <div><div role="presentation"><ul><li><div><div role="button"><img alt="photo"></div>
      <a role="link" href="/tagged.one/"><span><span>tagged.one</span></span></a></div></li></ul></div>
      <button aria-label="Next"></button></div>
    <div><div>
      <div><div role="button"><canvas></canvas><span role="link"><img alt="dana.reyes's profile picture"></span></div>
        <div><div><div><span dir="auto"><a role="link" href="/dana.reyes/"><span dir="auto">dana.reyes</span></a></span>
          <svg role="img" aria-label="Verified"></svg></div>
          <a role="link" href="/explore/locations/212988663/austin-texas/"><span>Austin, Texas</span></a></div>
          <div role="button">Following</div></div>
        <div role="button" aria-expanded="false"><svg role="img" aria-label="More options"></svg></div></div>
      <hr>
      <div>
        <div><div><a role="link" href="/dana.reyes/"><img alt=""></a>
          <div><span dir="auto"><div><div><a role="link" href="/dana.reyes/"><span dir="auto">dana.reyes</span></a>
            <span>•</span><time title="Jan 1, 2026">35w</time></div>
            <span>Fixed a leak for <a role="link" href="/sam.lee/">@sam.lee</a> today.<br>Call us any time.</span></div></span></div></div></div>
        <div><div><div><a role="link" href="/sam.lee/"><img alt=""></a>
          <div><div><div><div><span dir="auto"><a role="link" href="/sam.lee/"><span dir="auto">sam.lee</span></a></span>
            <span dir="auto"><a role="link" href="/p/C3xyzabcd/c/17900000000000001/"><time title="Oct 1, 2026">2w</time></a></span></div>
            <span dir="auto">Great work, thank you!</span></div>
            <div><div role="button"><span dir="auto"><span>3 likes</span></span></div>
              <div role="button"><span dir="auto"><span>Reply</span></span></div></div></div>
            <div role="button" id="comment-like"><svg role="img" aria-label="Like"></svg></div></div></div></div>
          <div role="button"><div><span dir="auto">View replies (1)</span></div></div></div>
        <div><div><div><a role="link" href="/kim_bakes/"><img alt=""></a>
          <div><div><div><div><span dir="auto"><a role="link" href="/kim_bakes/"><span dir="auto">kim_bakes</span></a></span>
            <span dir="auto"><a role="link" href="/p/C3xyzabcd/c/17900000000000002/"><time>1w</time></a></span></div>
            <span dir="auto">Do you do water heaters?</span></div>
            <div><div role="button"><span dir="auto"><span>Reply</span></span></div></div></div>
            <div role="button"><svg role="img" aria-label="Like"></svg></div></div></div></div></div>
      </div>
      <div><section><div>
        <div role="button" id="post-like"><svg role="img" aria-label="Like"></svg></div>
        <div role="button"><svg role="img" aria-label="Comment"></svg></div><span role="button">56</span>
        <div role="button"><svg role="img" aria-label="Share"></svg></div></div>
        <div role="button"><div role="button"><svg role="img" aria-label="Save"></svg></div></div></section>
        <section><span dir="auto">Liked by <a role="link" href="/kim_bakes/"><span>kim_bakes</span></a> and
          <a role="link" href="/p/C3xyzabcd/liked_by/"><span>12 others</span></a></span></section>
        <div dir="auto"><a role="link" href="/dana.reyes/p/C3xyzabcd/"><span dir="auto"><time title="Oct 1, 2026">October 1</time></span></a></div></div>
      <section><div><span role="link"><img alt=""></span>
        <form><div><div role="button" aria-expanded="false"><svg role="img" aria-label="Emoji"></svg></div>
          <textarea aria-label="Add a comment…" placeholder="Add a comment…"></textarea></div>
          <div role="button" id="post-comment">Post</div></form></div></section>
    </div></div>
    <hr><div><div dir="auto">More posts from <a role="link" href="/dana.reyes/">dana.reyes</a></div>
      <div><a role="link" href="/dana.reyes/p/C9other12/"><img alt="other"></a></div></div>
  </div></main></section>`,
);

describe('a post on Instagram', () => {
  it('reads who posted it, its link, caption, likes, comments and place', () => {
    expect(read(POST).post).toEqual({
      url: `${IG}/p/C3xyzabcd/`,
      author: { username: 'dana.reyes', url: `${IG}/dana.reyes/` },
      caption: 'Fixed a leak for @sam.lee today.\nCall us any time.',
      likes: 13,
      comments: [
        { username: 'sam.lee', url: `${IG}/sam.lee/`, text: 'Great work, thank you!' },
        { username: 'kim_bakes', url: `${IG}/kim_bakes/`, text: 'Do you do water heaters?' },
      ],
      place: { url: `${IG}/explore/locations/212988663/austin-texas/`, name: 'Austin, Texas' },
    });
  });

  it('reads its likes as Instagram prints them, and none when it hides them', () => {
    const counted = page(
      '/p/C3xyzabcd/',
      `<main><div dir="auto"><a href="/dana.reyes/p/C3xyzabcd/"><time>1d</time></a></div>
        <section><div role="button"><svg aria-label="Like"></svg></div><div role="button"><svg aria-label="Comment"></svg></div></section>
        <section><span>1,204 likes</span></section></main>`,
    );
    expect(read(counted).post?.likes).toBe(1204);
    const hidden = page(
      '/p/C3xyzabcd/',
      `<main><section><div role="button"><svg aria-label="Like"></svg></div><div role="button"><svg aria-label="Comment"></svg></div>
        <span role="button">56</span></section><section><span>Liked by <a href="/kim/">kim</a> and <a href="/p/C3xyzabcd/liked_by/">others</a></span></section></main>`,
    );
    expect(read(hidden).post?.likes).toBeNull();
  });

  it('counts its comments in a report, never what they say', () => {
    const found = pageFound(readLooking(POST, POST.location.href, INSTAGRAM));
    expect(found).toMatchObject({ post: true, postComments: true, postCaption: true });
    expect(JSON.stringify(found)).not.toContain('Great work');
  });
});

describe('a hashtag’s and a place’s posts on Instagram', () => {
  const grid = `<div><a href="/p/C1aaaaaaa/"><img alt=""></a><a href="/reel/C2bbbbbbb/"><img alt=""></a>
    <a href="/p/C1aaaaaaa/"><img alt=""></a></div>`;

  it('reads a hashtag’s posts’ links', () => {
    const doc = page(
      '/explore/tags/austinplumbing/',
      `<main><header><h1>#austinplumbing</h1></header>${grid}</main>`,
    );
    expect(read(doc).tag).toEqual({
      url: `${IG}/explore/tags/austinplumbing/`,
      name: 'austinplumbing',
      posts: [`${IG}/p/C1aaaaaaa/`, `${IG}/reel/C2bbbbbbb/`],
    });
    expect(read(doc).place).toBeNull();
  });

  it('reads a place’s name and its posts’ links', () => {
    const doc = page(
      '/explore/locations/212988663/austin-texas/',
      `<main><h1>Austin, Texas</h1>${grid}</main>`,
    );
    expect(read(doc).place).toEqual({
      url: `${IG}/explore/locations/212988663/austin-texas/`,
      name: 'Austin, Texas',
      posts: [`${IG}/p/C1aaaaaaa/`, `${IG}/reel/C2bbbbbbb/`],
    });
  });
});

describe('your notifications on Instagram', () => {
  it('reads who followed you, and who liked or commented on your posts, never what they wrote', () => {
    const doc = page(
      '/notifications/',
      `${MENU}<main><div>
        <div><a href="/dana.reyes/"><img alt=""></a>
          <span><a href="/dana.reyes/">dana.reyes</a> started following you. <time>2d</time></span>
          <button><div dir="auto">Follow Back</div></button></div>
        <div><a href="/sam.lee/"><img alt=""></a>
          <span><a href="/sam.lee/">sam.lee</a> liked your post. <time>3d</time></span>
          <a href="/p/C3xyzabcd/"><img alt=""></a></div>
        <div><a href="/kim_bakes/"><img alt=""></a>
          <span><a href="/kim_bakes/">kim_bakes</a> commented: Do you do water heaters? <time>4d</time></span>
          <a href="/p/C3xyzabcd/"><img alt=""></a></div>
        <div><span>Suggested for you</span><a href="/someone/">someone</a></div>
      </div></main>`,
    );
    expect(read(doc).engaged).toEqual([
      { username: 'dana.reyes', url: `${IG}/dana.reyes/`, kind: 'follow', post: null },
      { username: 'sam.lee', url: `${IG}/sam.lee/`, kind: 'reaction', post: `${IG}/p/C3xyzabcd/` },
      {
        username: 'kim_bakes',
        url: `${IG}/kim_bakes/`,
        kind: 'comment',
        post: `${IG}/p/C3xyzabcd/`,
      },
    ]);
    expect(JSON.stringify(read(doc))).not.toContain('water heaters');
  });
});

/** The list of chats beside their messages, as the owner's Check outlined it: rows that are buttons, not links. */
const CHATS = `<div role="navigation" aria-label="Thread list"><div role="button"><h2 dir="auto"><span>me.owner</span></h2></div>
  <div role="tablist"><div role="tab" aria-selected="TAB_PRIMARY"><span dir="auto"><span>Primary</span></span></div>
    <div role="tab" aria-selected="false"><span dir="auto"><span>General</span></span></div>
    <div role="tab" aria-selected="TAB_REQUESTS"><span dir="auto"><span>Requests</span></span></div></div>
  <ul><li><div role="button"><div><div>Notes</div><span dir="auto">Your note</span></div></div></li></ul>
  <div><div role="button"><div><div><img alt="user"></div><div><span dir="auto"><span title="Dana Reyes">Dana Reyes</span></span>
      <div><span dir="auto"><span>You: See you Tuesday</span></span><div><span><span aria-hidden="true">·</span></span>
        <span dir="auto"><abbr aria-label="3 days ago"><span>3d</span></abbr></span></div></div></div></div></div>
    <div role="button"><div><div><img alt="user"></div><div><span dir="auto"><span title="Sam Lee">Sam Lee</span></span>
      <div><span dir="auto"><span>Thanks, that works!</span></span><div><span><span aria-hidden="true">·</span></span>
        <span dir="auto"><abbr aria-label="1 week ago"><span>1w</span></abbr></span></div></div></div></div></div></div></div>`;

describe('your messages on Instagram', () => {
  it('reads each chat, whose the last line is, and which box shows', () => {
    const doc = page(
      '/direct/inbox/',
      `${MENU}<main><section>${CHATS.replace('TAB_PRIMARY', 'true').replace('TAB_REQUESTS', 'false')}</section></main>`,
    );
    expect(read(doc).chats).toEqual([
      {
        name: 'Dana Reyes',
        preview: 'You: See you Tuesday',
        yours: true,
        when: '3d',
        thread: null,
      },
      { name: 'Sam Lee', preview: 'Thanks, that works!', yours: false, when: '1w', thread: null },
    ]);
    expect(read(doc).box).toBe('primary');
    const requests = page('/direct/requests/', `${MENU}<main><section></section></main>`);
    expect(read(requests).box).toBe('requests');
  });
});

describe('a chat on Instagram', () => {
  const chat = (more = '') =>
    page(
      '/direct/t/340282366841710300/',
      `${MENU}<main><section>${CHATS.replace('TAB_PRIMARY', 'true').replace('TAB_REQUESTS', 'false')}
        <div><div><a role="link" href="/dana.reyes/"><img alt=""><span title="Dana Reyes">Dana Reyes</span></a>
          <div role="button" aria-label="Conversation information"><svg></svg></div></div>
        <div aria-label="Messages in conversation with Dana Reyes"><div role="grid">
          <div role="row"><div role="gridcell"><h5><span>You sent</span></h5><div dir="auto">Hi Dana, are you taking new clients?</div></div></div>
          <div role="row"><div role="gridcell"><a href="/dana.reyes/"><img alt="dana.reyes"></a><h5><span>Dana sent</span></h5>
            <div dir="auto">Yes, what do you need?</div></div></div>
          <div role="row"><div role="gridcell"><span>Seen</span></div></div>
        </div></div>
        ${more}
        <div><div role="textbox" contenteditable="true" aria-label="Message"></div></div></div></section></main>`,
    );

  it('reads who it’s with, its messages, theirs or yours, and its box', () => {
    expect(read(chat()).chat).toEqual({
      thread: '340282366841710300',
      with: { username: 'dana.reyes', url: `${IG}/dana.reyes/` },
      name: 'Dana Reyes',
      messages: [
        { from: 'me', text: 'Hi Dana, are you taking new clients?' },
        { from: 'them', text: 'Yes, what do you need?' },
      ],
      box: true,
      request: false,
    });
  });

  it('reads a request waiting for Accept', () => {
    const doc = chat(
      '<div><div role="button">Block</div><div role="button">Delete</div><div role="button">Accept</div></div>',
    );
    expect(read(doc).chat?.request).toBe(true);
  });

  it('counts its messages in a report, never what they say', () => {
    const doc = chat();
    const found = pageFound(readLooking(doc, doc.location.href, INSTAGRAM));
    expect(found).toMatchObject({ chat: true, chatMessages: true, chats: 2 });
    expect(JSON.stringify(found)).not.toContain('new clients');
  });
});
