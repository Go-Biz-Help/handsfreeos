/**
 * Every part of the person's own profile, put in by Put these in (docs/outreach.md, decision 99, from 0.98.0), on
 * made-up pages whose buttons behave as a person would expect: Facebook's work, pinned post and a link taken off;
 * LinkedIn's address, Add position and its own page; Alignable's Elevator Pitch and a service on a page of its own. Then
 * the job's side: each part on its page, asked again on a page of its own or past a code, and handed over with its words
 * when it can't; the order of each network's parts; what doesn't show after; and the read on its own on the 1st.
 */
import type { AskTask } from '@hfos/core/addons/outreach/asks';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ALIGNABLE_DAILY } from '../src/auto/alignable';
import { INSTAGRAM_DAILY } from '../src/auto/instagram';
import { LINKEDIN_DAILY } from '../src/auto/linkedin';
import { DAILY_JOBS } from '../src/auto/plan';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import {
  partSteps,
  putParts,
  shownParts,
  unseenParts,
  unseenPartsWords,
  type PartStep,
} from '../src/jobs/own-parts';
import { readProfileOnItsOwn } from '../src/jobs/own-read';
import type { ReportNote } from '../src/jobs/report';
import { writeAlignablePart } from '../src/networks/alignable/parts';
import { writeFacebookPart } from '../src/networks/facebook/parts';
import { sinceParts, type PartWrote } from '../src/networks/fill';
import { writeLinkedInPart } from '../src/networks/linkedin/parts';

// What a press opens, without the waits.
vi.mock('../src/networks/looking/looks', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
  waitFor: async <T>(find: () => T | null | undefined) => find() ?? null,
}));
vi.mock('../src/networks/facebook/editors', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

type EditTask = Extract<AskTask, { kind: 'profile_edit' }>;

const NOTHING: EditTask = {
  kind: 'profile_edit',
  bio: null,
  about: null,
  name: null,
  username: null,
  links: [],
  work: null,
  featured: null,
  ideal: null,
  services: [],
  linkChanges: [],
};

const WORK = {
  title: 'Owner',
  company: 'Gee Roofing',
  words: 'Roofs for Columbus homes.',
  since: '2021-03',
};
const POST =
  'Spring storm season is here. Three things to check on your roof before the next big one rolls in.';
const CAL = 'https://cal.example.com/gee-roofing';

/** A made-up page at an address, and what was pressed on it, by its words. */
function pageAt(href: string, body: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: href });
  const doc = dom.window.document;
  const presses: string[] = [];
  const on = (selector: string, then: (el: HTMLElement) => void) =>
    doc.querySelectorAll<HTMLElement>(selector).forEach((el) =>
      el.addEventListener('click', () => {
        presses.push(el.getAttribute('aria-label') || el.textContent?.trim() || selector);
        then(el);
      }),
    );
  const add = (html: string, where: Element = doc.body) => {
    const box = doc.createElement('div');
    box.innerHTML = html;
    const made = box.firstElementChild as HTMLElement;
    where.append(made);
    return made;
  };
  return { doc, presses, on, add };
}

describe('Facebook’s parts', () => {
  const FB = 'https://www.facebook.com/casey.roofs/about_work_and_education';

  function workPage(fields: 'all' | 'no position' = 'all') {
    const p = pageAt(
      FB,
      `<div role="main"><h2>Work</h2><div role="button">Add a workplace</div></div>`,
    );
    p.on('[role="button"]', () => {
      const dialog = p.add(
        `<div role="dialog"><form>
          <label>Company<input id="company"></label>
          ${fields === 'all' ? '<label>Position<input id="position"></label>' : ''}
          <label>City/Town<input id="city"></label>
          <label>Description<textarea id="words"></textarea></label>
          <label><input type="checkbox" id="now">I currently work here</label>
        </form><div role="button" id="save">Save</div><div role="button" id="cancel">Cancel</div></div>`,
      );
      dialog.querySelector('#save')!.addEventListener('click', () => {
        p.presses.push('Save');
        const value = (id: string) => (dialog.querySelector(`#${id}`) as HTMLInputElement).value;
        p.add(
          `<span>${value('position')} at ${value('company')}</span>`,
          p.doc.querySelector('[role="main"]')!,
        );
        dialog.remove();
      });
    });
    return p;
  }

  it('adds their work by Add a workplace: company, position, words, I currently work here, Save', async () => {
    const p = workPage();
    const wrote = await writeFacebookPart(p.doc, { kind: 'work', ...WORK });
    expect(wrote.result).toBe('done');
    expect(p.presses).toEqual(['Add a workplace', 'Save']);
    expect(p.doc.querySelector('[role="main"]')!.textContent).toContain('Owner at Gee Roofing');
  });

  it('writes nothing when the form has no field for a part it needs, and says which', async () => {
    const p = workPage('no position');
    const wrote = await writeFacebookPart(p.doc, { kind: 'work', ...WORK });
    expect(wrote.result).toBe('none');
    expect(wrote.steps).toMatchObject({
      opener: true,
      form: true,
      missing: ['Position'],
      typed: false,
    });
    expect((p.doc.querySelector('#company') as HTMLInputElement).value).toBe('');
    expect(p.presses).toEqual(['Add a workplace']);
  });

  it('says their work is in already when the page shows it, pressing nothing', async () => {
    const p = pageAt(
      FB,
      `<div role="main"><span>Owner at Gee Roofing</span><div role="button">Add a workplace</div></div>`,
    );
    expect((await writeFacebookPart(p.doc, { kind: 'work', ...WORK })).result).toBe('already');
    expect(p.presses).toEqual([]);
  });

  function postPage(menu: string[]) {
    const p = pageAt(
      'https://www.facebook.com/casey.roofs',
      `<div role="main"><div role="article"><span>${POST}</span><div role="button" aria-label="Actions for this post"></div></div></div>`,
    );
    p.on('[aria-label="Actions for this post"]', () => {
      const list = p.add(
        `<div role="menu">${menu.map((m) => `<div role="menuitem">${m}</div>`).join('')}</div>`,
      );
      list.querySelectorAll('[role="menuitem"]').forEach((item) =>
        item.addEventListener('click', () => {
          p.presses.push(item.textContent!);
          list.remove();
        }),
      );
    });
    return p;
  }

  it('pins their best post by its menu’s Pin post, found by its first words', async () => {
    const p = postPage(['Edit post', 'Pin post', 'Delete post']);
    expect((await writeFacebookPart(p.doc, { kind: 'feature_post', post: POST })).result).toBe(
      'done',
    );
    expect(p.presses).toEqual(['Actions for this post', 'Pin post']);
  });

  it('leaves a post pinned already as it is: its Unpin is never pressed', async () => {
    const p = postPage(['Unpin post', 'Edit post']);
    expect((await writeFacebookPart(p.doc, { kind: 'feature_post', post: POST })).result).toBe(
      'already',
    );
    expect(p.presses).toEqual(['Actions for this post']);
  });

  it('takes a link off by its own row’s menu, Delete and the confirm, and checks it’s gone', async () => {
    const p = pageAt(
      'https://www.facebook.com/casey.roofs/about_contact',
      `<div role="main">
        <div id="old"><a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fold-site.example%2F">old-site.example</a><div role="button" aria-label="Options for website"></div></div>
        <div id="keep"><a href="${CAL}">cal.example.com/gee-roofing</a><div role="button" aria-label="Options for website"></div></div>
      </div>`,
    );
    p.on('#old [role="button"]', () => {
      const menu = p.add(
        `<div role="menu"><div role="menuitem">Edit website</div><div role="menuitem">Delete website</div></div>`,
      );
      menu.querySelectorAll('[role="menuitem"]')[1]!.addEventListener('click', () => {
        p.presses.push('Delete website');
        menu.remove();
        const sure = p.add(
          `<div role="dialog"><div role="button">Cancel</div><div role="button">Delete</div></div>`,
        );
        sure.querySelectorAll('[role="button"]')[1]!.addEventListener('click', () => {
          p.presses.push('Delete');
          sure.remove();
          p.doc.querySelector('#old')!.remove();
        });
      });
    });
    p.on('#keep [role="button"]', () => undefined);
    const wrote = await writeFacebookPart(p.doc, {
      kind: 'link_off',
      link: 'https://old-site.example',
    });
    expect(wrote.result).toBe('done');
    expect(p.presses).toEqual(['Options for website', 'Delete website', 'Delete']);
    expect(p.doc.querySelector('#keep')).not.toBeNull();
  });
});

describe('LinkedIn’s parts', () => {
  it('puts their address in on Public profile & URL, and checks the page says it', async () => {
    const p = pageAt(
      'https://www.linkedin.com/public-profile/settings',
      `<main><section><h2>Edit your custom URL</h2><p id="at">www.linkedin.com/in/casey-lee-1a2b3c</p><button aria-label="Edit your custom URL"></button></section></main>`,
    );
    p.on('button', (el) => {
      const form = p.add(
        `<form><label for="u">linkedin.com/in/</label><input id="u" value="casey-lee-1a2b3c"><button type="button">Save</button><button type="button">Cancel</button></form>`,
        el.parentElement!,
      );
      form.querySelector('button')!.addEventListener('click', () => {
        p.presses.push('Save');
        p.doc.querySelector('#at')!.textContent =
          `www.linkedin.com/in/${(form.querySelector('#u') as HTMLInputElement).value}`;
        form.remove();
      });
    });
    const wrote = await writeLinkedInPart(p.doc, p.doc.location.href, {
      kind: 'username',
      username: 'casey-roofs',
    });
    expect(wrote.result).toBe('done');
    expect(p.presses).toEqual(['Edit your custom URL', 'Save']);
  });

  const FORM = 'https://www.linkedin.com/in/casey-roofs/edit/forms/position/new/';
  const positionForm = `<main><form>
    <label for="t">Title*</label><input id="t">
    <label for="c">Company or organization*</label><input id="c" role="combobox" aria-autocomplete="list">
    <label><input type="checkbox" id="now" checked>I am currently working in this role</label>
    <fieldset><legend>Start date</legend>
      <select aria-label="Month" id="sm"><option value="">Month</option><option value="1">January</option><option value="3">March</option></select>
      <select aria-label="Year" id="sy"><option value="">Year</option><option>2020</option><option>2021</option></select>
    </fieldset>
    <fieldset><legend>End date</legend>
      <select aria-label="Month" id="em"><option value="">Month</option><option value="3">March</option></select>
      <select aria-label="Year" id="ey"><option value="">Year</option><option>2021</option></select>
    </fieldset>
    <label for="d">Description</label><textarea id="d"></textarea>
    <label><input type="checkbox" id="notify" checked>Notify network</label>
    <button type="button" id="save">Save</button>
  </form></main>`;

  it('fills in Add position on its own page: title, company, start month and year, words, and Notify network off', async () => {
    const p = pageAt(FORM, positionForm);
    p.on('#save', () => undefined);
    const wrote = await writeLinkedInPart(p.doc, FORM, { kind: 'work', ...WORK });
    expect(wrote.result).toBe('done');
    const v = (id: string) => (p.doc.querySelector(`#${id}`) as HTMLInputElement).value;
    expect([v('t'), v('c'), v('sm'), v('sy'), v('em'), v('ey'), v('d')]).toEqual([
      'Owner',
      'Gee Roofing',
      '3',
      '2021',
      '',
      '',
      'Roofs for Columbus homes.',
    ]);
    expect((p.doc.querySelector('#now') as HTMLInputElement).checked).toBe(true);
    expect((p.doc.querySelector('#notify') as HTMLInputElement).checked).toBe(false);
    expect(p.presses).toEqual(['Save']);
  });

  it('says Add position’s own page where the profile has no + to press', async () => {
    const at = 'https://www.linkedin.com/in/casey-roofs/';
    const p = pageAt(at, `<main><section><h2>Experience</h2></section></main>`);
    const wrote = await writeLinkedInPart(p.doc, at, { kind: 'work', ...WORK });
    expect(wrote).toMatchObject({ result: 'elsewhere', next: FORM });
  });

  it('features their best post by its menu’s Feature on top of profile', async () => {
    const p = pageAt(
      'https://www.linkedin.com/in/casey-roofs/recent-activity/all/',
      `<main><div data-urn="urn:li:activity:1"><span>${POST}</span><button aria-label="Open control menu for post by Casey"></button></div></main>`,
    );
    p.on('button', () => {
      const menu = p.add(
        `<div role="menu"><div role="menuitem">Feature on top of profile</div><div role="menuitem">Delete post</div></div>`,
      );
      menu
        .querySelector('[role="menuitem"]')!
        .addEventListener('click', () => p.presses.push('Feature on top of profile'));
    });
    const wrote = await writeLinkedInPart(p.doc, p.doc.location.href, {
      kind: 'feature_post',
      post: POST,
    });
    expect(wrote.result).toBe('done');
    expect(p.presses).toEqual(['Open control menu for post by Casey', 'Feature on top of profile']);
  });
});

describe('Alignable’s parts', () => {
  const MINE = 'https://www.alignable.com/biz/businesses/my_profile';
  const mask = (t: string) => t;

  it('puts the Elevator Pitch in its box, unnamed, and checks the profile says it', async () => {
    const pitch = 'We keep Columbus roofs dry, with free storm checks.';
    const p = pageAt(
      MINE,
      `<main><button data-testid="elevator-pitch-cta-button">Elevator Pitch</button></main>`,
    );
    p.on('[data-testid="elevator-pitch-cta-button"]', () => {
      const box = p.add(
        `<div role="dialog"><textarea></textarea><button id="save">Save</button><button>Cancel</button></div>`,
      );
      box.querySelector('#save')!.addEventListener('click', () => {
        p.presses.push('Save');
        p.add(`<p>${box.querySelector('textarea')!.value}</p>`, p.doc.querySelector('main')!);
        box.remove();
      });
    });
    const wrote = await writeAlignablePart(p.doc, MINE, { kind: 'pitch', words: pitch }, mask);
    expect(wrote.result).toBe('done');
    expect(p.presses).toEqual(['Elevator Pitch', 'Save']);
  });

  it('says where a new service’s own page is, pressing nothing', async () => {
    const p = pageAt(
      MINE,
      `<main><a href="/biz/services/new"><span>Add a service</span></a></main>`,
    );
    const wrote = await writeAlignablePart(
      p.doc,
      MINE,
      { kind: 'service', name: 'Roof inspections', words: null },
      mask,
    );
    expect(wrote).toMatchObject({
      result: 'elsewhere',
      next: 'https://www.alignable.com/biz/services/new',
    });
    expect(p.presses).toEqual([]);
  });

  it('says Alignable asks for its code first', async () => {
    const p = pageAt(
      MINE,
      `<main><button data-testid="elevator-pitch-cta-button">Elevator Pitch</button></main><div role="dialog"><p>Enter the verification code we emailed you</p><input type="text"><button>Continue</button></div>`,
    );
    expect(
      (await writeAlignablePart(p.doc, MINE, { kind: 'pitch', words: 'Dry roofs.' }, mask)).result,
    ).toBe('code');
  });
});

describe('a start date as the forms ask for it', () => {
  it('is a month’s name and a year', () => {
    expect(sinceParts('2021-03')).toEqual({ month: 'March', year: '2021' });
    expect(sinceParts(null)).toBeNull();
  });
});

/** A tab whose write-part answers come in turn, and the pages it opened. */
function partsTab(answers: PartWrote[]) {
  const opened: string[] = [];
  const asked: unknown[] = [];
  const tab = {
    tabId: 1,
    async open(url: string) {
      opened.push(url);
      return 1;
    },
    async ask(message: { type: string; part?: unknown }) {
      asked.push(message.part);
      return { ok: true, ...answers.shift()! };
    },
  } as unknown as JobTab;
  return { tab, opened, asked };
}

function partsJob(tab: JobTab, reply: 'carry_on' | 'stop' = 'carry_on') {
  const handed: { says: string; note?: ReportNote }[] = [];
  const job: Job = {
    tab,
    hfos: (async () => ({ ok: true, value: {} })) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    handOver: async (says, note) => {
      handed.push({ says, ...(note ? { note } : {}) });
      return reply;
    },
  };
  return { job, handed };
}

const done: PartWrote = {
  result: 'done',
  steps: {
    opener: true,
    form: true,
    fields: 2,
    missing: [],
    typed: true,
    saves: 1,
    saved: true,
    names: [],
  },
};
const none: PartWrote = {
  result: 'none',
  steps: { ...done.steps, missing: ['Position'], typed: false, saved: false },
};

describe('putting each part in, on its page', () => {
  const step = (over: Partial<PartStep> = {}): PartStep => ({
    write: { kind: 'work', ...WORK },
    page: 'https://www.linkedin.com/in/me/',
    byHand: 'Put your work in: press Add position.',
    doing: 'Putting your work in…',
    ...over,
  });

  it('opens a form’s own page when the tab says so, and asks again there', async () => {
    const { tab, opened } = partsTab([
      { ...none, result: 'elsewhere', next: 'https://x.example/new' },
      done,
    ]);
    const { job, handed } = partsJob(tab);
    const open = vi.fn(async (url: string) => {
      await tab.open(url);
      return null;
    });
    expect(await putParts(job, [step()], { open })).toEqual(['in']);
    expect(opened).toEqual(['https://www.linkedin.com/in/me/', 'https://x.example/new']);
    expect(handed).toEqual([]);
  });

  it('gets the code Alignable emailed and asks the part again', async () => {
    const { tab } = partsTab([{ ...none, result: 'code' }, done]);
    const { job } = partsJob(tab);
    const code = vi.fn(async () => 'again' as const);
    expect(await putParts(job, [step()], { open: async () => null, code })).toEqual(['in']);
    expect(code).toHaveBeenCalledTimes(1);
  });

  it('hands a part it can’t put in to the person with its words, and notes what was missing', async () => {
    const { tab } = partsTab([none, done]);
    const { job, handed } = partsJob(tab);
    const second = step({
      write: { kind: 'feature_link', link: CAL },
      doing: 'Featuring your booking link…',
    });
    expect(await putParts(job, [step(), second], { open: async () => null })).toEqual([
      'handed',
      'in',
    ]);
    expect(handed).toHaveLength(1);
    expect(handed[0]!.says).toBe('Put your work in: press Add position. Then press Carry on.');
    expect(handed[0]!.note).toMatchObject({
      job: 'profile_edit.work',
      found: { missing: ['Position'] },
      note: 'Not done: no field, or more than one, for Position.',
      outline: true,
    });
  });

  it('stops when the person stops', async () => {
    const { tab } = partsTab([none]);
    const { job } = partsJob(tab, 'stop');
    expect(await putParts(job, [step()], { open: async () => null })).toMatchObject({
      line: 'Stopped.',
    });
  });
});

describe('each network’s parts, in order', () => {
  const task: EditTask = {
    ...NOTHING,
    bio: 'Dry roofs, fast.',
    username: 'casey-roofs',
    links: [CAL],
    work: WORK,
    featured: { post: POST, link: CAL },
    ideal: { customer: 'Homeowners in Columbus', partner: 'Gutter cleaners' },
    services: [{ name: 'Roof inspections', words: null }],
    linkChanges: [{ from: 'https://old-site.example', to: null }],
  };
  const kinds = (platform: 'facebook' | 'linkedin' | 'alignable') =>
    partSteps(platform, task, { profile: 'https://p.example/' }).map((s) => s.write.kind);

  it('takes Facebook’s links off first, then its work and the post', () => {
    expect(kinds('facebook')).toEqual(['link_off', 'work', 'feature_post']);
  });

  it('puts LinkedIn’s address and website in, then its work and what’s featured', () => {
    expect(kinds('linkedin')).toEqual([
      'username',
      'link_add',
      'work',
      'feature_link',
      'feature_post',
    ]);
  });

  it('puts Alignable’s pitch, ideal customer and partner, and services in', () => {
    expect(kinds('alignable')).toEqual(['pitch', 'ideal', 'ideal', 'service']);
  });

  it('says a part that went in but doesn’t show after, and leaves it out of what’s in', () => {
    const read = {
      platform: 'alignable' as const,
      url: 'https://x',
      intro: ['Ideal customer, in their words: Homeowners in Columbus'],
      featured: [],
    };
    const unseen = unseenParts('alignable', task, read);
    expect([...unseen]).toEqual(['services', 'ideal']);
    expect(unseenPartsWords('alignable', unseen)).toBe(
      'Alignable hasn’t shown your new services and your ideal customer and partner on your profile yet. Check it there in a minute.',
    );
    expect(shownParts(task, unseen)).toMatchObject({ services: [], ideal: null });
  });
});

describe('the read on its own, on the 1st of each month', () => {
  function readJob(at: string | null) {
    const checked: unknown[] = [];
    const hfos = (async (ask: { type: string; input?: unknown }) => {
      if (ask.type === 'hfos-profiles')
        return {
          ok: true,
          value: { checks: { facebook: at ? { at } : null }, booking: {}, website: null },
        };
      checked.push(ask.input);
      return { ok: true, value: {} };
    }) as unknown as Hfos;
    const { job } = partsJob(partsTab([]).tab);
    return { job: { ...job, hfos }, checked };
  }
  const read = vi.fn(async (job: Job) => {
    expect(job.handOver).toBeUndefined();
    await job.hfos({
      type: 'hfos-profile-check',
      workspaceId: 'b',
      input: { platform: 'facebook', url: 'https://x' },
    });
    return { line: 'Read.', warned: false };
  });

  it('reads nothing while this month’s read is done', async () => {
    const { job, checked } = readJob('2026-10-02T15:00:00.000Z');
    const end = await readProfileOnItsOwn(job, 'facebook', read, new Date(2026, 9, 20));
    expect(end.line).toBe('Your Facebook profile was read this month.');
    expect(checked).toEqual([]);
  });

  it('reads it once the month has turned, marked as read on its own', async () => {
    const { job, checked } = readJob('2026-10-02T15:00:00.000Z');
    const end = await readProfileOnItsOwn(job, 'facebook', read, new Date(2026, 10, 1, 9));
    expect(end.line).toMatch(/^Read your Facebook profile, as it does on the 1st\./);
    expect(checked).toEqual([{ platform: 'facebook', url: 'https://x', own: true }]);
  });

  it('is the last of each network’s once-a-day jobs', () => {
    for (const list of [DAILY_JOBS, LINKEDIN_DAILY, INSTAGRAM_DAILY, ALIGNABLE_DAILY])
      expect(list[list.length - 1]).toBe('profile');
  });
});
