/**
 * HandsFreeOS in the side panel: signing in, the business it saves to, which people and chats on the page are saved
 * there already, and the Save buttons. On your friends pages it saves the list, and puts the friend requests in order
 * of how they fit the business's playbooks; on a profile, Keep and Don't pitch (docs/outreach.md, decisions 10 to
 * 13). The background worker does the talking (src/hfos/session.ts); this keeps what it said and draws it. Nothing is
 * saved until the person presses a button.
 */
import {
  bestFit,
  byFit,
  FIT_LEVELS,
  type Fit,
  type FitPlaybook,
} from '@hfos/core/addons/outreach/fit';
import {
  bestGroupFit,
  GROUP_VERDICTS,
  type GroupFacts,
  type GroupFitPlaybook,
} from '@hfos/core/addons/outreach/groups';
import {
  DONT_PITCH_TAG,
  LOOKUP_NAMES,
  LOOKUP_PROFILES,
  LOOKUP_THREADS,
} from '@hfos/core/addons/outreach/limits';
import { mutualFriendsIn } from '../facebook/friends';
import type {
  ChatPage,
  GroupLink,
  Person,
  ProfilePage,
  ProfileRef,
  ReadResult,
} from '../facebook/types';
import { profileKey } from '../facebook/urls';
import type {
  Account,
  Business,
  FriendSetInput,
  HfosAnswer,
  Lookup,
  Problem,
} from '../hfos/messages';
import {
  chatSave,
  friendSet,
  friendsSave,
  groupDetailFacts,
  groupSave,
  groupsSave,
  isAdminsPage,
  listItem,
  listOnPage,
  nameKey,
  onPage,
  profileSave,
  type ListOnPage,
} from '../hfos/saves';
import { ask } from './ask';
import { ago, button, chip, counted, h, hfosLink, link, type Child } from './dom';

type SameName = Lookup['sameName'][number]['people'][number];
/** Where the person's own Facebook stands with someone kept in HandsFreeOS, Keep, Don't pitch, and what fit reads. */
type Mark = Lookup['marks'][number];
type DontPitch = NonNullable<Mark['dontPitch']>;

/** How long the playbooks are taken as they were, before HandsFreeOS is asked again. */
const PLAYBOOKS_FOR_MS = 5 * 60_000;

interface Saved {
  readonly personId: string;
  readonly name: string;
}

interface SavedChat extends Saved {
  readonly kept: number;
  readonly lastSavedAt: string;
}

/** What HandsFreeOS said about the people and chats this panel has seen, in one business. */
class Known {
  /** By `profileKey`; null when it isn't saved. */
  readonly profiles = new Map<string, Saved | null>();
  /** By the chat's number; null when the person hasn't saved it. */
  readonly threads = new Map<string, SavedChat | null>();
  /** By `nameKey`: the customers with that name. */
  readonly names = new Map<string, readonly SameName[]>();
  /** By `profileKey`; null when HandsFreeOS keeps no profile for them. */
  readonly marks = new Map<string, Mark | null>();
  /** The playbooks in use, as much as fit reads: null until asked. */
  playbooks: readonly FitPlaybook[] | null = null;
  /** The same playbooks, as much as a group's fit reads. */
  groupPlaybooks: readonly GroupFitPlaybook[] | null = null;
  playbooksAt = 0;
  constructor(readonly business: Business) {}
}

type Step =
  | { readonly kind: 'email' }
  | { readonly kind: 'code'; readonly email: string }
  | { readonly kind: 'password'; readonly email: string };

const CODE = /^\d{6,10}$/;

let box: HTMLElement;
let say: (text: string) => void = () => undefined;
let redraw: () => void = () => undefined;
let accountChanged: () => void = () => undefined;

/** Null until the background has said; a problem when it couldn't. */
let account: Account | null = null;
let accountProblem: Problem | null = null;
let known: Known | null = null;
let step: Step = { kind: 'email' };
let typedEmail = '';
let formError: string | null = null;
let working = false;
/** The people and chats being saved right now. */
const saving = new Set<string>();

const personUrl = (personId: string) =>
  account?.signedIn && known
    ? `${account.webUrl}/app/w/${known.business.id}/customers/people/${personId}`
    : '#';

// ------------------------------------------------------------------------------------------------- the account

/** Takes what the background said about the sign-in, and keeps what's known only while the business stays. */
function take(next: Account): void {
  const changed = accountProblem !== null || JSON.stringify(next) !== JSON.stringify(account);
  account = next;
  accountProblem = null;
  const business = next.signedIn
    ? (next.businesses.find((b) => b.id === next.businessId) ?? null)
    : null;
  const before = known;
  if (!business) known = null;
  else if (known?.business.id !== business.id || known.business.name !== business.name)
    known = new Known(business);
  if (changed) {
    drawAccount();
    accountChanged();
  }
  if (known !== before) {
    redraw();
    void lookUpAgain();
  }
}

async function loadAccount(fresh = false): Promise<void> {
  const answer = await ask({ type: 'hfos-account', fresh });
  if (answer.ok) return take(answer.value);
  accountProblem = answer.problem;
  drawAccount();
}

/** What went wrong, said; and when the sign-in or the business may have changed, the account asked for again. */
function problem(p: Problem): void {
  say(p.message);
  if (p.recheck) void loadAccount(true);
}

async function signIn(action: () => Promise<HfosAnswer<Account | null>>): Promise<void> {
  working = true;
  formError = null;
  drawAccount();
  const answer = await action();
  working = false;
  if (!answer.ok) {
    formError = answer.problem.message;
    drawAccount();
    return;
  }
  if (answer.value) {
    step = { kind: 'email' };
    take(answer.value);
  }
  drawAccount();
}

function field(
  label: string,
  attributes: Record<string, string | undefined>,
  onInput?: (value: string) => void,
): { row: HTMLElement; input: HTMLInputElement } {
  const input = h('input', attributes);
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  return { row: h('label', { class: 'field' }, h('span', {}, label), input), input };
}

function form(onSubmit: () => void, ...children: Child[]): HTMLFormElement {
  const element = h('form', { class: 'sign-in' }, ...children);
  element.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!working) onSubmit();
  });
  return element;
}

function submit(text: string): HTMLButtonElement {
  const element = h('button', { type: 'submit', class: 'primary' }, working ? 'One moment…' : text);
  element.disabled = working;
  return element;
}

function errorLine(): Child {
  return formError ? h('p', { class: 'error', role: 'alert' }, formError) : null;
}

function signInView(): HTMLElement {
  const intro = h(
    'p',
    { class: 'muted' },
    'Sign in to save the people and chats you pick. Reading pages works without it.',
  );
  if (step.kind === 'email') {
    const email = field(
      'Email',
      {
        type: 'email',
        autocomplete: 'email',
        placeholder: 'you@company.com',
        value: typedEmail,
      },
      (value) => (typedEmail = value),
    );
    const checked = (): string | null => {
      const value = email.input.value.trim();
      formError = !value
        ? 'Enter your email address.'
        : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          ? null
          : 'Check the email address.';
      if (formError) drawAccount();
      return formError ? null : value;
    };
    const sendCode = () => {
      const value = checked();
      if (!value) return;
      void signIn(async () => {
        const answer = await ask({ type: 'hfos-send-code', email: value });
        if (answer.ok) step = { kind: 'code', email: value };
        return answer;
      });
    };
    return form(
      sendCode,
      h('h2', {}, 'Save to HandsFreeOS'),
      intro,
      email.row,
      errorLine(),
      h(
        'div',
        { class: 'actions' },
        submit('Email me a code'),
        button(
          'Use my password',
          () => {
            const value = checked();
            if (value) {
              step = { kind: 'password', email: value };
              drawAccount();
            }
          },
          { disabled: working },
        ),
      ),
    );
  }
  const other = button(
    'Use another email',
    () => {
      step = { kind: 'email' };
      formError = null;
      drawAccount();
    },
    { disabled: working },
  );
  if (step.kind === 'code') {
    const { email } = step;
    const code = field('Code', {
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      maxlength: '10',
    });
    return form(
      () => {
        const value = code.input.value.replace(/\D/g, '');
        if (!CODE.test(value)) {
          formError = 'Enter the 6-digit code from the email.';
          return drawAccount();
        }
        void signIn(() => ask({ type: 'hfos-check-code', email, code: value }));
      },
      h('h2', {}, 'Check your email'),
      h('p', { class: 'muted' }, 'We sent a 6-digit code to ', h('strong', {}, email), '.'),
      code.row,
      errorLine(),
      h(
        'div',
        { class: 'actions' },
        submit('Sign in'),
        button(
          'Send another code',
          () => void signIn(() => ask({ type: 'hfos-send-code', email })),
          { disabled: working },
        ),
        other,
      ),
    );
  }
  const { email } = step;
  const password = field('Password', { type: 'password', autocomplete: 'current-password' });
  return form(
    () => {
      if (!password.input.value) {
        formError = 'Enter your password.';
        return drawAccount();
      }
      void signIn(() => ask({ type: 'hfos-password', email, password: password.input.value }));
    },
    h('h2', {}, 'Sign in to HandsFreeOS'),
    h('p', { class: 'muted' }, h('strong', {}, email)),
    password.row,
    errorLine(),
    h(
      'div',
      { class: 'actions' },
      submit('Sign in'),
      button(
        'Email me a code instead',
        () =>
          void signIn(async () => {
            const answer = await ask({ type: 'hfos-send-code', email });
            if (answer.ok) step = { kind: 'code', email };
            return answer;
          }),
        { disabled: working },
      ),
      other,
    ),
    account && !account.signedIn
      ? h(
          'p',
          { class: 'muted' },
          hfosLink('Forgot your password?', `${account.webUrl}/forgot-password`),
        )
      : null,
  );
}

function signedInView(a: Extract<Account, { signedIn: true }>): HTMLElement {
  const signOut = h('button', { type: 'button', class: 'quiet' }, 'Sign out');
  signOut.addEventListener('click', () => {
    void ask({ type: 'hfos-sign-out' }).then((answer) => {
      if (answer.ok) take(answer.value);
      else problem(answer.problem);
    });
  });
  const who = h('p', { class: 'muted who' }, `Signed in as ${a.email} · `, signOut);
  if (!a.businesses.length)
    return h(
      'div',
      {},
      h(
        'p',
        {},
        'None of your businesses has Social Outreach turned on, so there’s nowhere to save yet. Reading pages still works.',
      ),
      who,
    );
  let where: Child;
  if (a.businesses.length === 1) where = h('strong', {}, a.businesses[0]!.name);
  else {
    const select = h(
      'select',
      { 'aria-label': 'Business' },
      ...a.businesses.map((b) =>
        h('option', { value: b.id, selected: b.id === a.businessId ? '' : undefined }, b.name),
      ),
    );
    select.addEventListener('change', () => {
      void ask({ type: 'hfos-pick', businessId: select.value }).then((answer) =>
        answer.ok ? take(answer.value) : problem(answer.problem),
      );
    });
    where = select;
  }
  return h(
    'div',
    {},
    h(
      'p',
      { class: 'saving-to' },
      'Saving to ',
      where,
      a.businessId
        ? h(
            'span',
            { class: 'muted' },
            ' · ',
            hfosLink('Playbooks', `${a.webUrl}/app/w/${a.businessId}/a/outreach?view=playbooks`),
          )
        : null,
    ),
    who,
  );
}

function drawAccount(): void {
  let content: Child;
  if (accountProblem) {
    content = h(
      'div',
      {},
      h('p', {}, accountProblem.message),
      button('Try again', () => void loadAccount(true)),
    );
  } else if (!account) content = h('p', { class: 'muted' }, 'Checking your HandsFreeOS sign-in…');
  else if (account.signedIn) content = signedInView(account);
  else if (!account.canSignIn)
    content = h(
      'p',
      { class: 'muted' },
      'This build can’t sign in to HandsFreeOS, so it reads pages and saves nothing.',
    );
  else content = signInView();
  box.replaceChildren(content);
}

// ------------------------------------------------------------------------------------------- what's saved

let lastRead: ReadResult | null = null;

/** Asks HandsFreeOS about the people and chats on the page it hasn't asked about yet. Draws again when it answers. */
export async function lookUp(result: ReadResult): Promise<void> {
  lastRead = result;
  const k = known;
  if (!k) return;
  if (listOnPage(result)?.list === 'requests' || result.group || result.groups?.length)
    void loadPlaybooks(k);
  const on = onPage(result);
  const profiles = on.profiles
    .filter((p) => !k.profiles.has(profileKey(p)) || !k.marks.has(profileKey(p)))
    .slice(0, LOOKUP_PROFILES);
  const threads = on.threads.filter((t) => !k.threads.has(t)).slice(0, LOOKUP_THREADS);
  const names = on.name && !k.names.has(nameKey(on.name)) ? [on.name].slice(0, LOOKUP_NAMES) : [];
  if (!profiles.length && !threads.length && !names.length) return;
  const answer = await ask({
    type: 'hfos-lookup',
    input: {
      workspaceId: k.business.id,
      platform: 'facebook',
      profiles: profiles.map((p) => ({ id: p.id, username: p.username })),
      threads,
      names,
    },
  });
  if (!answer.ok) return problem(answer.problem);
  for (const p of profiles) {
    k.profiles.set(profileKey(p), null);
    k.marks.set(profileKey(p), null);
  }
  for (const saved of answer.value.profiles) {
    const found = { personId: saved.personId, name: saved.name };
    if (saved.id) k.profiles.set(`id:${saved.id}`, found);
    if (saved.username) k.profiles.set(`user:${saved.username.toLowerCase()}`, found);
  }
  for (const mark of answer.value.marks) setMark(k, mark);
  for (const t of threads) k.threads.set(t, null);
  for (const t of answer.value.threads) k.threads.set(t.key, t);
  for (const n of answer.value.sameName) k.names.set(nameKey(n.name), n.people);
  if (k === known) redraw();
}

/** Keeps what HandsFreeOS said about someone, by each way the page may link to them. */
function setMark(k: Known, mark: Mark): void {
  if (mark.id) k.marks.set(`id:${mark.id}`, mark);
  if (mark.username) k.marks.set(`user:${mark.username.toLowerCase()}`, mark);
}

/** Asks for the business's playbooks, to put the friend requests in order: again after a few minutes. */
async function loadPlaybooks(k: Known): Promise<void> {
  if (k.playbooks && Date.now() - k.playbooksAt < PLAYBOOKS_FOR_MS) return;
  k.playbooksAt = Date.now();
  const answer = await ask({ type: 'hfos-playbooks', workspaceId: k.business.id });
  if (!answer.ok) {
    k.playbooksAt = 0;
    return problem(answer.problem);
  }
  const inUse = answer.value.playbooks.filter((playbook) => !playbook.archivedAt);
  k.playbooks = inUse.map(({ id, name, details }) => ({ id, name, details }));
  k.groupPlaybooks = inUse.map(({ id, name, details }) => ({ id, name, details }));
  if (k === known) redraw();
}

/** Forgets what it knew about this page, so the next look-up asks again: after "Read this page". */
export function forget(result: ReadResult): void {
  if (!known) return;
  const on = onPage(result);
  for (const p of on.profiles) {
    known.profiles.delete(profileKey(p));
    known.marks.delete(profileKey(p));
  }
  known.playbooks = null;
  known.groupPlaybooks = null;
  for (const t of on.threads) known.threads.delete(t);
  if (on.name) known.names.delete(nameKey(on.name));
}

async function lookUpAgain(): Promise<void> {
  if (lastRead) await lookUp(lastRead);
}

// ------------------------------------------------------------------------------------------------- saving

async function saveProfile(page: ProfilePage, personId?: string): Promise<void> {
  const k = known;
  if (!k || !page.profile) return;
  const built = profileSave(page, k.business.id, personId);
  if (!built.ok) return say(built.why);
  const key = profileKey(page.profile);
  saving.add(key);
  redraw();
  const answer = await ask({ type: 'hfos-save-profile', input: built.input });
  saving.delete(key);
  if (answer.ok) {
    const saved = answer.value;
    k.profiles.set(key, { personId: saved.personId, name: saved.personName });
    say(
      saved.addedPerson
        ? `Added ${saved.personName} to Contacts in ${k.business.name}.`
        : `Saved ${saved.personName}’s profile in ${k.business.name}.`,
    );
  } else problem(answer.problem);
  redraw();
}

async function saveChat(chat: ChatPage, personId?: string): Promise<void> {
  const k = known;
  if (!k || !chat.thread) return;
  const built = chatSave(chat, k.business.id, new Date(), personId);
  if (!built.ok) return say(built.why);
  const key = `chat:${chat.thread.id}`;
  saving.add(key);
  redraw();
  const answer = await ask({ type: 'hfos-save-chat', input: built.input });
  saving.delete(key);
  if (answer.ok) {
    const saved = answer.value;
    k.threads.set(chat.thread.id, {
      personId: saved.personId,
      name: saved.personName,
      kept: saved.kept,
      lastSavedAt: new Date().toISOString(),
    });
    if (chat.profile)
      k.profiles.set(profileKey(chat.profile), {
        personId: saved.personId,
        name: saved.personName,
      });
    const left = built.left ?? 0;
    say(
      [
        saved.addedPerson ? `Added ${saved.personName} to Contacts.` : null,
        saved.added
          ? `Saved ${counted(saved.added, 'new message')} with ${saved.personName}.`
          : `Nothing new to save with ${saved.personName}.`,
        left ? `The ${counted(left, 'oldest message')} on the page didn’t fit in one save.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    );
  } else problem(answer.problem);
  redraw();
}

/** Saves your list on the page, in parts when it's long, and says what came of it. */
async function saveList(mine: ListOnPage): Promise<void> {
  const k = known;
  if (!k) return;
  const built = friendsSave(mine.people, mine.list, k.business.id);
  if (!built.ok) return say(built.why);
  const key = `list:${mine.list}`;
  saving.add(key);
  redraw();
  const done = { saved: 0, added: 0, changed: 0 };
  for (const input of built.input) {
    const answer = await ask({ type: 'hfos-save-friends', input });
    if (!answer.ok) {
      saving.delete(key);
      redraw();
      if (done.saved) say(`Saved ${done.saved.toLocaleString()} before this stopped.`);
      return problem(answer.problem);
    }
    done.saved += answer.value.saved;
    done.added += answer.value.added;
    done.changed += answer.value.changed;
  }
  saving.delete(key);
  // What HandsFreeOS keeps about them changed: ask again.
  for (const person of mine.people) if (person.profile) k.marks.delete(profileKey(person.profile));
  const what = listItem(mine.list);
  const news = [
    done.added ? `${done.added.toLocaleString()} new` : null,
    done.changed ? `${done.changed.toLocaleString()} changed` : null,
  ].filter(Boolean);
  say(
    `Saved ${counted(done.saved, what)} in ${k.business.name}${news.length ? `: ${news.join(', ')}` : ''}.`,
  );
  redraw();
  await lookUpAgain();
}

/** Saves the groups a page lists, with how much the page said about each. */
async function saveGroups(groups: readonly GroupLink[]): Promise<void> {
  const k = known;
  if (!k) return;
  const built = groupsSave(groups, k.business.id);
  if (!built.ok) return say(built.why);
  saving.add('groups');
  redraw();
  const answer = await ask({ type: 'hfos-save-groups', input: built.input });
  saving.delete('groups');
  if (answer.ok)
    say(
      `Saved ${counted(answer.value.saved, 'group')} in ${k.business.name}. See how they fit in the Groups tab.`,
    );
  else problem(answer.problem);
  redraw();
}

/** Saves the group on the page and the people its list shows, in parts when it's long. */
async function saveGroup(result: ReadResult): Promise<void> {
  const k = known;
  if (!k) return;
  const built = groupSave(result, k.business.id);
  if (!built.ok) return say(built.why);
  const key = `group:${result.group?.group?.id ?? ''}`;
  saving.add(key);
  redraw();
  const done = { people: 0, runsGroup: 0 };
  for (const input of built.input) {
    const answer = await ask({ type: 'hfos-save-group', input });
    if (!answer.ok) {
      saving.delete(key);
      redraw();
      if (done.people) say(`Saved ${counted(done.people, 'person')} before this stopped.`);
      return problem(answer.problem);
    }
    done.people += answer.value.people;
    done.runsGroup += answer.value.runsGroup;
  }
  saving.delete(key);
  const name = result.group?.name ?? 'the group';
  const adminsPage = isAdminsPage(result.url);
  say(
    !done.people
      ? `Saved ${name} in ${k.business.name}.`
      : adminsPage
        ? `Saved ${name}’s ${counted(done.people, 'admin and moderator', 'admins and moderators')}. Today can suggest its members now.`
        : `Saved ${name} and ${counted(done.people, 'person', 'people')} in it${done.runsGroup ? `, ${done.runsGroup.toLocaleString()} who run it and are left alone` : ''}.`,
  );
  redraw();
}

/** Keep, or Don't pitch, for someone on the page. */
async function setFriend(
  to: { readonly profile: ProfileRef; readonly name: string },
  change: Pick<FriendSetInput, 'keep' | 'dontPitch'>,
): Promise<void> {
  const k = known;
  if (!k) return;
  const key = profileKey(to.profile);
  const mark = k.marks.get(key) ?? null;
  const built = friendSet(to, k.business.id, change, mark?.profileId);
  if (!built.ok) return say(built.why);
  saving.add(`mark:${key}`);
  redraw();
  const answer = await ask({ type: 'hfos-set-friend', input: built.input });
  saving.delete(`mark:${key}`);
  if (answer.ok) {
    const set = answer.value;
    const next: Mark = {
      ...(mark ?? { state: null, intro: [], mutualFriends: null, groupName: null }),
      profileId: set.profileId,
      id: mark?.id ?? to.profile.id,
      username: mark?.username ?? to.profile.username,
      keep: set.keep,
      dontPitch: set.dontPitch,
    };
    k.marks.set(key, next);
    setMark(k, next);
    say(
      change.dontPitch === true
        ? `${to.name} is on the Don’t pitch list in ${k.business.name}.`
        : change.dontPitch === false
          ? set.dontPitch
            ? `${to.name} is off the Don’t pitch list, but tagged ${DONT_PITCH_TAG} in Contacts, so they still aren’t pitched.`
            : `${to.name} is off the Don’t pitch list.`
          : set.keep
            ? `You’ll keep ${to.name}: they’re never suggested for unfriending.`
            : `${to.name} isn’t on your Keep list anymore.`,
    );
  } else problem(answer.problem);
  redraw();
}

// ------------------------------------------------------------------------------------------------- drawing

function block(...children: Child[]): HTMLElement {
  return h('div', { class: 'hfos' }, ...children);
}

const checking = () => block(h('p', { class: 'muted' }, 'Checking HandsFreeOS…'));

/** The customers with this name, each to pick as the one this is. */
function sameNameView(
  people: readonly SameName[],
  pick: (personId: string) => void,
  busy: boolean,
) {
  return h(
    'div',
    {},
    h(
      'p',
      {},
      people.length === 1
        ? 'Already in Contacts? There’s a customer with this name:'
        : `Already in Contacts? There are ${people.length} customers with this name:`,
    ),
    h(
      'ul',
      { class: 'list' },
      ...people.map((p) =>
        h(
          'li',
          { class: 'same' },
          h(
            'div',
            {},
            h('div', { class: 'name' }, hfosLink(p.name, personUrl(p.personId))),
            h(
              'div',
              { class: 'muted' },
              [
                p.email,
                p.phone,
                p.source ? `from ${p.source}` : null,
                `added ${new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
            p.hasProfile
              ? h('div', { class: 'muted' }, 'Has a Facebook profile saved already.')
              : null,
          ),
          button('It’s them', () => pick(p.personId), { disabled: busy }),
        ),
      ),
    ),
  );
}

/** "Added by Jordan Owner on Oct 6": who put someone on the Don't pitch list, and when. */
function addedBy(never: DontPitch): string {
  const on = never.at
    ? ` on ${new Date(never.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : '';
  return never.by ? `added by ${never.by}${on}` : `added${on}`;
}

/** Why someone isn't pitched: the list, the Contacts tag, or both. */
function dontPitchWords(never: DontPitch): string {
  const listed = never.at !== null;
  if (listed && never.tagged)
    return `On the Don’t pitch list (${addedBy(never)}), and tagged ${DONT_PITCH_TAG} in Contacts.`;
  if (listed) return `On the Don’t pitch list, ${addedBy(never)}.`;
  return `Tagged ${DONT_PITCH_TAG} in Contacts, so nobody pitches them. To pitch them, take the tag off in Contacts.`;
}

function toggle(text: string, on: boolean, busy: boolean, change: (on: boolean) => void) {
  const input = h('input', { type: 'checkbox' });
  input.checked = on;
  input.disabled = busy;
  input.addEventListener('change', () => change(input.checked));
  return h('label', { class: 'auto' }, input, ` ${text}`);
}

/**
 * Keep and Don't pitch for the person on a profile: Keep only for a friend. Steps to someone on the Don't pitch list
 * aren't counted as outreach, and the line says why they're on it.
 */
function marksView(to: { readonly profile: ProfileRef; readonly name: string }, friends: boolean) {
  const k = known;
  const key = profileKey(to.profile);
  const mark = k?.marks.get(key);
  if (!k || mark === undefined) return null;
  const busy = saving.has(`mark:${key}`);
  const never = mark?.dontPitch ?? null;
  return h(
    'div',
    { class: 'marks' },
    never ? h('p', { class: 'warn-line' }, dontPitchWords(never)) : null,
    toggle(
      'Don’t pitch: no outreach to them from anyone here',
      never !== null && never.at !== null,
      busy,
      (on) => void setFriend(to, { dontPitch: on }),
    ),
    friends || mark?.state === 'friends' || mark?.keep
      ? toggle(
          'Keep: never suggest unfriending them',
          mark?.keep ?? false,
          busy,
          (on) => void setFriend(to, { keep: on }),
        )
      : null,
  );
}

/** Saving the profile on the page: where it's saved, or the button. Nothing while there's nowhere to save. */
export function profileBlock(page: ProfilePage): HTMLElement | null {
  const k = known;
  if (!k || page.friendship === 'self' || !page.profile || !page.name) return null;
  const key = profileKey(page.profile);
  const busy = saving.has(key);
  const saved = k.profiles.get(key);
  const sameNames = k.names.get(nameKey(page.name));
  if (saved === undefined || (saved === null && sameNames === undefined)) return checking();
  const marks = marksView(
    { profile: page.profile, name: page.name },
    page.friendship === 'friends',
  );
  if (saved)
    return block(
      h('p', {}, 'In HandsFreeOS as ', hfosLink(saved.name, personUrl(saved.personId)), '.'),
      button(busy ? 'Saving…' : 'Save again', () => void saveProfile(page), { disabled: busy }),
      marks,
    );
  const same = sameNames ?? [];
  return block(
    same.length ? sameNameView(same, (personId) => void saveProfile(page, personId), busy) : null,
    button(
      busy ? 'Saving…' : same.length ? 'Save as someone new' : 'Save to HandsFreeOS',
      () => void saveProfile(page),
      { primary: true, disabled: busy },
    ),
    marks,
  );
}

/** The line over a chat with someone nobody pitches. */
export function dontPitchLine(profile: ProfileRef | null | undefined): Child {
  const never = profile ? known?.marks.get(profileKey(profile))?.dontPitch : null;
  return never ? h('p', { class: 'warn-line' }, dontPitchWords(never)) : null;
}

/** "Don't pitch" and "Keep" beside someone in a list. */
export function markChips(profile: ProfileRef | null | undefined): Child[] {
  const mark = profile ? known?.marks.get(profileKey(profile)) : null;
  if (!mark) return [];
  return [mark.dontPitch ? chip('Don’t pitch', 'warn') : null, mark.keep ? chip('Keep') : null];
}

// ------------------------------------------------------------------------------------ your friends pages

/** How someone in your requests fits the playbooks in use, from what the page and HandsFreeOS know about them. */
function fitOf(k: Known, person: Person): Fit | null {
  if (!k.playbooks || !person.profile) return null;
  const mark = k.marks.get(profileKey(person.profile)) ?? null;
  return bestFit(k.playbooks, {
    lines: [...person.details, ...(mark?.intro ?? [])],
    mutualFriends: mutualFriendsIn(person.details) ?? mark?.mutualFriends ?? null,
    groupName: mark?.groupName ?? null,
  });
}

/** The friend requests on the page, each with how they fit, once the playbooks are known. */
export function requestFits(result: ReadResult): ReadonlyMap<Person, Fit> {
  const k = known;
  const mine = listOnPage(result);
  const fits = new Map<Person, Fit>();
  if (!k || mine?.list !== 'requests') return fits;
  for (const person of mine.people) {
    const fit = fitOf(k, person);
    if (fit) fits.set(person, fit);
  }
  return fits;
}

/**
 * The people on the page in the order to show them: the friend requests by how they fit the playbooks, the best
 * first, in the places the requests had; everyone else as the page had them.
 */
export function inFitOrder(people: readonly Person[], fits: ReadonlyMap<Person, Fit>): Person[] {
  if (!fits.size) return [...people];
  const sorted = byFit(
    people
      .filter((person) => fits.has(person))
      .map((person) => ({
        person,
        fit: fits.get(person)!,
        mutualFriends: mutualFriendsIn(person.details),
      })),
  ).map(({ person }) => person);
  let next = 0;
  return people.map((person) => (fits.has(person) ? sorted[next++]! : person));
}

/** How a request fits, beside them: "Good fit", and why. */
export function fitView(fit: Fit | undefined): Child {
  if (!fit || !known?.playbooks?.length) return null;
  return h(
    'div',
    {},
    chip(
      FIT_LEVELS[fit.level],
      fit.level === 'skip' ? 'warn' : fit.level === 'good' ? 'saved' : 'plain',
    ),
    fit.reasons.length ? h('span', { class: 'muted' }, fit.reasons.join(' · ')) : null,
  );
}

/** Saving your friends or your requests, over the list. */
export function listBlock(result: ReadResult): HTMLElement | null {
  const k = known;
  const mine = listOnPage(result);
  if (!k || !mine?.people.length) return null;
  const busy = saving.has(`list:${mine.list}`);
  const count = mine.people.length;
  const these = (what: string) =>
    `Save ${count === 1 ? `this ${what}` : `these ${count.toLocaleString()} ${what}s`}`;
  return block(
    h(
      'p',
      { class: 'muted' },
      mine.list === 'friends'
        ? 'Facebook shows your friends as you scroll. Scroll to the end of the list, then save it.'
        : mine.list === 'sent'
          ? 'Requests you’ve sent. Saving them marks each one Request sent in the Friends tab.'
          : k.playbooks?.length
            ? 'Sorted by how they fit your playbooks, the best first.'
            : 'Say what to look for in a playbook, in quotes, to sort these by fit.',
    ),
    button(
      busy
        ? 'Saving…'
        : mine.list === 'friends'
          ? `Save my ${counted(count, 'friend')}`
          : these(mine.list === 'sent' ? 'sent request' : 'request'),
      () => void saveList(mine),
      { primary: true, disabled: busy },
    ),
  );
}

/** How a group fits the playbooks: "Work these", and why. Nothing until the playbooks are known. */
function groupFitView(facts: GroupFacts): Child {
  const playbooks = known?.groupPlaybooks;
  if (!playbooks) return null;
  const fit = bestGroupFit(playbooks, facts);
  return h(
    'div',
    {},
    chip(
      GROUP_VERDICTS[fit.verdict],
      fit.verdict === 'skip' ? 'warn' : fit.verdict === 'work' ? 'saved' : 'plain',
    ),
    fit.reasons.length ? h('span', { class: 'muted' }, fit.reasons.join(' · ')) : null,
  );
}

/** How a group in a list fits, beside it. */
export function groupLinkFit(link: GroupLink): Child {
  return groupFitView({
    name: link.name,
    detail: link.detail,
    joined: null,
    ...groupDetailFacts(link.detail),
  });
}

/** Saving the groups a page lists: yours, or search results. */
export function groupsBlock(result: ReadResult): HTMLElement | null {
  const k = known;
  const groups = result.groups ?? [];
  if (!k || !groups.length) return null;
  const busy = saving.has('groups');
  return block(
    h(
      'p',
      { class: 'muted' },
      k.groupPlaybooks?.length
        ? 'Each group shows how it fits your playbooks. Save them to see them all in the Groups tab.'
        : 'Add words to search for groups to a playbook, and each group here shows how it fits.',
    ),
    button(
      busy
        ? 'Saving…'
        : groups.length === 1
          ? 'Save this group'
          : `Save these ${groups.length.toLocaleString()} groups`,
      () => void saveGroups(groups),
      { primary: true, disabled: busy },
    ),
  );
}

/**
 * The group on the page: how it fits, and saving it with the people its list shows. Today suggests a group's members
 * only once its full list of admins and moderators is saved, so nobody who runs it is ever approached.
 */
export function groupBlock(result: ReadResult): HTMLElement | null {
  const k = known;
  const page = result.group;
  if (!k || !page?.group) return null;
  const busy = saving.has(`group:${page.group.id}`);
  const people = result.people?.length ?? 0;
  const adminsPage = isAdminsPage(result.url);
  const adminsUrl = `${page.group.url.replace(/\/?$/, '/')}members/admins`;
  return block(
    groupFitView({
      name: page.name,
      detail: null,
      members: page.members,
      privacy: page.privacy,
      joined: page.joined,
    }),
    adminsPage
      ? h(
          'p',
          { class: 'muted' },
          'Everyone here runs the group. Save them so Today never suggests them, and starts suggesting the group’s members.',
        )
      : result.kind === 'group-members'
        ? h(
            'p',
            { class: 'muted' },
            'Scroll to load more people, then save them. Today suggests them once the group’s ',
            link('admins and moderators', adminsUrl),
            ' are saved too.',
          )
        : null,
    button(
      busy
        ? 'Saving…'
        : !people
          ? 'Save this group'
          : adminsPage
            ? `Save ${counted(people, 'admin or moderator', 'admins and moderators')}`
            : `Save this group and ${counted(people, 'person', 'people')}`,
      () => void saveGroup(result),
      { primary: true, disabled: busy },
    ),
  );
}

/** Saving the chat on the page: who it's saved with and how much, or the button. */
export function chatBlock(chat: ChatPage): HTMLElement | null {
  const k = known;
  if (!k || !chat.thread || !chat.name) return null;
  const busy = saving.has(`chat:${chat.thread.id}`);
  const savedChat = k.threads.get(chat.thread.id);
  const savedProfile = chat.profile ? k.profiles.get(profileKey(chat.profile)) : null;
  const sameNames = k.names.get(nameKey(chat.name));
  if (savedChat === undefined || savedProfile === undefined) return checking();
  const save = (text: string, personId?: string) =>
    button(busy ? 'Saving…' : text, () => void saveChat(chat, personId), {
      primary: true,
      disabled: busy,
    });
  if (savedChat)
    return block(
      h(
        'p',
        {},
        'Saved with ',
        hfosLink(savedChat.name, personUrl(savedChat.personId)),
        `: ${counted(savedChat.kept, 'message')}, last saved ${ago(savedChat.lastSavedAt)}.`,
      ),
      save('Save new messages'),
    );
  if (savedProfile)
    return block(
      h(
        'p',
        {},
        'Their profile is saved as ',
        hfosLink(savedProfile.name, personUrl(savedProfile.personId)),
        '.',
      ),
      save('Save this chat'),
    );
  if (sameNames === undefined) return checking();
  if (!chat.profile && !sameNames.length)
    return block(
      h(
        'p',
        { class: 'muted' },
        'This chat doesn’t link to anyone’s profile, so it can’t tell who it’s with. Group chats can’t be saved yet.',
      ),
    );
  return block(
    sameNames.length
      ? sameNameView(sameNames, (personId) => void saveChat(chat, personId), busy)
      : null,
    chat.profile ? save(sameNames.length ? 'Save as someone new' : 'Save this chat') : null,
  );
}

/** "In HandsFreeOS" beside someone in a list who's saved there, linking to them. */
export function savedChip(profile: ProfileRef | null | undefined): Child {
  const saved = profile ? known?.profiles.get(profileKey(profile)) : null;
  return saved ? savedLink(saved) : null;
}

/** "Saved" beside a chat in the list that's saved. */
export function savedChatChip(threadId: string): Child {
  const saved = known?.threads.get(threadId);
  return saved ? savedLink(saved, 'Saved') : null;
}

function savedLink(saved: Saved, text = 'In HandsFreeOS'): HTMLElement {
  const element = chip(text, 'saved');
  element.replaceChildren(hfosLink(text, personUrl(saved.personId)));
  return element;
}

// ------------------------------------------------------------------------------------------------- starting

/** Draws the account into `into`, and asks the background who's signed in. */
export async function startHfos(options: {
  readonly into: HTMLElement;
  readonly say: (text: string) => void;
  readonly redraw: () => void;
  /** The person signed in or out, or picked another business. */
  readonly accountChanged: () => void;
}): Promise<void> {
  box = options.into;
  say = options.say;
  redraw = options.redraw;
  accountChanged = options.accountChanged;
  drawAccount();
  await loadAccount();
}

/** Asks again who's signed in and where they can save: the background answers from what it heard in the last minute. */
export async function refreshAccount(): Promise<void> {
  await loadAccount();
}
