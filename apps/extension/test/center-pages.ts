/**
 * Accounts Center's name and username pages as Meta behaves on them, for the writers' tests and the jobs' fake tabs:
 * the made-up pages of test/fixtures/accounts-center-*-2026-10.html (nobody real), with what turns their buttons on,
 * what Meta says of what's typed, and what Done saves. Built from Meta's usual behaviour on these pages, not yet from a
 * page outline of them (decision 89).
 */
import { boxEverything, load } from './load';

export const FB_CENTER = 'https://accountscenter.facebook.com';
export const IG_CENTER = 'https://accountscenter.instagram.com';
/** The made-up profiles' numbers, as accounts-center-profiles-2026-10.html lists them. */
export const FB_PROFILE = '100001234';
export const IG_PROFILE = '17841400000000001';
export const FB_NAME_PAGE = `${FB_CENTER}/profiles/${FB_PROFILE}/name/`;
export const IG_USERNAME_PAGE = `${IG_CENTER}/profiles/${IG_PROFILE}/username/`;
export const IG_NAME_PAGE = `${IG_CENTER}/profiles/${IG_PROFILE}/name/`;

/** A box over the page, with these insides. */
export function dialogIn(doc: Document, html: string): HTMLElement {
  const box = doc.createElement('div');
  box.setAttribute('role', 'dialog');
  box.innerHTML = html;
  doc.body.append(box);
  return box;
}

const PASSWORD =
  '<h2>Re-enter your password</h2><input type="password" aria-label="Password" /><div role="button">Continue</div>';
const CONFIRM_FIRST =
  '<h2>Confirm it’s you</h2><label><input type="radio" name="how" /> Enter your password</label>' +
  '<label><input type="radio" name="how" /> Get a code by email</label><div role="button">Continue</div>';
const CODE = '<h2>Enter the code we sent</h2><input type="tel" /><div role="button">Confirm</div>';

/** Meta's box after Done: its heading, the button that saves, and a switch in it, on, named only by these words. */
export interface Sure {
  readonly says?: string;
  readonly button: string;
  readonly tick?: string;
}

/** A box after Done's insides: its heading, Cancel and its button, and its switch when it has one. */
const sureHtml = (sure: Sure, heading: string): string =>
  `<h2>${sure.says ?? heading}</h2>` +
  (sure.tick ? `<div role="switch" aria-checked="true" aria-label="${sure.tick}"></div>` : '') +
  `<div role="button">Cancel</div><div role="button">${sure.button}</div>`;

/** The person answered what Meta asked, in its window: the box goes, and what was waiting is saved. */
function answered(doc: Document): boolean {
  const asked = [...doc.querySelectorAll('input[type="password"], input[type="tel"]')].map((box) =>
    box.closest('[role="dialog"]'),
  );
  for (const box of asked) box?.remove();
  return asked.length > 0;
}

export interface FacebookNamePlan {
  readonly boxed?: boolean;
  /** Facebook says this on the page before anything's typed. */
  readonly saysFirst?: string;
  /** Its boxes held: nothing can be typed. */
  readonly held?: boolean;
  /** Facebook asks for the password before anything's typed, or on the step after Review change, by its Done. */
  readonly password?: 'before' | 'review';
  /** It asks how to confirm it's them first, with ways to pick. */
  readonly confirmFirst?: boolean;
  /** It asks for a code after Done, in a box for a phone's keypad. */
  readonly code?: boolean;
  /** Facebook's answer to the name: on Review change (the step after it never opens), or after Done. */
  readonly refuses?: { readonly on: 'review' | 'done'; readonly says: string };
  /** It looks at the name before it shows, as it says after Done. */
  readonly reviewing?: boolean;
  /** How the name is shown, on the step after Review change: one picked (as Facebook has it), none picked, or not asked. */
  readonly order?: 'picked' | 'unpicked' | 'none';
  /**
   * An offer, ticked, to change the Instagram profile's name too: on the page, or only on the step after Review
   * change.
   */
  readonly sync?: boolean;
  readonly syncOnReview?: boolean;
  /** A box after Done: Facebook's to be sure, or one the extension doesn't know. */
  readonly sure?: Sure;
  /** The profile shows the name last name first, as the order Facebook has already picked does. */
  readonly lastFirst?: boolean;
  /** Done leaves the name page for the profile's own. */
  readonly leaves?: boolean;
  /** Once the name saves, Facebook says this on its page and holds its boxes, as it does till the next change. */
  readonly holdsAfter?: string;
  /** Done closes its step and saves nothing: the boxes keep what was typed, or go back to the name there. */
  readonly unsaved?: 'kept' | 'undone';
  /** Facebook's block over the page. */
  readonly blocked?: boolean;
}

/**
 * Facebook's name page: typing turns Review change on, which opens the step after it (how the name is shown, and Done);
 * Done saves it, or first asks for the password, a code, or to be sure. Saved, the page shows the name in its boxes
 * with Review change off.
 */
export function facebookNamePage(plan: FacebookNamePlan = {}, url = FB_NAME_PAGE) {
  const doc = load('accounts-center-name-2026-10.html', url);
  if (plan.boxed) boxEverything(doc);
  const first = doc.getElementById('n1') as HTMLInputElement;
  const middle = doc.getElementById('n2') as HTMLInputElement;
  const last = doc.getElementById('n3') as HTMLInputElement;
  const review = doc.getElementById('review')!;
  const said = doc.getElementById('said')!;
  const pressed = { review: 0, done: 0, sure: 0 };
  const was = { first: first.value, middle: middle.value, last: last.value };
  let saved: string | null = null;
  let step: HTMLElement | null = null;
  const nameNow = () =>
    [first.value, middle.value, last.value]
      .map((v) => v.trim())
      .filter(Boolean)
      .join(' ');
  const save = () => {
    saved = plan.lastFirst
      ? [last.value, first.value, middle.value]
          .map((v) => v.trim())
          .filter(Boolean)
          .join(' ')
      : nameNow();
    step?.remove();
    step = null;
    review.setAttribute('aria-disabled', 'true');
    if (plan.holdsAfter) {
      said.textContent = plan.holdsAfter;
      for (const box of [first, middle, last]) box.setAttribute('readonly', '');
    }
    if (plan.leaves) doc.defaultView!.history.pushState({}, '', `/profiles/${FB_PROFILE}/`);
  };
  if (plan.saysFirst) said.textContent = plan.saysFirst;
  if (plan.held) for (const box of [first, middle, last]) box.setAttribute('readonly', '');
  if (plan.sync)
    doc
      .getElementById('name-form')!
      .insertAdjacentHTML(
        'beforeend',
        '<label><input type="checkbox" checked /> Change your name on Instagram too</label>',
      );
  if (plan.password === 'before') dialogIn(doc, PASSWORD);
  if (plan.confirmFirst) dialogIn(doc, CONFIRM_FIRST);
  if (plan.blocked)
    dialogIn(
      doc,
      '<h2>You’re temporarily blocked</h2><span>It looks like you were going too fast. Try again later.</span><div role="button">OK</div>',
    );
  for (const box of [first, middle, last])
    box.addEventListener('input', () => {
      review.setAttribute('aria-disabled', 'true');
      setTimeout(() => {
        const changed =
          first.value !== was.first || middle.value !== was.middle || last.value !== was.last;
        if (changed) review.removeAttribute('aria-disabled');
      }, 300);
    });
  review.addEventListener('click', () => {
    pressed.review++;
    if (review.getAttribute('aria-disabled') === 'true') return;
    if (plan.refuses?.on === 'review') {
      said.textContent = plan.refuses.says;
      review.setAttribute('aria-disabled', 'true');
      return;
    }
    const name = nameNow();
    const order = plan.order ?? 'picked';
    // What was typed goes into the choices as text, never as HTML.
    const radios =
      order === 'none'
        ? ''
        : `<div role="radiogroup"><label><input type="radio" name="order" ${order === 'picked' ? 'checked' : ''} /> <span data-order="picked"></span></label>` +
          '<label><input type="radio" name="order" /> <span data-order="last-first"></span></label></div>';
    const password =
      plan.password === 'review'
        ? '<span>To save this setting, enter your Facebook password.</span><input type="password" aria-label="Password" />'
        : '';
    const sync = plan.syncOnReview
      ? '<label><input type="checkbox" checked /> Also change your name on Instagram</label>'
      : '';
    step = dialogIn(
      doc,
      `<h2>Review your name</h2><span>How would you like it to appear on your profile?</span>${radios}${password}${sync}` +
        '<div role="button" id="name-done"><span>Done</span></div>',
    );
    step.querySelector('[data-order="picked"]')?.append(name);
    step.querySelector('[data-order="last-first"]')?.append(`${last.value}, ${first.value}`);
    const thisStep = step;
    thisStep.querySelector('#name-done')!.addEventListener('click', () => {
      pressed.done++;
      // Its Done waits for the password: the person types it there.
      if (plan.password === 'review' && thisStep.querySelector('input[type="password"]')) return;
      if (plan.refuses?.on === 'done') {
        thisStep.insertAdjacentHTML(
          'beforeend',
          `<div role="alert"><span>${plan.refuses.says}</span></div>`,
        );
        return;
      }
      if (plan.code) {
        thisStep.remove();
        step = null;
        dialogIn(doc, CODE);
        return;
      }
      if (plan.sure) {
        const sure = dialogIn(doc, sureHtml(plan.sure, 'Change name?'));
        sure.querySelectorAll('[role="button"]')[1]!.addEventListener('click', () => {
          pressed.sure++;
          sure.remove();
          save();
        });
        return;
      }
      if (plan.reviewing) {
        thisStep.remove();
        step = null;
        review.setAttribute('aria-disabled', 'true');
        said.textContent = 'We’re reviewing your name change. This may take up to 24 hours.';
        return;
      }
      if (plan.unsaved) {
        thisStep.remove();
        step = null;
        if (plan.unsaved === 'undone')
          for (const [box, value] of [
            [first, was.first],
            [middle, was.middle],
            [last, was.last],
          ] as const)
            box.value = value;
        return;
      }
      save();
    });
  });
  return {
    doc,
    boxes: { first, middle, last },
    pressed: () => ({ ...pressed }),
    saved: () => saved,
    passwordBox: () => doc.querySelector<HTMLInputElement>('input[type="password"]'),
    /** The person typed what Facebook asked for and pressed its button: the name saves, if Done was waiting for it. */
    continued: () => {
      const onStep = step?.querySelector('input[type="password"]') ?? null;
      const after = doc.querySelector('input[type="tel"]') !== null;
      answered(doc);
      if (onStep || after) save();
    },
  };
}

export interface InstagramNamePlan {
  /** Instagram says this on the page before anything's typed. */
  readonly saysFirst?: string;
  /** Instagram's answer to the name after Done: it keeps it as it was. */
  readonly refuses?: string;
  /** An offer, ticked, to change the Facebook profile's name too. */
  readonly sync?: boolean;
  /** Instagram asks for the password after Done. */
  readonly password?: boolean;
  /** A box after Done: Instagram's to be sure, or one offering more. */
  readonly sure?: Sure;
}

/** A box after Done with Cancel and its button, which saves what was waiting. */
function sureBox(
  doc: Document,
  sure: Sure,
  heading: string,
  save: () => void,
  pressed: () => void,
) {
  const box = dialogIn(doc, sureHtml(sure, heading));
  box.querySelectorAll('[role="button"]')[1]!.addEventListener('click', () => {
    pressed();
    box.remove();
    save();
  });
}

/** Instagram's name page: typing turns Done on; Done saves it and goes back to the profile's page. */
export function instagramNamePage(plan: InstagramNamePlan = {}, url = IG_NAME_PAGE) {
  const doc = load('accounts-center-instagram-name-2026-10.html', url);
  const box = doc.getElementById('n1') as HTMLInputElement;
  const done = doc.getElementById('done')!;
  const said = doc.getElementById('said')!;
  const was = box.value;
  let pressed = 0;
  let sures = 0;
  let saved: string | null = null;
  const save = () => {
    saved = box.value.trim();
    done.setAttribute('aria-disabled', 'true');
    doc.defaultView!.history.pushState({}, '', `/profiles/${IG_PROFILE}/`);
  };
  if (plan.saysFirst) said.textContent = plan.saysFirst;
  if (plan.sync)
    doc
      .getElementById('name-form')!
      .insertAdjacentHTML(
        'beforeend',
        '<label><input type="checkbox" checked /> Also change your name on Facebook</label>',
      );
  box.addEventListener('input', () => {
    done.setAttribute('aria-disabled', 'true');
    setTimeout(() => {
      if (box.value !== was) done.removeAttribute('aria-disabled');
    }, 300);
  });
  done.addEventListener('click', () => {
    pressed++;
    if (done.getAttribute('aria-disabled') === 'true') return;
    if (plan.refuses) {
      said.textContent = plan.refuses;
      done.setAttribute('aria-disabled', 'true');
      return;
    }
    if (plan.password) return void dialogIn(doc, PASSWORD);
    if (plan.sure) return sureBox(doc, plan.sure, 'Change name?', save, () => sures++);
    save();
  });
  return {
    doc,
    box,
    pressed: () => pressed,
    sures: () => sures,
    saved: () => saved,
    continued: () => {
      if (answered(doc)) save();
    },
  };
}

export interface InstagramUsernamePlan {
  /** The username the box holds: the account's own, unless a test says another's. */
  readonly holds?: string;
  /** Instagram says the one typed isn't available. */
  readonly taken?: boolean;
  /** Instagram asks for the password after Done. */
  readonly password?: boolean;
  /** A box after Done: Instagram's to be sure, or one offering more. */
  readonly sure?: Sure;
  /** Instagram's own "Try Again Later" box over the page once something's typed, saying nothing of the username. */
  readonly later?: boolean;
  /** Instagram says this under the box once something's typed, and keeps Done off. */
  readonly refuses?: string;
}

/**
 * Instagram's username page: typing turns Done off, then Instagram turns it on (a tick, no words) or says the username
 * isn't available; Done saves it and goes back to the profile's page.
 */
export function instagramUsernamePage(plan: InstagramUsernamePlan = {}, url = IG_USERNAME_PAGE) {
  const doc = load('accounts-center-instagram-username-2026-10.html', url);
  const box = doc.getElementById('u1') as HTMLInputElement;
  const done = doc.getElementById('done')!;
  const said = doc.getElementById('said')!;
  if (plan.holds) box.value = plan.holds;
  let pressed = 0;
  let sures = 0;
  let saved: string | null = null;
  const save = () => {
    saved = box.value.trim();
    done.setAttribute('aria-disabled', 'true');
    doc.defaultView!.history.pushState({}, '', `/profiles/${IG_PROFILE}/`);
  };
  box.addEventListener('input', () => {
    done.setAttribute('aria-disabled', 'true');
    said.textContent = '';
    setTimeout(() => {
      if (plan.later)
        dialogIn(
          doc,
          '<h2>Try Again Later</h2><span>Please wait a few minutes before you try again.</span><div role="button">OK</div>',
        );
      else if (plan.refuses) said.textContent = plan.refuses;
      else if (plan.taken) said.textContent = `The username ${box.value} is not available.`;
      else done.removeAttribute('aria-disabled');
    }, 300);
  });
  done.addEventListener('click', () => {
    pressed++;
    if (done.getAttribute('aria-disabled') === 'true') return;
    if (plan.password) return void dialogIn(doc, PASSWORD);
    if (plan.sure) return sureBox(doc, plan.sure, 'Change username?', save, () => sures++);
    save();
  });
  return {
    doc,
    box,
    pressed: () => pressed,
    sures: () => sures,
    saved: () => saved,
    continued: () => {
      if (answered(doc)) save();
    },
  };
}
