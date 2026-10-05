/**
 * The side panel. It asks the Facebook tab beside it to read the page and shows what came back. Nothing is saved or
 * sent anywhere. "Copy page outline" and "Save page outline" give the page's shape with names and words hidden, to
 * send to whoever is tuning the readers when the panel gets a page wrong.
 */
import { runsGroup } from '../facebook/people';
import type {
  ChatPage,
  ChatSummary,
  GroupLink,
  GroupPage,
  Notice,
  PageKind,
  Person,
  Post,
  ProfilePage,
  ReadResult,
} from '../facebook/types';
import { facebookUrl } from '../facebook/urls';
import type { Answer, Ask } from '../messages';

const KIND: Record<PageKind, string> = {
  profile: 'A profile',
  friends: 'Friends',
  followers: 'Followers',
  following: 'Following',
  chats: 'Your chats',
  chat: 'A chat',
  groups: 'Your groups',
  group: 'A group',
  'group-members': 'A group’s members',
  search: 'Search results',
  notifications: 'Your notifications',
  post: 'A post',
  feed: 'Your feed',
  other: 'A page it doesn’t read yet',
};

const FRIENDSHIP: Record<ProfilePage['friendship'], string> = {
  self: 'This is you',
  friends: 'Friends',
  request_sent: 'You sent a friend request',
  request_received: 'They sent you a friend request',
  not_friends: 'Not friends',
  unknown: 'Couldn’t tell if you’re friends',
};

const NOTICE: Record<Notice['kind'], string> = {
  friend_accepted: 'Accepted',
  friend_request: 'Request',
  reaction: 'Reacted',
  comment: 'Commented',
  mention: 'Mentioned you',
  group: 'Group',
  other: 'Other',
};

/** Lists longer than this show their first part and say how many more there are. */
const SHOWN = 100;
/** How long the panel waits after the page changes before reading it, so Facebook can draw it. */
const SETTLE_MS = 1500;
const AUTO_READ = 'autoRead';

// ------------------------------------------------------------------------------------------------- drawing

type Child = Node | string | null | undefined | false;

/** An element with attributes and children. Text goes in as text, never as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    if (value !== undefined) element.setAttribute(name, value);
  for (const child of children)
    if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

/** A link to Facebook, opened in a new tab. Only Facebook's own addresses become links. */
function link(text: string, url: string | null | undefined): Node {
  if (!url || !facebookUrl(url)) return document.createTextNode(text);
  return h('a', { href: url, target: '_blank', rel: 'noreferrer' }, text);
}

function section(title: string, count: number | null, ...children: Child[]): HTMLElement {
  return h(
    'section',
    {},
    h('h2', {}, title, count === null ? null : h('span', { class: 'count' }, String(count))),
    ...children,
  );
}

function more(total: number): Child {
  return total > SHOWN ? h('p', { class: 'more' }, `And ${total - SHOWN} more.`) : null;
}

function chip(text: string, tone: 'plain' | 'warn' = 'plain'): HTMLElement {
  return h('span', { class: `chip ${tone}` }, text);
}

function profileView(profile: ProfilePage): HTMLElement {
  return section(
    profile.name ?? 'No name found',
    null,
    h(
      'p',
      {},
      chip(FRIENDSHIP[profile.friendship]),
      profile.mutualFriends !== null ? chip(`${profile.mutualFriends} mutual friends`) : null,
    ),
    profile.intro.length
      ? h('ul', { class: 'lines' }, ...profile.intro.map((line) => h('li', {}, line)))
      : h('p', { class: 'muted' }, 'No intro found.'),
    profile.profile
      ? h('p', { class: 'muted' }, link('Open the profile', profile.profile.url))
      : null,
  );
}

function groupView(group: GroupPage): HTMLElement {
  return section(
    group.name ?? 'No group name found',
    null,
    h(
      'p',
      {},
      group.privacy ? chip(group.privacy === 'public' ? 'Public' : 'Private') : null,
      group.members !== null ? chip(`${group.members.toLocaleString()} members`) : null,
      group.joined === true ? chip('You’re a member') : null,
      group.joined === false ? chip('Not joined') : null,
    ),
  );
}

function personView(person: Person): HTMLElement {
  return h(
    'li',
    {},
    h('div', { class: 'name' }, link(person.name, person.profile?.url)),
    person.detail ? h('div', { class: 'muted' }, person.detail) : null,
    person.badges.length || runsGroup(person)
      ? h(
          'div',
          {},
          runsGroup(person) ? chip('Runs the group: leave alone', 'warn') : null,
          ...person.badges
            .filter((badge) => !/^(admin|moderator)$/i.test(badge))
            .map((badge) => chip(badge)),
        )
      : null,
  );
}

function peopleView(people: readonly Person[]): HTMLElement {
  const items: HTMLElement[] = [];
  let part: string | null = null;
  for (const person of people.slice(0, SHOWN)) {
    if (person.section !== part && person.section)
      items.push(h('li', { class: 'part' }, person.section));
    part = person.section;
    items.push(personView(person));
  }
  return section(
    'People',
    people.length,
    h('ul', { class: 'list' }, ...items),
    more(people.length),
  );
}

function groupsView(groups: readonly GroupLink[]): HTMLElement {
  return section(
    'Groups',
    groups.length,
    h(
      'ul',
      { class: 'list' },
      ...groups
        .slice(0, SHOWN)
        .map((group) =>
          h(
            'li',
            {},
            h('div', { class: 'name' }, link(group.name, group.group.url)),
            group.detail ? h('div', { class: 'muted' }, group.detail) : null,
          ),
        ),
    ),
    more(groups.length),
  );
}

function postsView(posts: readonly Post[]): HTMLElement {
  return section(
    'Posts',
    posts.length,
    h(
      'ul',
      { class: 'list' },
      ...posts
        .slice(0, SHOWN)
        .map((post) =>
          h(
            'li',
            {},
            h(
              'div',
              { class: 'name' },
              post.author ? link(post.author.name, post.author.profile?.url) : 'Unknown author',
              post.when ? h('span', { class: 'muted' }, ` · ${post.when}`) : null,
            ),
            post.text ? h('p', { class: 'text' }, clip(post.text, 280)) : null,
            h(
              'div',
              { class: 'muted' },
              post.reactions !== null ? `${post.reactions} reactions` : null,
              post.reactions !== null && post.comments !== null ? ' · ' : null,
              post.comments !== null ? `${post.comments} comments` : null,
              post.url ? h('span', {}, ' · ', link('Open', post.url)) : null,
            ),
          ),
        ),
    ),
    more(posts.length),
  );
}

function chatView(chat: ChatPage): HTMLElement {
  const shown = chat.messages.slice(-SHOWN);
  return section(
    chat.name ? `Chat with ${chat.name}` : 'Chat',
    chat.messages.length,
    chat.profile ? h('p', { class: 'muted' }, link('Open their profile', chat.profile.url)) : null,
    chat.messages.length > SHOWN ? h('p', { class: 'more' }, `Showing the last ${SHOWN}.`) : null,
    h(
      'ul',
      { class: 'messages' },
      ...shown.map((message) =>
        h(
          'li',
          { class: `message ${message.from}` },
          h(
            'div',
            { class: 'who' },
            message.from === 'me'
              ? 'You'
              : message.from === 'them'
                ? (message.sender ?? 'Them')
                : 'Not sure who',
            message.when ? ` · ${message.when}` : '',
          ),
          h('div', { class: 'text' }, message.text),
        ),
      ),
    ),
  );
}

function chatsView(chats: readonly ChatSummary[]): HTMLElement {
  return section(
    'Chats',
    chats.length,
    h(
      'ul',
      { class: 'list' },
      ...chats
        .slice(0, SHOWN)
        .map((chat) =>
          h(
            'li',
            {},
            h(
              'div',
              { class: 'name' },
              link(chat.name, chat.thread.url),
              chat.thread.encrypted ? chip('Encrypted') : null,
            ),
            chat.preview || chat.when
              ? h('div', { class: 'muted' }, [chat.preview, chat.when].filter(Boolean).join(' · '))
              : null,
          ),
        ),
    ),
    more(chats.length),
  );
}

function noticesView(notices: readonly Notice[]): HTMLElement {
  return section(
    'Notifications',
    notices.length,
    h(
      'ul',
      { class: 'list' },
      ...notices
        .slice(0, SHOWN)
        .map((notice) =>
          h(
            'li',
            {},
            h(
              'div',
              {},
              chip(NOTICE[notice.kind]),
              notice.when ? h('span', { class: 'muted' }, notice.when) : null,
            ),
            h('div', { class: 'text' }, link(notice.text, notice.url)),
          ),
        ),
    ),
    more(notices.length),
  );
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function resultView(result: ReadResult): HTMLElement[] {
  const parts: (HTMLElement | null)[] = [
    result.warnings.length
      ? h(
          'section',
          { class: 'warning', role: 'alert' },
          h('h2', {}, 'Facebook is warning you'),
          h('ul', { class: 'lines' }, ...result.warnings.map((line) => h('li', {}, line))),
          h(
            'p',
            {},
            'Later versions stop for the day when they see this. For now, slow down and do what Facebook asks.',
          ),
        )
      : null,
    result.profile ? profileView(result.profile) : null,
    result.group ? groupView(result.group) : null,
    result.chat ? chatView(result.chat) : null,
    result.people?.length ? peopleView(result.people) : null,
    result.groups?.length ? groupsView(result.groups) : null,
    result.notices?.length ? noticesView(result.notices) : null,
    result.posts?.length ? postsView(result.posts) : null,
    result.chats?.length ? chatsView(result.chats) : null,
    result.notes.length
      ? h(
          'section',
          { class: 'notes' },
          h('ul', {}, ...result.notes.map((note) => h('li', {}, note))),
        )
      : null,
  ];
  return parts.filter((part): part is HTMLElement => part !== null);
}

// --------------------------------------------------------------------------------------------------- state

const page = document.querySelector<HTMLElement>('#page')!;
const results = document.querySelector<HTMLElement>('#results')!;
const status = document.querySelector<HTMLElement>('#status')!;
const readButton = document.querySelector<HTMLButtonElement>('#read')!;
const copyButton = document.querySelector<HTMLButtonElement>('#copy-outline')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save-outline')!;
const autoBox = document.querySelector<HTMLInputElement>('#auto')!;

let current: { readonly id: number; readonly url: string } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The window this panel sits in: tabs in other windows are none of its business. */
let windowId: number | undefined;

function say(text: string): void {
  status.textContent = text;
}

/** The tab beside the panel, when it's showing Facebook. Other sites' addresses aren't visible to the extension. */
async function facebookTab(): Promise<{ id: number; url: string } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url || !facebookUrl(tab.url)) return null;
  return { id: tab.id, url: tab.url };
}

async function ask(tabId: number, message: Ask): Promise<Answer> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as Answer;
  } catch {
    // Tabs opened before the extension was installed or updated don't have its reader yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return (await chrome.tabs.sendMessage(tabId, message)) as Answer;
  }
}

function showPage(kind: PageKind | null, url: string | null): void {
  page.replaceChildren(
    h('div', { class: 'kind' }, kind ? KIND[kind] : 'No Facebook page open'),
    h('div', { class: 'url' }, url ? clip(url.replace(/^https:\/\/(www\.)?/, ''), 80) : null),
  );
}

async function read(): Promise<void> {
  clearTimeout(timer);
  const tab = await facebookTab();
  current = tab;
  for (const button of [readButton, copyButton, saveButton]) button.disabled = !tab;
  if (!tab) {
    showPage(null, null);
    results.replaceChildren();
    say('Open Facebook in this window and this panel shows what it can read there.');
    return;
  }
  say('Reading the page…');
  try {
    const answer = await ask(tab.id, { type: 'hfos-read' });
    if (!answer.ok) throw new Error(answer.error);
    showPage(answer.result.kind, answer.result.url);
    results.replaceChildren(...resultView(answer.result));
    say(`Read at ${new Date(answer.result.readAt).toLocaleTimeString()}.`);
  } catch (error) {
    results.replaceChildren();
    say(
      `Couldn’t read this page (${error instanceof Error ? error.message : String(error)}). Reload the Facebook tab and try again.`,
    );
  }
}

/** The page's outline, from the tab. Null, with the reason shown, when it couldn't be made. */
async function outline(): Promise<{ text: string; kind: PageKind } | null> {
  if (!current) return null;
  try {
    const answer = await ask(current.id, { type: 'hfos-outline' });
    if (!answer.ok) throw new Error(answer.error);
    return answer.outline ? { text: answer.outline, kind: answer.result.kind } : null;
  } catch (error) {
    say(
      `Couldn’t make the outline (${error instanceof Error ? error.message : String(error)}). Reload the Facebook tab and try again.`,
    );
    return null;
  }
}

function later(): void {
  clearTimeout(timer);
  if (autoBox.checked) timer = setTimeout(() => void read(), SETTLE_MS);
}

readButton.addEventListener('click', () => void read());

copyButton.addEventListener('click', async () => {
  const made = await outline();
  if (!made) return;
  try {
    await navigator.clipboard.writeText(made.text);
    say(
      'Copied the page outline. Look it over, then send it with a note about what the panel got wrong.',
    );
  } catch {
    say('Couldn’t copy. Use Save page outline instead.');
  }
});

saveButton.addEventListener('click', async () => {
  const made = await outline();
  if (!made) return;
  const url = URL.createObjectURL(new Blob([made.text], { type: 'text/plain' }));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  h('a', { href: url, download: `facebook-${made.kind}-outline-${stamp}.txt` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  say(
    'Saved the page outline to your downloads. Look it over, then send it with a note about what the panel got wrong.',
  );
});

autoBox.addEventListener('change', () => {
  void chrome.storage.local.set({ [AUTO_READ]: autoBox.checked }).catch(() => undefined);
  if (autoBox.checked) void read();
});

chrome.tabs.onActivated.addListener((active) => {
  if (active.windowId === windowId) void read();
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tab.active || tab.windowId !== windowId) return;
  if (tabId === current?.id || (tab.url && facebookUrl(tab.url))) {
    if (change.url || change.status === 'complete') later();
  }
});

async function start(): Promise<void> {
  windowId = (await chrome.windows.getCurrent()).id;
  try {
    const stored = await chrome.storage.local.get(AUTO_READ);
    autoBox.checked = stored[AUTO_READ] !== false;
  } catch {
    autoBox.checked = true;
  }
  await read();
}

void start();
