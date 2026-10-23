/**
 * The person's own profile (decision 64), on a hand-written page: what a stranger sees first, read for the AI's
 * check, and the bio put in with Edit bio and Save. The page is our best guess at Facebook's, not a saved one.
 */
import { describe, expect, it } from 'vitest';
import { bioOf, readOwnProfile, writeBio } from '../src/networks/facebook/own-profile';
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
