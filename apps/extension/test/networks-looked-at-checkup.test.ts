/**
 * Check Instagram and Check Alignable (src/jobs/looking.ts, docs/outreach.md decision 78): one press reads the
 * network's main pages, with its window in front, notes each with its outline, and looks for each step's button on the
 * page it's for, never pressing the last; Alignable's starts on its signed-in pages and follows their menus, never to
 * Log Out or Upgrade. On small pages written here by hand, drawn as the owner's first Checks read them (17 Oct 2026).
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { KITS } from '../src/networks';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';

// A person's pace between pages, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const IG = 'https://www.instagram.com';
const AL = 'https://www.alignable.com';

const html = (body: string, title = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const IG_MENU = `<div><a href="/" role="link"><span>Home</span></a>
  <a href="/direct/inbox/" role="link"><span>Messages</span></a>
  <a href="/casey.owner/" role="link"><img alt="casey.owner's profile picture" /><span>Profile</span></a></div>`;

/** An account's header, with its first button: Follow, or Following beside its arrow. */
const igProfile = (name: string, button: string, post: string) =>
  html(`${IG_MENU}<main role="main"><header><h2>${name}</h2>
    <button type="button"><div><div dir="auto">${button}</div>
      <svg aria-label="Down chevron icon"><title>Down chevron icon</title></svg></div></button>
    <div role="button">Message</div></header><a href="/p/${post}/">a post</a></main>`);

const INSTAGRAM_PAGES: Record<string, string> = {
  [`${IG}/`]: html(`${IG_MENU}<main role="main"><article><a href="/dana.reyes/">dana.reyes</a>
    <a href="/p/C9xYz12AbCd/"><time>3h</time></a></article></main>`),
  [`${IG}/casey.owner/`]: html(
    `${IG_MENU}<main role="main"><header><h2>casey.owner</h2><a href="/accounts/edit/">Edit profile</a></header></main>`,
  ),
  [`${IG}/accounts/edit/`]: html(
    `<main><form><label for="pepBio">Bio</label><textarea id="pepBio"></textarea><button>Submit</button></form></main>`,
  ),
  [`${IG}/explore/search/keyword/?q=small%20business`]: html(
    `${IG_MENU}<main role="main"><a href="/sam.carter/">sam.carter</a><a href="/p/D1aBc34DeFg/">post</a></main>`,
  ),
  [`${IG}/dana.reyes/`]: igProfile('dana.reyes', 'Follow', 'E2bCd45EfGh').replace(
    '<a href="/p/',
    '<a href="/dana.reyes/reel/R0aBc12XyZq/">a reel</a><a href="/p/',
  ),
  [`${IG}/p/E2bCd45EfGh/`]: html(`<main role="main"><article>
    <div role="button"><svg aria-label="Like"><title>Like</title></svg></div>
    <form><textarea aria-label="Add a comment…" placeholder="Add a comment…"></textarea></form></article></main>`),
  [`${IG}/explore/people/`]: html(`${IG_MENU}<main role="main"><h1>Suggested</h1>
    <div><a href="/lee.park/">lee.park</a><button>Follow</button></div></main>`),
  [`${IG}/lee.park/`]: igProfile('lee.park', 'Follow', 'F3cDe56FgHi'),
  [`${IG}/direct/inbox/`]: html(`${IG_MENU}<main role="main"><h1>Messages</h1></main>`),
};

/** What Instagram's pages do when pressed or written in: Message opens a chat; Post shows once something's written. */
function instagramDoes(doc: Document) {
  for (const message of doc.querySelectorAll('header [role="button"]'))
    if (message.textContent === 'Message')
      message.addEventListener('click', () => {
        const chat = doc.createElement('div');
        chat.innerHTML = `<div role="button" aria-label="Close"></div>
          <div role="textbox" contenteditable="true" aria-label="Message"></div>`;
        chat.querySelector('[aria-label="Close"]')!.addEventListener('click', () => chat.remove());
        doc.body.append(chat);
      });
  const box = doc.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Add a comment"]');
  box?.addEventListener('input', () => {
    doc.querySelector('[data-post]')?.remove();
    if (box.value) box.insertAdjacentHTML('afterend', '<div role="button" data-post>Post</div>');
  });
}

const ALIGNABLE_MENU = `<header><nav>
  <a href="/">Home</a><a href="/network">My Network</a><a href="/inbox">Messages</a>
  <a href="/forum">Forum</a><a href="/upgrade">Upgrade</a><a href="/logout">Log Out</a>
  <a href="/me">My Profile</a>
</nav></header>`;

const ALIGNABLE_PAGES: Record<string, string> = {
  [`${AL}/biz`]: html(
    `${ALIGNABLE_MENU}<main><div><button>Like</button><button>Comment</button></div></main>`,
  ),
  [`${AL}/network`]: html(`${ALIGNABLE_MENU}<main>
    <div><a href="/austin-tx/acme-plumbing/dana-reyes">Dana Reyes</a><button>Connect</button></div></main>`),
  [`${AL}/inbox`]: html(`${ALIGNABLE_MENU}<main><button>New Message</button></main>`),
  [`${AL}/forum`]: html(
    `${ALIGNABLE_MENU}<main><h1>Forum</h1><a href="/austin-tx/forum/12/need-a-plumber">Need a plumber?</a></main>`,
  ),
  [`${AL}/me`]: html(`${ALIGNABLE_MENU}<main><h1>My Profile</h1></main>`),
  [`${AL}/austin-tx/acme-plumbing/dana-reyes`]: html(
    `${ALIGNABLE_MENU}<main><button>Connect</button><button>Message</button><button>Recommend</button></main>`,
  ),
  // The person's own profile, as the owner's own profile drew it (0.62.0): its Elevator Pitch, My Ideal Customer, and
  // the Edit links to About Us's page and their details'.
  [`${AL}/biz/businesses/my_profile`]: html(`${ALIGNABLE_MENU}<main>
    <span><a href="/biz/users/77/edit"><img alt="Casey Owner profile picture" /></a></span>
    <h1 title="Casey Owner">Casey Owner</h1><h2 title="Owner">Owner</h2>
    <div data-testid="ideal-customer-information"><h1>My Ideal Customers</h1>
      <div data-testid="ideal-customer-add-description"><span>Say who you serve.</span><button>Add</button></div></div>
    <div><div><div>About Us</div><div><button data-testid="elevator-pitch-cta-button"><p>Add Your Elevator Pitch</p></button>
      <a href="/biz/profile/about_us?source=profile">Edit</a></div></div><p>We fix roofs in Columbus.</p></div></main>`),
  // About Us's page, drawn a moment after it opens.
  [`${AL}/biz/profile/about_us`]: html(`<main></main>`),
  [`${AL}/biz/users/77/edit`]: html(
    `<main><form><label for="f">First Name</label><input id="f" type="text" value="Casey" /><button>Save</button></form></main>`,
  ),
  // The pages its steps and Find partners are built from next, drawn as the owner's Check found them (0.66.0): their
  // town's own group with a post, a search's results, a forum question with an answer and its box, My Network's rows
  // and its Requests tab in its own menu, and a chat with a connection.
  [`${AL}/austin-tx`]: html(`${ALIGNABLE_MENU}<section>
    <h1 data-testid="group-header/header-text">Austin Business Owners</h1>
    <div><div><div><a aria-label="Go to Dana Reyes’s profile" href="/austin-tx/acme-plumbing?user=5"></a></div>
      <div><a href="/austin-tx/acme-plumbing?user=5"><span>Dana Reyes</span><span>at</span><span>Acme Plumbing</span></a>
        <div><span>Posted in</span><a href="/groups/austin-tx/need-a-roofer"><span>4h</span></a></div></div></div>
      <div><div title="Need a roofer"><span>Can anyone recommend a roofer?</span></div></div>
      <div><div><a href="/biz/likes?resource=9"><span>3</span><span>Like</span></a></div>
        <div><a href="/biz/discussions/91">Comment</a><a href="/biz/likes"><div>Like</div></a>
          <a href="/biz/connection_requests/quick?business_id=42&discussion_id=91&type=mgc"><div>Connect</div></a></div></div></div>
  </section>`),
  [`${AL}/biz/search?q=small%20business`]:
    html(`${ALIGNABLE_MENU}<section><div role="contentinfo"><ul>
    <div><a href="/austin-tx/acme-plumbing?user=5&result_id=42"><img alt="Dana Reyes" /></a>
      <div><div><div><a title="Dana Reyes" href="/austin-tx/acme-plumbing?user=5&result_id=42">Dana Reyes</a></div>
        <div><div><a title="Acme Plumbing" href="/austin-tx/acme-plumbing?user=5&result_id=42">Acme Plumbing</a>
          <span>Plumbing</span></div><div>Austin, TX</div></div></div>
      <a data-testid="react-connect-button" href="/biz/connection_requests/quick?business_id=42&result_id=42">Connect</a></div></div>
  </ul></div></section>`),
  [`${AL}/austin-tx/forum/12/need-a-plumber`]: html(`${ALIGNABLE_MENU}<section>
    <div><div><a href="/austin-tx/best-bakery?user=6"><span>Sam Lee</span><span>at</span><span>Best Bakery</span></a>
      <span>4h</span></div>
      <p>Need a plumber in Austin?</p>
      <div><a href="/biz/discussions/12">Comment</a><button>Like</button></div></div>
    <div data-testid="discussion-comment"><a href="/austin-tx/acme-plumbing?user=5">Dana Reyes</a><span>5h</span>
      <div data-testid="discussion-comment-body">We can help.</div><button>Reply</button><button>Like</button>
      <a href="/biz/connection_requests/quick?business_id=42&request_source=discussionpost_1&type=mgc">Connect</a></div>
    <form data-testid="discussion-comment-reply-form"><textarea placeholder="Write an answer"></textarea>
      <button>Send</button></form>
  </section>`),
  [`${AL}/biz/my_network`]: html(`${ALIGNABLE_MENU}<nav>
    <a href="/biz/my_network?_fat=a"><span>My Connections</span></a>
    <a href="/biz/my_network/received?_fat=a"><span>Requests</span></a></nav><section>
    <div data-testid="connection-row">
      <a aria-label="Best Bakery" data-testid="connection-row-profile-link" href="/biz/businesses/43"><img alt="Sam Lee" /></a>
      <div data-testid="connection-row-summary"><div><span>Sam Lee</span><span>Best Bakery</span></div></div>
      <a data-testid="connection-row-cta" href="/biz/conversations?with_business_id=42">Message</a></div></section>`),
  [`${AL}/biz/my_network/received?_fat=a`]: html(`${ALIGNABLE_MENU}<main>
    <a href="/austin-tx/best-bakery">Best Bakery</a><button>Accept</button><button>Ignore</button></main>`),
  [`${AL}/biz/conversations?with_business_id=42`]: html(`${ALIGNABLE_MENU}<div data-testid="inbox">
    <div data-testid="conversationInSidebar"><div><img alt="" /><div><div>Sam Lee</div><div>See you Tuesday</div></div></div>
      <span data-testid="conversationDate">Oct 12</span></div>
    <div data-testid="channel-header-loaded"><a href="/biz/businesses/42?user=5"><div>Dana Reyes</div></a></div>
    <div data-testid="full-view-write-message"><div contenteditable="true"></div><textarea placeholder="Write a message"></textarea>
      <button aria-label="Send" data-testid="messaging-send-external"></button></div></div>`),
};

/** Where Alignable sends an address: their own profile, to their business's page in its town. */
const ALIGNABLE_REDIRECTS: Record<string, string> = {
  [`${AL}/biz/businesses/my_profile`]: `${AL}/austin-tx/acme-roofing?user=7`,
};

/** What Alignable's pages draw a moment after they open, on the second read. */
const ALIGNABLE_DRAWS: Record<string, (doc: Document) => void> = {
  [`${AL}/biz/profile/about_us`]: (doc) => {
    doc.querySelector('main')!.innerHTML = `<form><label for="a">About Us</label>
      <textarea id="a">We fix roofs in Columbus.</textarea><button>Save Changes</button></form>`;
  },
};

/** What their own profile's editors do: the Elevator Pitch opens a box in a dialog, My Ideal Customer one in place. */
function alignableDoes(doc: Document) {
  doc.querySelector('[data-testid="elevator-pitch-cta-button"]')?.addEventListener('click', () => {
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `<textarea aria-label="Elevator Pitch"></textarea><button>Save</button><button>Cancel</button>`;
    dialog.querySelectorAll('button')[1]!.addEventListener('click', () => dialog.remove());
    doc.body.append(dialog);
  });
  const part = doc.querySelector('[data-testid="ideal-customer-add-description"]');
  part?.querySelector('button')?.addEventListener('click', () => {
    const editor = doc.createElement('div');
    editor.innerHTML = `<textarea placeholder="Describe your ideal customer"></textarea><button>Cancel</button>`;
    editor.querySelector('button')!.addEventListener('click', () => editor.remove());
    part.append(editor);
  });
}

/** A tab on a network still looked at, opening the pages above by address; it reads and looks as the tab does. */
function fakeTab(
  pages: Record<string, string>,
  platform: 'instagram' | 'alignable',
  redirects: Record<string, string> = platform === 'alignable' ? ALIGNABLE_REDIRECTS : {},
) {
  const kit = KITS[platform];
  let doc: Document | null = null;
  let at = '';
  const opened: string[] = [];
  const asked: string[] = [];
  const order: string[] = [];
  let reads = 0;
  const tab = {
    async open(url: string) {
      const page = pages[url];
      if (!page) throw new Error(`Not expected: ${url}`);
      opened.push(url);
      at = redirects[url] ?? url;
      reads = 0;
      doc = new JSDOM(page, { url: at }).window.document;
      if (platform === 'instagram') instagramDoes(doc);
      else alignableDoes(doc);
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      order.push('in front');
      const out = await work();
      order.push('back');
      return out;
    },
    async ask(message: { readonly type: string; readonly step?: string }) {
      asked.push(message.type);
      if (!doc) return { ok: false, error: 'closed' };
      if (message.type === 'hfos-read') {
        if (++reads === 2) ALIGNABLE_DRAWS[at]?.(doc);
        return { ok: true, result: kit.readPage(doc, at) };
      }
      if (message.type === 'hfos-outline')
        return {
          ok: true,
          result: kit.readPage(doc, at),
          outline: kit.outline(doc, at),
          shown: true,
        };
      if (message.type === 'hfos-try' || message.type === 'hfos-own-profile') {
        // As the tab answers it (src/networks/looking/kit.ts), on this page.
        vi.stubGlobal('location', new URL(at));
        vi.stubGlobal('document', doc);
        try {
          return await kit.work!(message);
        } finally {
          vi.unstubAllGlobals();
        }
      }
      return { ok: false, error: `Not expected: ${message.type}` };
    },
  } as unknown as JobTab;
  return { tab, opened, asked, order };
}

async function checkOn(platform: 'instagram' | 'alignable') {
  const { tab, opened, asked, order } = fakeTab(
    platform === 'instagram' ? INSTAGRAM_PAGES : ALIGNABLE_PAGES,
    platform,
  );
  const notes: ReportNote[] = [];
  const job: Job = {
    tab,
    hfos: (async () => {
      throw new Error('A Check saves nothing in HandsFreeOS but its notes.');
    }) as unknown as Hfos,
    businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    report: async (note = {}) => void notes.push(note),
  };
  const end = await runAsk({ kind: 'checkup' }, job, platform);
  return { end, notes, opened, asked, order };
}

describe('Check Instagram', () => {
  it('reads its main pages and tries each step up to its last press, pressing none of those', async () => {
    const { end, notes, opened, asked, order } = await checkOn('instagram');
    expect(order).toEqual(['in front', 'back']);
    expect(opened).toEqual([
      `${IG}/`,
      `${IG}/casey.owner/`,
      `${IG}/accounts/edit/`,
      `${IG}/explore/search/keyword/?q=small%20business`,
      `${IG}/dana.reyes/`,
      `${IG}/p/E2bCd45EfGh/`,
      `${IG}/direct/inbox/`,
    ]);
    // It reads (their own account too, as the AI's check would), and tries: nothing else is asked of the tab.
    expect(new Set(asked)).toEqual(new Set(['hfos-read', 'hfos-own-profile', 'hfos-try']));
    expect(notes.filter((n) => n.job?.startsWith('checkup.')).map((n) => n.job)).toEqual([
      'checkup.bio',
      'checkup.follow',
      'checkup.message',
      'checkup.like',
      'checkup.comment',
      'checkup.summary',
    ]);
    expect(notes.find((n) => n.job === 'checkup.message')?.found).toMatchObject({
      box: true,
      closed: true,
    });
    expect(notes.find((n) => n.job === 'checkup.comment')?.found).toMatchObject({
      post: 1,
      emptied: true,
    });
    expect(notes.at(-1)!.found).toEqual({ pages: 7, steps: 5, working: 5 });
    expect(end).toEqual({
      line: 'Read 7 Instagram pages and tried 5 steps up to their last press. Everything works.',
      warned: false,
    });
  });

  it('looks for Follow on an account Instagram suggests when they follow the first one already', async () => {
    const pages = { ...INSTAGRAM_PAGES };
    pages[`${IG}/dana.reyes/`] = igProfile('dana.reyes', 'Following', 'E2bCd45EfGh');
    const { tab, opened } = fakeTab(pages, 'instagram');
    const notes: ReportNote[] = [];
    const job = {
      tab,
      hfos: (async () => ({ ok: true, value: {} })) as unknown as Hfos,
      businessId: 'b',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
      report: async (note: ReportNote = {}) => void notes.push(note),
    } satisfies Job;
    const end = await runAsk({ kind: 'checkup' }, job, 'instagram');
    expect(opened.slice(-3)).toEqual([
      `${IG}/explore/people/`,
      `${IG}/lee.park/`,
      `${IG}/direct/inbox/`,
    ]);
    expect(notes.filter((n) => n.job === 'checkup.follow').map((n) => n.found?.works)).toEqual([
      false,
      true,
    ]);
    expect(end.line).toBe(
      'Read 9 Instagram pages and tried 5 steps up to their last press. Everything works.',
    );
  });

  it('ends at once when Instagram asks them to sign in', async () => {
    const pages = {
      [`${IG}/`]: html(
        `<main><form><input name="username" /><input type="password" /></form></main>`,
      ),
    };
    const { tab, opened } = fakeTab(pages, 'instagram');
    const job = {
      tab,
      hfos: (async () => ({ ok: true, value: {} })) as unknown as Hfos,
      businessId: 'b',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
      report: async () => undefined,
    } satisfies Job;
    expect(await runAsk({ kind: 'checkup' }, job, 'instagram')).toEqual({
      line: 'Instagram asked you to sign in. Sign in to Instagram in this browser, then press Check Instagram again.',
      warned: false,
      failed: true,
    });
    expect(opened).toEqual([`${IG}/`]);
  });
});

describe('Check Alignable', () => {
  it('starts on its signed-in pages and follows their menus, never to Log Out or Upgrade', async () => {
    const { end, notes, opened } = await checkOn('alignable');
    expect(opened).toEqual([
      `${AL}/biz`,
      `${AL}/network`,
      `${AL}/inbox`,
      `${AL}/forum`,
      `${AL}/me`,
      // Their own profile, then the pages its Edit links open: About Us's, and their details' (decision 80).
      `${AL}/biz/businesses/my_profile`,
      // Its Edit link's address is opened without what it says it came from.
      `${AL}/biz/profile/about_us`,
      `${AL}/biz/users/77/edit`,
      `${AL}/austin-tx/acme-plumbing/dana-reyes`,
      // Then what its steps and Find partners are built from (0.66.0): their town, from their business's address, a
      // search, the forum question a page linked to, their connection requests, and a chat with a connection.
      `${AL}/austin-tx`,
      `${AL}/biz/search?q=small%20business`,
      `${AL}/austin-tx/forum/12/need-a-plumber`,
      `${AL}/biz/my_network`,
      `${AL}/biz/my_network/received?_fat=a`,
      `${AL}/biz/conversations?with_business_id=42`,
    ]);
    for (const never of ['/', '/logout', '/upgrade']) expect(opened).not.toContain(`${AL}${never}`);
    // Nothing is written in the chat or the answer's box, and nothing's pressed there.
    expect(notes.find((n) => n.job === 'checkup.summary')?.found).not.toHaveProperty('nothingRead');
    // One note of each step, its best: found on the page it was first found on.
    const steps = notes.filter((n) => n.job?.startsWith('checkup.') && n.job !== 'checkup.summary');
    expect(steps.map((n) => [n.job, n.found?.works])).toEqual([
      // Their own profile's editors, opened and closed with nothing written, and About Us's page once it's drawn.
      ['checkup.pitch', true],
      ['checkup.ideal', true],
      ['checkup.about', true],
      ['checkup.connect', true],
      ['checkup.message', true],
      ['checkup.recommend', true],
      ['checkup.like', true],
      ['checkup.comment', true],
    ]);
    // Each editor's note keeps its outline while it was open.
    expect(notes.find((n) => n.job === 'checkup.pitch')).toMatchObject({ outline: true });
    expect(notes.find((n) => n.job === 'checkup.pitch')?.outlineText).toContain('dialog');
    expect(notes.find((n) => n.job === 'checkup.about')?.found).toMatchObject({
      box: true,
      save: 1,
    });
    // Their profile as the AI's check reads it: what was found, never what it says.
    expect(notes.find((n) => n.found?.about === true && n.found?.name === true)).toBeTruthy();
    expect(end.line).toBe(
      'Read 15 Alignable pages and tried 8 steps up to their last press. Everything works.',
    );
  });

  it('opens its public home page too when the signed-in one’s menus have nothing worth a look', async () => {
    const pages = {
      ...ALIGNABLE_PAGES,
      [`${AL}/biz`]: html(`<header><nav><a href="/biz/zq">Zq</a></nav></header><main></main>`),
      [`${AL}/`]: html(`${ALIGNABLE_MENU}<main><h1>The referral network</h1></main>`),
      [`${AL}/biz/zq`]: html(`<main></main>`),
    };
    const { tab, opened } = fakeTab(pages, 'alignable');
    const job = {
      tab,
      hfos: (async () => ({ ok: true, value: {} })) as unknown as Hfos,
      businessId: 'b',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
      report: async () => undefined,
    } satisfies Job;
    await runAsk({ kind: 'checkup' }, job, 'alignable');
    // Its menu's places worth a look first, then the one it couldn't tell.
    expect(opened.slice(0, 4)).toEqual([`${AL}/biz`, `${AL}/`, `${AL}/network`, `${AL}/inbox`]);
    expect(opened).toContain(`${AL}/biz/zq`);
  });

  it('says which steps it found nowhere, with what each page had instead', async () => {
    const pages = { ...ALIGNABLE_PAGES };
    pages[`${AL}/austin-tx/acme-plumbing/dana-reyes`] = html(
      `${ALIGNABLE_MENU}<main><button>Connect</button></main>`,
    );
    const { tab } = fakeTab(pages, 'alignable');
    const notes: ReportNote[] = [];
    const job = {
      tab,
      hfos: (async () => ({ ok: true, value: {} })) as unknown as Hfos,
      businessId: 'b',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
      report: async (note: ReportNote = {}) => void notes.push(note),
    } satisfies Job;
    const end = await runAsk({ kind: 'checkup' }, job, 'alignable');
    expect(notes.find((n) => n.job === 'checkup.recommend')).toMatchObject({
      note: 'Recommending: no Recommend on the page.',
      outline: false,
    });
    expect(end.line).toBe(
      'Read 15 Alignable pages and tried 8 steps up to their last press. Not working: recommending.',
    );
  });
});
