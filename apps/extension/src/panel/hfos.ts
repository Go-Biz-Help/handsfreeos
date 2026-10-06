/**
 * HandsFreeOS in the side panel: signing in, the business it saves to, which people and chats on the page are saved
 * there already, and the Save buttons. The background worker does the talking (src/hfos/session.ts); this keeps what
 * it said and draws it. Nothing is saved until the person presses a button.
 */
import type { ChatPage, ProfilePage, ProfileRef, ReadResult } from '../facebook/types';
import { LOOKUP_NAMES, LOOKUP_PROFILES, LOOKUP_THREADS } from '@hfos/core/addons/outreach/limits';
import { profileKey } from '../facebook/urls';
import type { Account, Business, HfosAnswer, Lookup, Problem } from '../hfos/messages';
import { chatSave, nameKey, onPage, profileSave } from '../hfos/saves';
import { ask } from './ask';
import { ago, button, chip, counted, h, hfosLink, type Child } from './dom';

type SameName = Lookup['sameName'][number]['people'][number];

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
  const on = onPage(result);
  const profiles = on.profiles
    .filter((p) => !k.profiles.has(profileKey(p)))
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
  for (const p of profiles) k.profiles.set(profileKey(p), null);
  for (const saved of answer.value.profiles) {
    const found = { personId: saved.personId, name: saved.name };
    if (saved.id) k.profiles.set(`id:${saved.id}`, found);
    if (saved.username) k.profiles.set(`user:${saved.username.toLowerCase()}`, found);
  }
  for (const t of threads) k.threads.set(t, null);
  for (const t of answer.value.threads) k.threads.set(t.key, t);
  for (const n of answer.value.sameName) k.names.set(nameKey(n.name), n.people);
  if (k === known) redraw();
}

/** Forgets what it knew about this page, so the next look-up asks again: after "Read this page". */
export function forget(result: ReadResult): void {
  if (!known) return;
  const on = onPage(result);
  for (const p of on.profiles) known.profiles.delete(profileKey(p));
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

/** Saving the profile on the page: where it's saved, or the button. Nothing while there's nowhere to save. */
export function profileBlock(page: ProfilePage): HTMLElement | null {
  const k = known;
  if (!k || page.friendship === 'self' || !page.profile || !page.name) return null;
  const key = profileKey(page.profile);
  const busy = saving.has(key);
  const saved = k.profiles.get(key);
  const sameNames = k.names.get(nameKey(page.name));
  if (saved === undefined || (saved === null && sameNames === undefined)) return checking();
  if (saved)
    return block(
      h('p', {}, 'In HandsFreeOS as ', hfosLink(saved.name, personUrl(saved.personId)), '.'),
      button(busy ? 'Saving…' : 'Save again', () => void saveProfile(page), { disabled: busy }),
    );
  const same = sameNames ?? [];
  return block(
    same.length ? sameNameView(same, (personId) => void saveProfile(page, personId), busy) : null,
    button(
      busy ? 'Saving…' : same.length ? 'Save as someone new' : 'Save to HandsFreeOS',
      () => void saveProfile(page),
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
