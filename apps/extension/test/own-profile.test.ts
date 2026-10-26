/**
 * The person's own profile (decision 64), on a hand-written page: what a stranger sees first, read for the AI's
 * check, and the bio put in with Edit bio and Save. The page is our best guess at Facebook's, not a saved one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bioControl,
  bioOf,
  ownEditorsOf,
  readOwnProfile,
  writeBio,
  writeBioSteps,
} from '../src/networks/facebook/own-profile';
import { readPage } from '../src/networks/facebook/page';
import { classifyUrl } from '../src/networks/facebook/urls';
import { boxEverything, load } from './load';

const URL = 'https://www.facebook.com/casey.owner.7';

describe('reading your own profile', () => {
  it('reads the picture’s and the cover’s descriptions, the bio, the intro, what’s featured and your posts', () => {
    for (const doc of [
      load('own-profile.html', URL),
      boxEverything(load('own-profile.html', URL)),
    ]) {
      expect(readOwnProfile(doc, URL, classifyUrl(URL))).toEqual({
        url: 'https://www.facebook.com/casey.owner.7',
        name: 'Casey Owner',
        picture: 'May be an image of 1 person, smiling',
        cover: "May be an image of text that says 'Roofs done right'",
        bio: 'Dad, golfer, coffee',
        links: [],
        intro: ['Owner at Summit Roof Leads', 'Lives in Columbus, Ohio'],
        featured: [
          'Booked 14 inspections in 30 days',
          'May be an image of a house with a new roof',
        ],
        posts: ['Another roof done before the storm. Proud of the crew.'],
      });
    }
  });

  it('knows it’s your own: Edit profile, not Add friend', () => {
    expect(readPage(load('own-profile.html', URL), URL).profile?.friendship).toBe('self');
  });
});

describe('reading your own profile in October 2026’s layout', () => {
  // Rebuilt from an owner's page outline of 23 Oct 2026, which 0.87.0 took for someone else's profile.
  const PAGE = 'own-profile-2026-10.html';

  it('knows it’s your own by Edit profile, now a link that says “Edit”', () => {
    for (const doc of [load(PAGE, URL), boxEverything(load(PAGE, URL))])
      expect(readPage(doc, URL).profile?.friendship).toBe('self');
  });

  it('reads the bio above the details, the cards for its intro, and the Links card', () => {
    for (const doc of [load(PAGE, URL), boxEverything(load(PAGE, URL))]) {
      expect(readOwnProfile(doc, URL, classifyUrl(URL))).toEqual({
        url: 'https://www.facebook.com/casey.owner.7',
        name: 'Casey Owner',
        // Neither has a description on this page.
        picture: 'A picture Facebook didn’t describe',
        cover: null,
        bio: 'Dad, golfer, coffee. I help Columbus roofers book more inspections.',
        // Facebook's l.php wrapper taken off.
        links: ['https://summitroofleads.com/'],
        intro: [
          'Lives in Columbus, Ohio',
          'Summit Roof Leads',
          'From Dayton, Ohio',
          'Joined March 2011',
          'Owner at Summit Roof Leads March 2019 to present',
          'Studied business at Ohio State University',
        ],
        featured: [],
        posts: ['Another roof done before the storm. Proud of the crew.'],
      });
    }
  });

  it('has no Edit bio, so a new bio is handed to the person', async () => {
    const doc = load(PAGE, URL);
    expect(await writeBio(doc, 'I help roofers fill their calendars.')).toBe('none');
  });
});

describe('putting your bio in', () => {
  /** The page as Facebook behaves: Edit bio opens a box with Save, and Save shows the new bio. */
  function editable() {
    const doc = load('own-profile.html', URL);
    const bio = doc.getElementById('bio')!;
    const edit = bio.querySelector('[role="button"]')!;
    edit.addEventListener('click', () => {
      const box = doc.createElement('textarea');
      box.value = 'Dad, golfer, coffee';
      const save = doc.createElement('div');
      save.setAttribute('role', 'button');
      save.textContent = 'Save';
      save.addEventListener('click', () => {
        bio.querySelector('span[dir="auto"]')!.textContent = box.value;
        box.remove();
        save.remove();
      });
      bio.append(box, save);
    });
    return doc;
  }

  it('presses Edit bio, writes it in place of the old one, saves, and sees it', async () => {
    const doc = editable();
    expect(await writeBio(doc, 'I help roofers fill their calendars.')).toBe('done');
    expect(bioOf(doc)).toBe('I help roofers fill their calendars.');
  });

  it('says so when there’s no Edit bio to press', async () => {
    const doc = load('own-profile.html', URL);
    doc.getElementById('bio')!.querySelector('[role="button"]')!.remove();
    expect(await writeBio(doc, 'I help roofers.')).toBe('none');
  });
});

describe('where your own profile is changed', () => {
  it('finds Edit profile’s and Edit links’s addresses, and the profile’s number, on October 2026’s layout', () => {
    for (const doc of [
      load('own-profile-2026-10.html', URL),
      boxEverything(load('own-profile-2026-10.html', URL)),
    ])
      expect(ownEditorsOf(doc, URL)).toEqual({
        about:
          'https://www.facebook.com/profile.php?fb_profile_edit_entry_point=7&id=100001234&sk=about',
        links: 'https://www.facebook.com/casey.owner.7/about_contact?fb_profile_edit_entry_point=9',
        id: '100001234',
        username: 'casey.owner.7',
      });
  });

  it('without their labels, goes only by links to this same profile, never someone else’s', () => {
    const doc = load('own-profile-2026-10.html', URL);
    const editLinks = doc.querySelector('[aria-label="Edit links"]')!;
    editLinks.removeAttribute('aria-label');
    editLinks.setAttribute('href', '/jane.doe.5/about_contact');
    doc.querySelector('[aria-label="Edit profile"]')!.removeAttribute('aria-label');
    expect(ownEditorsOf(doc, URL)).toMatchObject({
      // Edit profile's link still carries Facebook's mark for editing your own profile.
      about:
        'https://www.facebook.com/profile.php?fb_profile_edit_entry_point=7&id=100001234&sk=about',
      links: 'https://www.facebook.com/casey.owner.7/about_contact',
    });
  });

  it('goes by the address on the older layout, which has neither link', () => {
    expect(ownEditorsOf(load('own-profile.html', URL), URL)).toEqual({
      about: null,
      links: 'https://www.facebook.com/casey.owner.7/about_contact',
      id: null,
      username: 'casey.owner.7',
    });
  });
});

describe('putting your bio in on the About tab’s editor (October 2026)', () => {
  const EDITOR =
    'https://www.facebook.com/profile.php?fb_profile_edit_entry_point=7&id=100001234&sk=about';
  const NEW_BIO = 'I help roofers fill their calendars.';

  afterEach(() => vi.useRealTimers());

  /** Runs a step with Facebook's waits skipped. */
  async function quickly<T>(going: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(30_000);
    return going;
  }

  /**
   * The editor as Facebook behaves: the Edit after Bio opens a box (in the row, or in a box over the page) with Save
   * and Cancel; Save shows the new bio and closes the box, unless `saves` is off.
   */
  function editor(
    more: {
      boxed?: boolean;
      dialog?: boolean;
      boxes?: number;
      save?: boolean;
      saves?: boolean;
    } = {},
  ) {
    const doc = load('own-profile-about-editor-2026-10.html', EDITOR);
    if (more.boxed) boxEverything(doc);
    const shownBio = doc.getElementById('bio-shown')!;
    doc.getElementById('bio-edit')!.addEventListener('click', () => {
      const holder = more.dialog ? doc.createElement('div') : doc.getElementById('bio-row')!;
      if (more.dialog) {
        holder.setAttribute('role', 'dialog');
        doc.body.append(holder);
      }
      const boxes = Array.from({ length: more.boxes ?? 1 }, () => {
        const box = doc.createElement('textarea');
        box.value = clean(shownBio.textContent);
        return box;
      });
      const save = doc.createElement('div');
      save.setAttribute('role', 'button');
      save.textContent = 'Save';
      save.addEventListener('click', () => {
        if (more.saves === false) return;
        shownBio.textContent = boxes[0]!.value;
        for (const part of [...boxes, save]) part.remove();
        if (more.dialog) holder.remove();
      });
      holder.append(...boxes, ...(more.save === false ? [] : [save]));
    });
    return doc;
  }
  const clean = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();

  it('finds the bio’s own Edit after its title, never another row’s', () => {
    const doc = load('own-profile-about-editor-2026-10.html', EDITOR);
    expect(bioControl(doc)?.id).toBe('bio-edit');
    expect(
      bioControl(boxEverything(load('own-profile-about-editor-2026-10.html', EDITOR)))?.id,
    ).toBe('bio-edit');
  });

  it('presses the Edit by Bio, writes the bio in the box it opens, saves, and sees it', async () => {
    vi.useFakeTimers();
    for (const boxed of [false, true]) {
      const doc = editor({ boxed });
      const { result, steps } = await quickly(writeBioSteps(doc, NEW_BIO));
      expect(result).toBe('done');
      expect(steps).toMatchObject({
        control: true,
        boxes: 1,
        typed: true,
        saves: 1,
        saveOn: true,
        saved: true,
      });
      expect(clean(doc.getElementById('bio-shown')!.textContent)).toBe(NEW_BIO);
    }
  });

  it('goes by Edit bio’s label too, with its box over the page', async () => {
    vi.useFakeTimers();
    const doc = editor({ dialog: true });
    doc.getElementById('bio-edit')!.setAttribute('aria-label', 'Edit bio');
    expect(await quickly(writeBio(doc, NEW_BIO))).toBe('done');
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
  });

  it('presses nothing with no Edit by Bio, and names what was there', async () => {
    const doc = editor();
    doc.getElementById('bio-edit')!.remove();
    const { result, steps } = await writeBioSteps(doc, NEW_BIO);
    expect(result).toBe('none');
    expect(steps.control).toBe(false);
    expect(steps.names).toContain('Edit');
  });

  it('writes in no box when two open, as it can’t tell which', async () => {
    vi.useFakeTimers();
    const doc = editor({ boxes: 2 });
    const { result, steps } = await quickly(writeBioSteps(doc, NEW_BIO));
    expect(result).toBe('none');
    expect(steps).toMatchObject({ control: true, boxes: 2, typed: false });
    expect([...doc.querySelectorAll('textarea')].map((b) => b.value)).not.toContain(NEW_BIO);
  });

  it('leaves the bio in its box when there’s no Save by it, for the person to press', async () => {
    vi.useFakeTimers();
    const doc = editor({ save: false });
    const { result, steps } = await quickly(writeBioSteps(doc, NEW_BIO));
    expect(result).toBe('none');
    expect(steps).toMatchObject({ boxes: 1, typed: true, saves: 0 });
    expect(doc.querySelector('textarea')!.value).toBe(NEW_BIO);
  });

  it('says so when Save didn’t put it on the page', async () => {
    vi.useFakeTimers();
    const doc = editor({ saves: false });
    const { result, steps } = await quickly(writeBioSteps(doc, NEW_BIO));
    expect(result).toBe('not_saved');
    expect(steps).toMatchObject({ typed: true, saves: 1, saved: false });
  });

  it('presses nothing while Facebook shows a warning', async () => {
    const doc = editor();
    const warning = doc.createElement('div');
    warning.setAttribute('role', 'alert');
    warning.textContent = 'You’re temporarily blocked from editing your profile.';
    doc.querySelector('[role="main"]')!.prepend(warning);
    let pressed = 0;
    doc.getElementById('bio-edit')!.addEventListener('click', () => pressed++);
    const { result, steps } = await writeBioSteps(doc, NEW_BIO);
    expect(result).toBe('none');
    expect(steps.control).toBe(true);
    expect(pressed).toBe(0);
  });

  /**
   * The editor with its rows titled by plain words rather than headings, as Facebook may draw them: Work's Edit opens
   * a Company box with Save and Cancel, and Save puts what's in it under Work.
   */
  function plainTitles(doc: Document) {
    for (const heading of [...doc.querySelectorAll('h3')]) {
      const words = doc.createElement('span');
      words.setAttribute('dir', 'auto');
      words.innerHTML = heading.innerHTML;
      heading.replaceWith(words);
    }
    const row = doc.getElementById('work-row')!;
    const work = row.querySelector<HTMLElement>('[role="button"]')!;
    const shownWork = row.querySelector('span[dir="auto"]:not(:has(span))') ?? row.children[1]!;
    let opened = 0;
    let saves = 0;
    work.addEventListener('click', () => {
      opened++;
      const box = doc.createElement('input');
      box.setAttribute('aria-label', 'Company');
      box.value = 'Summit Roof Leads';
      const [save, cancel] = ['Save', 'Cancel'].map((label) => {
        const button = doc.createElement('div');
        button.setAttribute('role', 'button');
        button.textContent = label;
        return button;
      });
      save!.addEventListener('click', () => {
        saves++;
        shownWork.textContent = box.value;
        for (const part of [box, save!, cancel!]) part.remove();
      });
      cancel!.addEventListener('click', () => {
        for (const part of [box, save!, cancel!]) part.remove();
      });
      row.append(box, save!, cancel!);
    });
    return { opened: () => opened, saves: () => saves, work: () => clean(row.textContent) };
  }

  it('never presses another row’s Edit when the Bio row has none and the titles are plain words', async () => {
    vi.useFakeTimers();
    for (const boxed of [false, true]) {
      const doc = editor({ boxed });
      const work = plainTitles(doc);
      doc.getElementById('bio-edit')!.remove();
      expect(bioControl(doc)).toBeNull();
      const { result, steps } = await quickly(writeBioSteps(doc, NEW_BIO));
      expect(result).toBe('none');
      expect(steps.control).toBe(false);
      expect([work.opened(), work.saves()]).toEqual([0, 0]);
      expect(work.work()).toContain('Owner at Summit Roof Leads');
    }
  });

  it('still finds the Bio row’s own Edit with plain-word titles', async () => {
    vi.useFakeTimers();
    const doc = editor();
    const work = plainTitles(doc);
    expect(bioControl(doc)?.id).toBe('bio-edit');
    expect(await quickly(writeBio(doc, NEW_BIO))).toBe('done');
    expect(work.opened()).toBe(0);
  });

  it('closes a box that isn’t the bio’s, writing nothing in it', async () => {
    vi.useFakeTimers();
    const doc = editor();
    const work = plainTitles(doc);
    // The Edit by Bio opens Work's box, as a page drawn some other way might.
    const edit = doc.getElementById('bio-edit')!;
    edit.replaceWith(edit.cloneNode(true));
    doc
      .getElementById('bio-edit')!
      .addEventListener('click', () =>
        doc.querySelector<HTMLElement>('#work-row [role="button"]')!.click(),
      );
    const { result, steps } = await quickly(writeBioSteps(doc, NEW_BIO));
    expect(result).toBe('none');
    expect(steps).toMatchObject({ control: true, boxes: 1, fits: false, typed: false });
    expect(work.saves()).toBe(0);
    expect(doc.querySelector('input[aria-label="Company"]')).toBeNull();
    expect(work.work()).toContain('Owner at Summit Roof Leads');
  });

  it('says it didn’t save when the bio shows anywhere but under Bio', async () => {
    vi.useFakeTimers();
    const doc = editor({ saves: false });
    // Save closes the box and puts the bio under Work: not the bio's place.
    doc.getElementById('bio-edit')!.addEventListener('click', () => {
      const save = [...doc.querySelectorAll<HTMLElement>('#bio-row [role="button"]')].find(
        (b) => b.textContent === 'Save',
      )!;
      save.addEventListener('click', () => {
        doc.getElementById('work-row')!.insertAdjacentHTML('beforeend', `<span>${NEW_BIO}</span>`);
        doc.querySelector('#bio-row textarea')?.remove();
      });
    });
    const { result, steps } = await quickly(writeBioSteps(doc, NEW_BIO));
    expect(result).toBe('not_saved');
    expect(steps).toMatchObject({ typed: true, saves: 1, saved: false });
  });
});
