/**
 * Getting Facebook's download file for the person (src/networks/facebook/fetch.ts): finding each step by Facebook's words on
 * hand-written screens, pressing only what's on top, leaving ticked boxes ticked, waiting while Facebook asks for a
 * password, and walking a request through a made-up Accounts Center that draws one screen after another.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  askingFor,
  doPath,
  doStep,
  FETCH_PLANS,
  fetchPage,
  findStep,
  type FetchStep,
  type StepResult,
  waitingForPerson,
} from '../src/networks/facebook/fetch';
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

  it('looks in a menu’s own menu, wherever Facebook draws it, and never on the page behind', () => {
    const doc = page(`
      <div role="button" id="behind">End-to-end encrypted chats</div>
      <div role="menu" aria-label="Privacy &amp; safety">
        <div role="menuitem" id="e2ee">End-to-end encrypted chats</div>
        <div role="menuitem">Read receipts</div>
      </div>
      <div role="menu" aria-label="Inbox settings menu">
        <div role="menuitem" aria-expanded="true">Privacy &amp; safety</div>
        <div role="menuitem">Help</div>
      </div>`);
    expect(findStep(doc, press(['End-to-end encrypted chats']))?.id).toBe('e2ee');
    doc.getElementById('e2ee')!.parentElement!.remove();
    expect(findStep(doc, press(['End-to-end encrypted chats']))).toBe(null);
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

  it('tells a password from a code, and never counts a hidden box', () => {
    expect(askingFor(page('<input type="password" aria-label="Password">'))).toBe('password');
    expect(waitingForPerson(page('<input type="password" aria-label="Password">'))).toBe(true);
    expect(askingFor(page('<input autocomplete="one-time-code" aria-label="Code">'))).toBe('code');
    expect(askingFor(page('<input inputmode="numeric" aria-label="Enter code">'))).toBe('code');
    expect(
      askingFor(page('<div hidden><input type="password"></div><input aria-label="Username">')),
    ).toBe(null);
    expect(waitingForPerson(page('<input aria-label="Username">'))).toBe(false);
  });

  it('finds the ⋯ beside Chats by where it is, whatever it’s called', () => {
    const doc = page(
      `<div role="navigation" aria-label="Chat list">
         <div><div>
           <span dir="auto"><h1>Chats</h1></span>
           <div>
             <div role="button" aria-label="Menu for the chats" aria-expanded="false" id="dots"></div>
             <a role="link" aria-label="New message" href="/messages/new/"></a>
           </div>
         </div></div>
         <div role="tablist"><div role="button" aria-expanded="false">More</div></div>
         <div role="grid" aria-label="Chats"><div role="row"><div role="gridcell">
           <div role="button" aria-label="More options for Pat Example" aria-expanded="false"></div>
         </div></div></div>
       </div>`,
      'https://www.facebook.com/messages/t/1/',
    );
    expect(findStep(doc, FETCH_PLANS.backup.steps[0]!)?.id).toBe('dots');
    boxEverything(doc);
    expect(findStep(doc, FETCH_PLANS.backup.steps[0]!)?.id).toBe('dots');
  });

  it('goes by a menu row’s name when a line about it sits under it, in a menu inside a menu', () => {
    const doc = page(
      `<div role="menu" aria-label="Inbox settings menu">
         <div aria-hidden="true">
           <div role="menuitem"><span>Preferences</span></div>
           <div role="menuitem" aria-expanded="true"><div><span>Privacy &amp; safety</span><i></i></div></div>
         </div>
         <div aria-hidden="false">
           <div role="menu" aria-label="Privacy &amp; safety">
             <div role="button" aria-label="Back"></div>
             <h2><span>Privacy &amp; safety</span></h2>
             <div role="menuitem" aria-expanded="false" id="e2ee"><div><div><span>End-to-end encrypted chats</span><span>Manage your message storage and security</span></div><i></i></div></div>
             <div role="menuitem" aria-expanded="false"><div><div><span>Read receipts</span><span>On</span></div><i></i></div></div>
           </div>
         </div>
       </div>`,
      'https://www.facebook.com/messages/t/1/',
    );
    const clicked: string[] = [];
    doc.getElementById('e2ee')!.addEventListener('click', () => clicked.push('e2ee'));
    expect(doPath(doc, FETCH_PLANS.backup.steps, 2)).toEqual({ at: 2 });
    expect(clicked).toEqual(['e2ee']);
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
 * A made-up Accounts Center: each press draws the next screen in the "Export your information" dialog, as Facebook's
 * does. Its screens and words are the ones the owner's Accounts Center showed in October 2026 (docs/outreach.md);
 * a step Facebook words differently is handed to the person.
 */
function accountsCenter(boxed: boolean, { requested = false } = {}) {
  const doc = page(`
    <nav><a href="/info_and_permissions/dyi/">Download your information</a></nav>
    <main><h1>Download your information</h1></main>`);
  if (boxed) boxEverything(doc);
  const chosen: Record<string, string> = {
    range: 'Last year',
    format: 'HTML',
    quality: 'Medium quality',
  };
  const SECTIONS: Record<string, string[]> = {
    'Your Facebook activity': ['Messages', 'Posts', 'Groups', 'Comments and reactions'],
    'Personal information': ['Profile information', 'Other personal information'],
    Connections: ['Friends', 'Followers', 'Supervision'],
    'Logged information': ['Search', 'Location'],
    'Data logs': ['Data logs'],
  };
  const ticked = new Set(
    Object.values(SECTIONS)
      .flat()
      .filter((name) => name !== 'Data logs'),
  );
  let saved: string[] = [];
  let started = false;
  const dialog = (html: string) => {
    doc.querySelectorAll('[role="dialog"]').forEach((d) => d.remove());
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Export your information');
    box.innerHTML = html;
    if (boxed) boxIn(box);
    doc.body.append(box);
  };
  const button = (go: string, words: string) =>
    `<div role="button" tabindex="0" data-go="${go}">${words}</div>`;
  const home = () =>
    dialog(`
      <h2>Export your information</h2>
      ${button('profiles', 'Create export')}
      <div role="tablist"><div role="tab" aria-selected="true">Current activity</div><div role="tab">Past activity</div></div>
      ${requested ? `<h3>Requested</h3><p>Your information is being prepared for export.</p>${button('cancel', 'Cancel')}` : ''}`);
  const confirm = () =>
    dialog(`
      <h2>Confirm your export</h2>
      ${button('notify', 'Notify <span>pat@example.com</span>')}
      ${button('customize', 'Customize information')}
      ${button('range', `Date range <span>${chosen.range}</span>`)}
      ${button('format', `Format <span>${chosen.format}</span>`)}
      ${button('quality', `Media quality <span>${chosen.quality}</span>`)}
      ${button('start', 'Start export')}`);
  const choose = (what: string, heading: string, choices: string[]) =>
    dialog(`
      <h2>${heading}</h2>
      ${choices.map((c) => `<label><input type="radio" name="c" value="${c}"> ${c}</label>`).join('')}
      ${button(`save-${what}`, 'Save')}`);
  const draw: Record<string, () => void> = {
    profiles: () =>
      dialog(`
        <h2>Choose a profile</h2>
        ${button('where', 'Pat Example <span>Facebook</span>')}
        ${button('where', 'Pat Example <span>Instagram</span>')}`),
    where: () =>
      dialog(`
        <h2>Choose where to export</h2>
        ${button('confirm', 'Export to device')}
        ${button('elsewhere', 'Export to external service')}`),
    confirm,
    customize: () =>
      dialog(`
        <h2>Choose specific info to export</h2>
        ${Object.entries(SECTIONS)
          .map(
            ([section, names]) => `
              <section data-section="${section}">
                <h3>${section}</h3>
                <div role="button" tabindex="0" data-clear="${section}">Clear all</div>
                ${names
                  .map(
                    (name) =>
                      `<label><input type="checkbox" name="${name}"${ticked.has(name) ? ' checked' : ''}> ${name}</label>`,
                  )
                  .join('')}
              </section>`,
          )
          .join('')}
        ${button('save-info', 'Save')}`),
    range: () =>
      choose('range', 'Date range', [
        'Last week',
        'Last year',
        'Last 3 years',
        'All time',
        'Custom',
      ]),
    format: () => choose('format', 'Format', ['HTML', 'JSON']),
    quality: () =>
      choose('quality', 'Media quality', ['Higher quality', 'Medium quality', 'Lower quality']),
    start: () => {
      started = true;
      home();
    },
  };
  doc.addEventListener('click', (event) => {
    const target = event.target as Element;
    const clear = target.closest('[data-clear]');
    if (clear) {
      clear
        .closest('section')!
        .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
        .forEach((box) => {
          box.checked = false;
          ticked.delete(box.name);
        });
      return;
    }
    const box = target.closest<HTMLInputElement>('input[type="checkbox"]');
    if (box) {
      if (box.checked) ticked.add(box.name);
      else ticked.delete(box.name);
      return;
    }
    const go = target.closest('[data-go]')?.getAttribute('data-go');
    if (!go) return;
    if (go === 'save-info') {
      saved = [...ticked].sort();
      confirm();
      return;
    }
    if (go.startsWith('save-')) {
      const picked = doc.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      if (picked) chosen[go.slice(5)] = picked.value;
      confirm();
      return;
    }
    draw[go]?.();
  });
  home();
  return { doc, chosen, saved: () => saved, started: () => started };
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
    it(`keeps only Messages, Friends and Followers, picks All time, JSON and Lower quality, and starts the export${boxed ? ', in more boxes' : ''}`, () => {
      const made = accountsCenter(boxed);
      const steps = FETCH_PLANS.request.steps;
      const results = runSteps(made.doc, steps);
      const required = steps
        .map((step, i) => [step, results[i]] as const)
        .filter(([step]) => !step.optional && !step.afterPrevious);
      expect(required.every(([, result]) => result === 'done' || result === 'already')).toBe(true);
      expect(made.saved()).toEqual(['Followers', 'Friends', 'Messages']);
      expect(made.chosen).toEqual({ range: 'All time', format: 'JSON', quality: 'Lower quality' });
      expect(made.started()).toBe(true);
    });

  it('stops when Facebook is making a file already', () => {
    const made = accountsCenter(false, { requested: true });
    expect(doStep(made.doc, FETCH_PLANS.request.steps[0]!)).toBe('stop');
    expect(doStep(accountsCenter(false).doc, FETCH_PLANS.request.steps[0]!)).toBe('missing');
  });

  it('downloads a file that’s ready', () => {
    const doc = page(`
      <div role="dialog" aria-label="Export your information">
        <div role="tablist"><div role="tab" tabindex="0" id="tab">Current activity</div></div>
        <div role="listitem"><span>Your information · Oct 9</span><div role="button" tabindex="0" id="get">Download</div></div>
      </div>`);
    let got = false;
    doc.getElementById('get')!.addEventListener('click', () => (got = true));
    expect(runSteps(doc, FETCH_PLANS.download.steps)).toEqual(['done', 'done']);
    expect(got).toBe(true);
  });
});

describe('getting the chat backup', () => {
  it('on its own page, picks All time by its label, leaves out the media, then downloads', () => {
    const doc = page(
      `<main>
        <h1>Download your message storage data</h1>
        <label><input type="checkbox" checked disabled> Messages</label>
        <label><input type="checkbox" id="media" checked> Media</label>
        <label><input type="radio" name="q" value="high"> Higher-quality media</label>
        <label><input type="radio" name="q" value="low" checked> Lower-quality media</label>
        <label><input type="radio" name="r" value="year" checked> Last year</label>
        <label><input type="radio" name="r" id="all" aria-label="From account creation"> All time</label>
        <div role="button" tabindex="0" aria-label="Download file" id="get">Download file</div>
      </main>`,
      'https://www.facebook.com/secure_storage/dyi',
    );
    let got = false;
    doc.getElementById('get')!.addEventListener('click', () => (got = true));
    expect(runSteps(doc, FETCH_PLANS.backup.then!)).toEqual(['done', 'done', 'done']);
    expect((doc.getElementById('all') as HTMLInputElement).checked).toBe(true);
    expect((doc.getElementById('media') as HTMLInputElement).checked).toBe(false);
    expect(got).toBe(true);
    expect(fetchPage('https://www.facebook.com/secure_storage/dyi')).toBe(true);
  });
});
