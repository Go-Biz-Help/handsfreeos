/**
 * Signing in, in the side panel: an emailed code or a password, for a HandsFreeOS account that already exists, and
 * the business it works for when the person has more than one with Social Outreach. The background worker holds the
 * sign-in (src/hfos/session.ts); this draws it and asks.
 */
import type { Account, HfosAnswer, Problem } from '../hfos/messages';
import { ask } from './ask';
import { button, h, hfosLink, type Child } from './dom';

type Step =
  | { readonly kind: 'email' }
  | { readonly kind: 'code'; readonly email: string }
  | { readonly kind: 'password'; readonly email: string };

const CODE = /^\d{6,10}$/;

let box: HTMLElement;
let accountChanged: (account: Account | null) => void = () => undefined;

/** Null until the background has said; a problem when it couldn't. */
let account: Account | null = null;
let accountProblem: Problem | null = null;
let step: Step = { kind: 'email' };
let typedEmail = '';
let formError: string | null = null;
let working = false;

// ------------------------------------------------------------------------------------------------- the account

/** Takes what the background said about the sign-in. */
function take(next: Account): void {
  const changed = accountProblem !== null || JSON.stringify(next) !== JSON.stringify(account);
  account = next;
  accountProblem = null;
  if (!changed) return;
  drawAccount();
  accountChanged(next);
}

async function loadAccount(fresh = false): Promise<void> {
  const answer = await ask({ type: 'hfos-account', fresh });
  if (answer.ok) return take(answer.value);
  accountProblem = answer.problem;
  drawAccount();
}

/** What went wrong, said under the account; and when the sign-in or the business may have changed, asked again. */
function problem(p: Problem): void {
  formError = p.message;
  drawAccount();
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
    'Sign in with your HandsFreeOS account. The extension works for you only once you have.',
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
      h('h2', {}, 'Sign in to HandsFreeOS'),
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
        'None of your businesses has Social Outreach on, or you can’t use it there. Ask an owner of the business to turn it on in Add-ons, or to let you use it.',
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
  return h('div', {}, h('p', { class: 'saving-to' }, 'Working for ', where), who, errorLine());
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
      'This build can’t sign in to HandsFreeOS, so it can’t work for you.',
    );
  else content = signInView();
  box.replaceChildren(content);
}

/** Draws the account into `into`, and asks the background who's signed in. `changed` hears every change. */
export async function startAccount(
  into: HTMLElement,
  changed: (account: Account | null) => void,
): Promise<void> {
  box = into;
  accountChanged = changed;
  drawAccount();
  await loadAccount();
}

/** Asks again who's signed in and where they can save: the background answers from what it heard in the last minute. */
export async function refreshAccount(): Promise<void> {
  await loadAccount();
}
