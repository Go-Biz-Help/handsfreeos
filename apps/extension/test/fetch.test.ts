/**
 * Getting Facebook's download file for the person (src/facebook/fetch.ts): finding each step by Facebook's words on
 * hand-written screens, pressing only what's on top, leaving ticked boxes ticked, waiting while Facebook asks for a
 * password, and walking a request through a made-up Accounts Center that draws one screen after another.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  doPath,
  doStep,
  FETCH_PLANS,
  fetchPage,
  findStep,
  type FetchStep,
  type StepResult,
} from '../src/facebook/fetch';
import { boxEverything } from './load';

/** A screen with a bare box around each of its elements, as test/load.ts does to a whole page. */
function boxIn(root: Element): void {
  const doc = root.ownerDocument;
  for (const element of [...root.querySelectorAll('*')]) {
    const box = doc.createElement(/^(LABEL|SPAN|INPUT)$/.test(element.tagName) ? 'span' : 'div');
    element.replaceWith(box);
    box.append(element);
  }
}

const AC = 'https://accountscenter.facebook.com/info_and_permissions/dyi/';

function page(body: string, url = AC): Document {
  return new JSDOM(`<!doctype html><body>${body}</body>`, { url }).window.document;
}

const press = (words: string[], more: Partial<FetchStep> = {}): FetchStep => ({
  action: 'press',
  words,
  says: `Press “${words[0]}”.`,
  ...more,
});

describe('finding a step', () => {
  it('goes by a label that is one of the words, or starts with one', () => {
    const doc = page(`
      <div role="button" tabindex="0">Formatting help</div>
      <div role="button" tabindex="0" id="row">Format <span>HTML</span></div>`);
    expect(findStep(doc, press(['Format']))?.id).toBe('row');
  });

  it('prefers a label that is exactly the word', () => {
    const doc = page(`
      <div role="button" id="long">Download your information</div>
      <div role="button" id="short">Download</div>`);
    expect(findStep(doc, press(['Download']))?.id).toBe('short');
    expect(
      findStep(
        page('<a href="/x">Download your information</a>'),
        press(['Download'], { exact: true }),
      ),
    ).toBe(null);
  });

  it('tries the likeliest words first', () => {
    const doc = page(`
      <a href="/dyi" id="menu">Download your information</a>
      <div role="button" id="go">Download or transfer information</div>`);
    expect(
      findStep(doc, press(['Download or transfer information', 'Download your information']))?.id,
    ).toBe('go');
  });

  it('looks only in the box on top, never behind it', () => {
    const doc = page(`
      <div role="button" id="behind">Next</div>
      <div role="dialog"><div role="button" id="first">Next</div></div>
      <div role="dialog"><div role="button" id="top">Cancel</div></div>`);
    expect(findStep(doc, press(['Cancel']))?.id).toBe('top');
    expect(findStep(doc, press(['Next']))).toBe(null);
  });

  it('leaves out what is hidden from the person, and buttons turned off', () => {
    const doc = page(`
      <div aria-hidden="true"><div role="button" id="copy">Create files</div></div>
      <div role="button" id="off" aria-disabled="true">Create files</div>`);
    expect(findStep(doc, press(['Create files']))).toBe(null);
  });

  it('finds a box by its row’s words, and the Facebook profile anywhere in its row', () => {
    const doc = page(`
      <div role="listitem"><span>Pat Example</span><span>Instagram</span><input type="checkbox" id="ig"></div>
      <div role="listitem"><span>Pat Example</span><span>Facebook</span><input type="checkbox" id="fb"></div>
      <label><input type="checkbox" id="friends"> Friends and followers</label>`);
    expect(
      findStep(doc, { action: 'tick', words: ['Facebook'], anywhere: true, says: '' })?.id,
    ).toBe('fb');
    expect(findStep(doc, { action: 'tick', words: ['Friends and followers'], says: '' })?.id).toBe(
      'friends',
    );
  });
});

describe('doing a step', () => {
  it('ticks a box, and leaves one already ticked as it is', () => {
    const doc = page(`
      <label><input type="checkbox" id="m"> Messages</label>
      <div role="checkbox" aria-checked="true" id="f" tabindex="0">Friends and followers</div>`);
    const messages = { action: 'tick', words: ['Messages'], says: '' } as const;
    expect(doStep(doc, messages)).toBe('done');
    expect((doc.getElementById('m') as HTMLInputElement).checked).toBe(true);
    expect(doStep(doc, messages)).toBe('already');
    let pressed = false;
    doc.getElementById('f')!.addEventListener('click', () => (pressed = true));
    expect(doStep(doc, { action: 'tick', words: ['Friends and followers'], says: '' })).toBe(
      'already',
    );
    expect(pressed).toBe(false);
  });

  it('says when Facebook is waiting for the person to type', () => {
    const doc = page(`<div role="dialog"><input type="password" aria-label="Password"></div>`);
    expect(doStep(doc, press(['Download'], { exact: true }))).toBe('waiting');
    expect(doStep(page('<p>Nothing here</p>'), press(['Download']))).toBe('missing');
  });

  it('along a path, presses the furthest step on the page', () => {
    const steps = FETCH_PLANS.backup.steps;
    const doc = page(
      `<div role="menu">
         <div role="menuitem" id="safety">Privacy &amp; safety</div>
         <div role="menuitem" id="storage">Message storage</div>
       </div>`,
      'https://www.facebook.com/messages/',
    );
    const clicked: string[] = [];
    for (const id of ['safety', 'storage'])
      doc.getElementById(id)!.addEventListener('click', () => clicked.push(id));
    expect(doPath(doc, steps, 0)).toEqual({ at: 3 });
    expect(clicked).toEqual(['storage']);
    expect(doPath(doc, steps, 4)).toEqual({ result: 'missing' });
  });
});

describe('the pages it presses on', () => {
  it('is only Facebook’s download pages', () => {
    expect(fetchPage(AC)).toBe(true);
    expect(fetchPage('https://accountscenter.facebook.com/info_and_permissions/dyi/?entry=1')).toBe(
      true,
    );
    expect(fetchPage('https://www.facebook.com/messages/t/123')).toBe(true);
    expect(fetchPage('https://accountscenter.facebook.com/password_and_security')).toBe(false);
    expect(fetchPage('https://www.facebook.com/friends/requests')).toBe(false);
    expect(fetchPage('https://www.facebook.com.example.com/messages/')).toBe(false);
    expect(fetchPage('http://accountscenter.facebook.com/info_and_permissions/dyi/')).toBe(false);
  });
});

/**
 * A made-up Accounts Center: each press draws the next screen in a dialog, as Facebook's does. Its words are the
 * ones Facebook used in 2025 and 2026 guides; the real screens may differ, which is why a step it can't find is
 * handed to the person.
 */
function accountsCenter(boxed: boolean) {
  const doc = page(`
    <nav><a href="/info_and_permissions/dyi/">Download your information</a></nav>
    <main><div role="button" tabindex="0" data-go="profiles">Download or transfer information</div></main>`);
  if (boxed) boxEverything(doc);
  const chosen: Record<string, string> = { range: 'Last year', format: 'HTML', quality: 'Medium' };
  const ticked = new Set<string>();
  let created = false;
  let screen = '';
  const dialog = (html: string) => {
    doc.querySelectorAll('[role="dialog"]').forEach((d) => d.remove());
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    box.innerHTML = html;
    if (boxed) boxIn(box);
    doc.body.append(box);
  };
  const options = () =>
    dialog(`
      <h2>Create files to download</h2>
      <div role="button" tabindex="0" data-go="range">Date range <span>${chosen.range}</span></div>
      <div role="button" tabindex="0" data-go="format">Format <span>${chosen.format}</span></div>
      <div role="button" tabindex="0" data-go="quality">Media quality <span>${chosen.quality}</span></div>
      <div role="button" tabindex="0" data-go="create">Create files</div>`);
  const choose = (what: string, choices: string[]) =>
    dialog(`
      <h2>${what}</h2>
      ${choices.map((c) => `<label><input type="radio" name="c" value="${c}"> ${c}</label>`).join('')}
      <div role="button" tabindex="0" data-go="save-${what}">Save</div>`);
  const draw: Record<string, () => void> = {
    profiles: () =>
      dialog(`
        <h2>Which profiles?</h2>
        <div role="listitem"><span>Pat Example</span><span>Facebook</span><input type="checkbox" data-tick="profile"></div>
        <div role="button" tabindex="0" data-go="how">Next</div>`),
    how: () =>
      dialog(`
        <div role="button" tabindex="0" data-go="all">Available information</div>
        <div role="button" tabindex="0" data-go="types">Some of your information</div>`),
    types: () =>
      dialog(`
        <label><input type="checkbox" data-tick="likes"> Likes and reactions</label>
        <label><input type="checkbox" data-tick="friends"> Friends and followers</label>
        <label><input type="checkbox" data-tick="messages"> Messages</label>
        <div role="button" tabindex="0" data-go="where">Next</div>`),
    where: () =>
      dialog(`
        <div role="button" tabindex="0" data-go="options">Download to device</div>
        <div role="button" tabindex="0" data-go="transfer">Transfer to destination</div>`),
    options,
    range: () => choose('range', ['Last year', 'All time']),
    format: () => choose('format', ['HTML', 'JSON']),
    quality: () => choose('quality', ['High', 'Medium', 'Low']),
    create: () => {
      created = true;
      dialog('<p>We’re creating your files.</p>');
    },
  };
  doc.addEventListener('click', (event) => {
    const target = event.target as Element;
    const tick = target.closest('[data-tick]');
    if (tick) {
      const name = tick.getAttribute('data-tick')!;
      if ((tick as HTMLInputElement).checked) ticked.add(name);
      else ticked.delete(name);
      return;
    }
    const go = target.closest('[data-go]')?.getAttribute('data-go');
    if (!go) return;
    screen = go;
    if (go.startsWith('save-')) {
      const picked = doc.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      if (picked) chosen[go.slice(5)] = picked.value;
      options();
      return;
    }
    draw[go]?.();
  });
  return { doc, chosen, ticked, created: () => created, screen: () => screen };
}

/** Runs a plan's steps the way the panel does, without the waiting: what each step came to. */
function runSteps(doc: Document, steps: readonly FetchStep[]): StepResult[] {
  const results: StepResult[] = [];
  let before: StepResult = 'done';
  for (const step of steps) {
    if (step.afterPrevious && before !== 'done' && before !== 'already') {
      results.push((before = 'missing'));
      continue;
    }
    before = doStep(doc, step);
    results.push(before);
  }
  return results;
}

describe('asking Facebook for the file', () => {
  for (const boxed of [false, true])
    it(`ticks Friends and followers and Messages, picks All time, JSON and Low, and creates the files${boxed ? ', in more boxes' : ''}`, () => {
      const made = accountsCenter(boxed);
      const results = runSteps(made.doc, FETCH_PLANS.request.steps);
      const required = FETCH_PLANS.request.steps
        .map((step, i) => [step, results[i]] as const)
        .filter(([step]) => !step.optional && !step.afterPrevious);
      expect(required.every(([, result]) => result === 'done' || result === 'already')).toBe(true);
      expect([...made.ticked].sort()).toEqual(['friends', 'messages', 'profile']);
      expect(made.chosen).toEqual({ range: 'All time', format: 'JSON', quality: 'Low' });
      expect(made.created()).toBe(true);
    });

  it('downloads a file that’s ready', () => {
    const doc = page(`
      <div role="tablist"><div role="tab" tabindex="0" id="tab">Available downloads</div></div>
      <div role="listitem"><span>Your information · Oct 9</span><div role="button" tabindex="0" id="get">Download</div></div>`);
    let got = false;
    doc.getElementById('get')!.addEventListener('click', () => (got = true));
    expect(runSteps(doc, FETCH_PLANS.download.steps)).toEqual(['done', 'done']);
    expect(got).toBe(true);
  });
});
