/**
 * The side panel. It asks the Facebook tab beside it to read the page and shows what came back, and with "Read when
 * the page changes" on it reads again when the tab goes somewhere new, reloads, or says its page changed (more posts
 * as you scroll, a new message). Signed in to HandsFreeOS (./hfos.ts), it marks the people and chats saved there and
 * saves the ones the person picks; nothing is saved until they press Save. Above, it shows the day's steps on
 * Facebook against the daily limits (./today.ts). "Copy page outline" and "Save page outline" give the page's shape
 * with names and words hidden, to send to whoever is tuning the readers when the panel gets a page wrong.
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
import { WATCH, type Answer, type Ask, type Note } from '../messages';
import { chip, clip, counted, h, link, type Child } from './dom';
import type { Fit } from '@hfos/core/addons/outreach/fit';
import {
  chatBlock,
  dontPitchLine,
  fitView,
  forget,
  inFitOrder,
  listBlock,
  lookUp,
  markChips,
  profileBlock,
  refreshAccount,
  requestFits,
  savedChatChip,
  savedChip,
  startHfos,
} from './hfos';
import { collectOpen, refreshChats, startChats } from './chats';
import { refreshFacebookFile, startFacebookFile } from './fbfile';
import { refreshToday, startToday } from './today';

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
    profileBlock(profile),
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

function personView(person: Person, fit: Fit | undefined): HTMLElement {
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'name' },
      link(person.name, person.profile?.url),
      savedChip(person.profile),
      ...markChips(person.profile),
    ),
    person.details.length ? h('div', { class: 'muted' }, person.details.join(' · ')) : null,
    fitView(fit),
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

/** The people on the page; on your friends pages, the button that saves your list, and the requests by fit. */
function peopleView(result: ReadResult, people: readonly Person[]): HTMLElement {
  const fits = requestFits(result);
  const items: HTMLElement[] = [];
  let part: string | null = null;
  for (const person of inFitOrder(people, fits).slice(0, SHOWN)) {
    if (person.section !== part && person.section)
      items.push(h('li', { class: 'part' }, person.section));
    part = person.section;
    items.push(personView(person, fits.get(person)));
  }
  return section(
    'People',
    people.length,
    listBlock(result),
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
              savedChip(post.author?.profile),
            ),
            post.text ? h('p', { class: 'text' }, clip(post.text, 280)) : null,
            h(
              'div',
              { class: 'muted' },
              post.reactions !== null ? counted(post.reactions, 'reaction') : null,
              post.reactions !== null && post.comments !== null ? ' · ' : null,
              post.comments !== null ? counted(post.comments, 'comment') : null,
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
    dontPitchLine(chat.profile),
    chatBlock(chat),
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
              savedChatChip(chat.thread.id),
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
    result.people?.length ? peopleView(result, result.people) : null,
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

const accountBox = document.querySelector<HTMLElement>('#account')!;
const todayBox = document.querySelector<HTMLElement>('#today')!;
const fileBox = document.querySelector<HTMLElement>('#fbfile')!;
const chatsBox = document.querySelector<HTMLElement>('#chats')!;
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
/** The tab the panel hears page changes from, and the line to it. */
let watching: { readonly id: number; readonly port: chrome.runtime.Port } | null = null;
/** What the panel shows, so a read that finds the same leaves it as it is. */
let shown = '';
/** The last read shown, drawn again when HandsFreeOS says what's saved. */
let lastResult: ReadResult | null = null;
/** Counts reads, so the answer to an older one never replaces a newer one's. */
let reads = 0;

function say(text: string): void {
  status.textContent = text;
}

function redraw(): void {
  if (lastResult) results.replaceChildren(...resultView(lastResult));
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

/** Your own lists, where a friends page is one. */
const YOUR_LIST: Record<NonNullable<ReadResult['friendList']>, string> = {
  friends: 'Your friends',
  requests: 'Your friend requests',
};

function showPage(
  kind: PageKind | null,
  url: string | null,
  list?: ReadResult['friendList'],
): void {
  page.replaceChildren(
    h(
      'div',
      { class: 'kind' },
      list ? YOUR_LIST[list] : kind ? KIND[kind] : 'No Facebook page open',
    ),
    h('div', { class: 'url' }, url ? clip(url.replace(/^https:\/\/(www\.)?/, ''), 80) : null),
  );
}

/** Hears from a tab when its page changes, and reads it again then. One tab at a time: the one beside the panel. */
function watch(tabId: number): void {
  if (watching?.id === tabId) return;
  unwatch();
  const port = chrome.tabs.connect(tabId, { name: WATCH });
  watching = { id: tabId, port };
  port.onMessage.addListener((note: Note) => {
    if (note.type === 'hfos-changed' && autoBox.checked && current?.id === tabId) void read(true);
  });
  // The tab reloaded, went to another site or closed. The read after it starts watching again.
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (watching?.port === port) watching = null;
  });
}

function unwatch(): void {
  watching?.port.disconnect();
  watching = null;
}

/**
 * Reads the tab beside the panel and shows what it found. A quiet read, after the page changed, shows its answer
 * only when it differs from what's shown, and keeps what's shown when the page can't be read just then.
 */
async function read(quiet = false): Promise<void> {
  clearTimeout(timer);
  const seq = ++reads;
  const tab = await facebookTab();
  if (seq !== reads) return;
  current = tab;
  for (const button of [readButton, copyButton, saveButton]) button.disabled = !tab;
  if (!tab) {
    unwatch();
    shown = '';
    lastResult = null;
    showPage(null, null);
    results.replaceChildren();
    say('Open Facebook in this window and this panel shows what it can read there.');
    return;
  }
  if (!quiet) say('Reading the page…');
  try {
    const answer = await ask(tab.id, { type: 'hfos-read' });
    if (seq !== reads) return;
    if (!answer.ok) throw new Error(answer.error);
    if (autoBox.checked) watch(tab.id);
    const { readAt, ...found } = answer.result;
    const seen = JSON.stringify(found);
    if (quiet && seen === shown) return;
    shown = seen;
    lastResult = answer.result;
    // Pressing Read asks HandsFreeOS again too: something may have been saved somewhere else.
    if (!quiet) forget(answer.result);
    showPage(answer.result.kind, answer.result.url, answer.result.friendList);
    results.replaceChildren(...resultView(answer.result));
    say(`Read at ${new Date(readAt).toLocaleTimeString()}.`);
    void lookUp(answer.result);
    void collectOpen(answer.result);
  } catch (error) {
    if (seq !== reads || quiet) return;
    shown = '';
    lastResult = null;
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

readButton.addEventListener('click', () => {
  void refreshAccount();
  void refreshToday();
  refreshFacebookFile();
  void read();
});

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
  else unwatch();
});

chrome.tabs.onActivated.addListener((active) => {
  if (active.windowId === windowId) void read();
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // A page that starts loading drops its line to the panel; the read once it has loaded opens a new one.
  if (tabId === watching?.id && change.status === 'loading') unwatch();
  if (!tab.active || tab.windowId !== windowId) return;
  if (tabId === current?.id || (tab.url && facebookUrl(tab.url))) {
    if (change.url || change.status === 'complete') later();
  }
});

async function start(): Promise<void> {
  void startHfos({
    into: accountBox,
    say,
    redraw,
    accountChanged: () => {
      void refreshToday();
      void refreshChats();
    },
  });
  void startChats(chatsBox);
  startToday(todayBox);
  void startFacebookFile(fileBox);
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
