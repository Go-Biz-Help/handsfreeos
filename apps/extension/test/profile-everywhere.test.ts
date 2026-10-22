/**
 * Optimize your profile, on every network (docs/outreach.md, decision 80): LinkedIn's About put in beside its headline
 * (on the owner's own profile, test/fixtures/linkedin-own-profile-2026-10.html, its About pencil as he has it), and
 * Instagram's account read and its bio put in on its form (drawn from his own account's outline, 17 Oct 2026), as
 * asks on a network still looked at.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { KITS } from '../src/networks';
import {
  readOwnProfile as readOwnInstagram,
  writeBio,
} from '../src/networks/instagram/own-profile';
import { aboutMissing, tryAbout, writeAbout } from '../src/networks/linkedin/own-profile';
import { readProfile } from '../src/networks/linkedin/profile';
import { classifyUrl } from '../src/networks/linkedin/urls';
import { mainOf } from '../src/networks/linkedin/dom';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';
import { load } from './load';

// A person's pace between pages, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const LI = 'https://www.linkedin.com';
const OWN = `${LI}/in/chris-gee-12/?isSelfProfile=true`;
const ABOUT =
  'I help roofers with 2 to 3 crews get 10 to 20 booked inspections a month. Book a call below.';

/** His own profile, where the pencil by About opens its box, and Save puts what's in it under About. */
function linkedInProfile() {
  const doc = load('linkedin-own-profile-2026-10.html', OWN);
  const pencil = doc.querySelector<HTMLElement>('[aria-label="Edit about"]')!;
  pencil.addEventListener('click', (event) => {
    event.preventDefault();
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    box.innerHTML = `<h2>Edit about</h2>
      <label for="about-box">Description</label><textarea id="about-box"></textarea>
      <button type="button">Save</button><button type="button" aria-label="Dismiss"></button>`;
    const field = box.querySelector('textarea')!;
    field.value = aboutNow(doc) ?? '';
    const [save, dismiss] = [...box.querySelectorAll('button')];
    save!.addEventListener('click', () => {
      const shown = pencil.closest('section')!.querySelector('p')!;
      shown.textContent = field.value;
      box.remove();
    });
    dismiss!.addEventListener('click', () => box.remove());
    doc.body.append(box);
  });
  return doc;
}

const aboutNow = (doc: Document) =>
  readProfile(mainOf(doc), classifyUrl(OWN), OWN, doc.title).about;

describe('LinkedIn’s About, put in', () => {
  it('presses the pencil by About, writes the About in its field, presses Save and sees it on the profile', async () => {
    const doc = linkedInProfile();
    expect(aboutNow(doc)).toBeTruthy();
    const { result, steps } = await writeAbout(doc, OWN, ABOUT);
    expect(steps).toMatchObject({ pencil: true, box: true, aboutFields: 1, saves: 1, typed: true });
    expect(result).toBe('done');
    // His page lists his top skills after the About's words.
    expect(aboutNow(doc)?.startsWith(ABOUT)).toBe(true);
  }, 20_000);

  it('tries it for Check LinkedIn: writes, puts back what was there, and closes the box unsaved', async () => {
    const doc = linkedInProfile();
    const was = aboutNow(doc);
    const steps = await tryAbout(doc);
    expect(steps).toMatchObject({
      pencil: true,
      box: true,
      aboutFields: 1,
      typed: true,
      closed: true,
    });
    expect(aboutMissing(steps, true)).toEqual([]);
    expect(aboutNow(doc)).toBe(was);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
  }, 20_000);

  it('says which step it was when there’s no pencil by About', async () => {
    const doc = load('linkedin-own-profile-2026-10.html', OWN);
    doc.querySelector('[aria-label="Edit about"]')!.remove();
    const { result, steps } = await writeAbout(doc, OWN, ABOUT);
    expect(result).toBe('none');
    expect(aboutMissing(steps, false)).toEqual(['no pencil by About']);
  });
});

const IG = 'https://www.instagram.com';

const html = (body: string) =>
  `<!doctype html><html><head><title>Instagram</title></head><body>${body}</body></html>`;

const IG_MENU = `<div><a href="/" role="link"><span>Home</span></a>
  <a href="/casey.owner/" role="link"><img alt="casey.owner's profile picture" /><span>Profile</span></a></div>`;

/** His own account's page, drawn as its outline showed it, with a bio and a highlight added. */
const OWN_ACCOUNT = html(`${IG_MENU}<main role="main"><div><header>
  <div><section><div><div role="button"><div>Note…</div></div>
    <div><button title="Change profile photo"><img alt="Change profile photo" /></button></div></div></section>
  <section><div><div><a role="link" href="#"><h2 dir="auto"><span>casey.owner</span></h2></a>
    <div role="button" aria-expanded="false"><svg aria-label="Options"></svg></div></div>
    <div><span dir="auto"><span>0</span> posts</span>
      <a role="link" href="#"><span dir="auto"><span title="3,872">3,872</span> followers</span></a>
      <a role="link" href="#"><span dir="auto"><span>87</span> following</span></a></div></div></section></div>
  <section><div><div dir="auto">Casey</div>
    <span dir="auto">Roofs and coffee in Columbus</span>
    <div><div><svg aria-label="Link icon"></svg>
      <a href="https://l.instagram.com/?u=https%3A%2F%2Fcaseyroofs.com"><div dir="auto">caseyroofs.com</div></a></div>
      <a role="link" href="https://www.threads.com/@casey.owner"><svg aria-label="Threads"></svg><span dir="auto"><span>casey.owner</span></span></a></div></div></section>
  <section><div><a role="link" href="/accounts/edit/">Edit profile</a>
    <a role="link" href="/casey.owner/stories/">View archive</a></div></section>
  <section><div role="menu"><div role="presentation"><ul>
    <li><div role="button"><span dir="auto"><span>Reviews</span></span></div></li>
    <li><div role="button"><span dir="auto"><span>New</span></span></div></li></ul></div></div></section>
</header></div></main>`);

const FORM = html(`<main role="main"><form>
  <label for="pepBio">Bio</label><textarea id="pepBio">Roofs and coffee in Columbus</textarea>
  <div role="button" aria-disabled="true">Submit</div></form></main>`);

describe('Instagram’s own account, read and its bio put in', () => {
  it('reads the name, bio, link, highlights and posts off the account’s own page, never Instagram’s words', () => {
    const doc = new JSDOM(OWN_ACCOUNT, { url: `${IG}/casey.owner/` }).window.document;
    expect(readOwnInstagram(doc, `${IG}/casey.owner/`)).toMatchObject({
      platform: 'instagram',
      name: 'Casey',
      picture: 'A profile photo Instagram didn’t describe',
      bio: 'Roofs and coffee in Columbus',
      intro: ['Link: caseyroofs.com'],
      featured: ['Reviews'],
      posts: [],
    });
  });

  it('reads the bio as kept on its form', () => {
    const doc = new JSDOM(FORM, { url: `${IG}/accounts/edit/` }).window.document;
    expect(readOwnInstagram(doc, `${IG}/accounts/edit/`).bio).toBe('Roofs and coffee in Columbus');
  });

  it('writes the bio as typing does, presses Submit, and sees it kept', async () => {
    const doc = new JSDOM(FORM, { url: `${IG}/accounts/edit/` }).window.document;
    const box = doc.querySelector('textarea')!;
    const submit = doc.querySelector<HTMLElement>('[role="button"]')!;
    doc.execCommand = (command: string, _ui?: boolean, text?: string) => {
      if (command !== 'insertText') return false;
      box.value = text ?? '';
      submit.setAttribute('aria-disabled', 'false');
      return true;
    };
    let pressed = 0;
    submit.addEventListener('click', () => {
      pressed++;
      submit.setAttribute('aria-disabled', 'true');
      doc.body.insertAdjacentHTML('beforeend', '<div role="alert">Profile saved.</div>');
    });
    const bio = 'More booked inspections for Columbus roofers. Book a call below.';
    expect(await writeBio(doc, bio)).toBe('done');
    expect(box.value).toBe(bio);
    expect(pressed).toBe(1);
    // In already: nothing to press.
    expect(await writeBio(doc, bio)).toBe('done');
    expect(pressed).toBe(1);
  }, 15_000);
});

/** A tab on Instagram opening the pages above, reading and writing as its tab does. */
function instagramTab(pages: Record<string, string>) {
  const kit = KITS.instagram;
  let doc: Document | null = null;
  let at = '';
  const opened: string[] = [];
  const tab = {
    async open(url: string) {
      if (!pages[url]) throw new Error(`Not expected: ${url}`);
      opened.push(url);
      at = url;
      doc = new JSDOM(pages[url], { url }).window.document;
      // The form's Submit, as Instagram's: off again once it's kept what changed.
      doc
        .querySelector('form [role="button"]')
        ?.addEventListener('click', (event) =>
          (event.currentTarget as Element).setAttribute('aria-disabled', 'true'),
        );
      doc.execCommand = (command: string, _ui?: boolean, text?: string) => {
        const box = doc!.querySelector('textarea');
        if (command !== 'insertText' || !box) return false;
        box.value = text ?? '';
        return true;
      };
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      return work();
    },
    async ask(message: { readonly type: string }) {
      if (!doc) return { ok: false, error: 'closed' };
      if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc, at) };
      if (message.type === 'hfos-outline')
        return {
          ok: true,
          result: kit.readPage(doc, at),
          outline: kit.outline(doc, at),
          shown: true,
        };
      vi.stubGlobal('location', new URL(at));
      vi.stubGlobal('document', doc);
      try {
        return (await kit.work!(message)) ?? { ok: false, error: `Not expected: ${message.type}` };
      } finally {
        vi.unstubAllGlobals();
      }
    },
  } as unknown as JobTab;
  return { tab, opened };
}

function instagramJob(tab: JobTab) {
  const checked: unknown[] = [];
  const notes: ReportNote[] = [];
  const job: Job = {
    tab,
    hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
      if (ask.type === 'hfos-profile-check') checked.push(ask.input);
      return { ok: true, value: {} };
    }) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    report: async (note = {}) => void notes.push(note),
  };
  return { job, checked, notes };
}

describe('Read my profile and Put this one in, on Instagram', () => {
  const pages = {
    [`${IG}/`]: html(`${IG_MENU}<main role="main"></main>`),
    [`${IG}/casey.owner/`]: OWN_ACCOUNT,
    [`${IG}/accounts/edit/`]: FORM.replace('aria-disabled="true"', ''),
  };

  it('reads the account and its form, and sends them for the AI’s check, the form’s bio as kept', async () => {
    const { tab, opened } = instagramTab(pages);
    const { job, checked } = instagramJob(tab);
    const end = await runAsk({ kind: 'profile_read' }, job, 'instagram');
    expect(opened).toEqual([`${IG}/`, `${IG}/casey.owner/`, `${IG}/accounts/edit/`]);
    expect(checked).toEqual([
      expect.objectContaining({
        platform: 'instagram',
        name: 'Casey',
        bio: 'Roofs and coffee in Columbus',
      }),
    ]);
    expect(end).toEqual({ line: 'Read your profile. The AI’s checked it.', warned: false });
  });

  it('puts the bio in on its form, then reads the account again for a new check', async () => {
    const { tab, opened } = instagramTab(pages);
    const { job, checked } = instagramJob(tab);
    const end = await runAsk(
      {
        kind: 'profile_edit',
        bio: 'Booked inspections for Columbus roofers',
        about: null,
        name: null,
        username: null,
        links: [],
      },
      job,
      'instagram',
    );
    expect(opened[0]).toBe(`${IG}/accounts/edit/`);
    expect(checked).toHaveLength(1);
    expect(end).toEqual({
      line: 'Your bio now says “Booked inspections for Columbus roofers”.',
      warned: false,
    });
  }, 20_000);
});
