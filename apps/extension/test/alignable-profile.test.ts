/**
 * The person's own Alignable profile (src/networks/alignable/own-profile.ts, docs/outreach.md decision 80): read as the
 * AI's check reads it, its Elevator Pitch and My Ideal Customer opened and closed with nothing written or saved, and
 * About Us's own page looked at for its box and Save. On a page drawn as the owner's Check Alignable outlined his own
 * (0.62.0, 18 Oct 2026), with its words made up here.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ALIGNABLE } from '../src/networks/alignable/site';
import { readLooking } from '../src/networks/looking/read';

const AL = 'https://www.alignable.com';

const page = (url: string, body: string) =>
  new JSDOM(
    `<!doctype html><html><head><title>Casey Owner</title></head><body>${body}</body></html>`,
    {
      url,
    },
  ).window.document;

/** Their own profile, as Alignable draws it at the business's address with ?user=, the parts by its test ids. */
const OWN_PROFILE = `<div><header><nav aria-label="Main">
    <a href="/biz?_nav=1"><div>Home</div></a><a href="/biz/conversations"><div>Messages</div></a>
  </nav></header>
  <nav aria-label="Profile"><a aria-current="page" href="/biz/businesses/my_profile"><span>Profile</span></a></nav>
  <section>
    <div><div>COMPLETE YOUR PROFILE</div><button>Finish it now</button></div>
    <div>
      <span><a href="/biz/users/77/edit"><img alt="Casey Owner profile picture" /></a></span>
      <div><h1 title="Casey Owner">Casey Owner</h1><h2 title="Owner, Summit Roofing">Owner, Summit Roofing</h2>
        <a href="/columbus-oh">Columbus, OH</a></div>
      <div><button>Edit Profile</button><a href="/biz/businesses/my_profile?preview=true"><span>Preview Profile</span></a></div>
    </div>
    <div>
      <div data-testid="ideal-customer-information"><h1>My Ideal Customers</h1>
        <div data-testid="ideal-customer-add-description">
          <span>Describe your ideal customer so Alignable can introduce you to the right people.</span>
          <button><svg></svg>Add</button></div>
        <div><button data-testid="ideal-customer-type"><svg></svg>Homeowners and landlords</button>
          <button data-testid="ideal-customer-location"><svg></svg>Within 25 miles of Columbus, OH</button></div>
        <div data-testid="ideal-customer-tags"><div>
          <a href="/biz/search?q=roof+repair"><span>Roof repair</span></a>
          <a href="/biz/search?q=storm+damage"><span>Storm damage</span></a></div>
          <button data-testid="ideal-customer-edit-tags"><svg></svg>Edit</button></div>
      </div>
      <div data-testid="ideal-partner-information"><h1>Ideal Referral Partners for Summit Roofing</h1>
        <div data-testid="ideal-partner-add-description">
          <span>Insurance agents and realtors who see storm damage first.</span>
          <button><svg></svg>Edit</button></div>
        <div data-testid="ideal-partner-tags"><div>
          <a href="/biz/search?q=insurance"><span>Insurance agents</span></a></div></div>
      </div>
    </div>
    <div>
      <div><div>About Us</div>
        <div><button data-testid="elevator-pitch-cta-button"><svg></svg><p>Add Your Elevator Pitch</p></button>
          <a href="/biz/profile/about_us?source=profile"><div><svg></svg>Edit</div></a></div></div>
      <p>Summit Roofing has fixed roofs across Columbus for twelve years, with free inspections after every storm.</p>
      <div><div><h3>Products and services we offer</h3>
        <a href="/biz/profile/about_us?source=profile"><div>Edit</div></a></div></div>
    </div>
    <div><div><span>Products & Services</span>
      <a href="/biz/services/new?preview=true">Add a product or service</a></div>
      <div><div><div title="Service"><svg></svg></div>
        <div><a href="/columbus-oh/summit-roofing/storm-inspections?cyattr=1">Storm inspections</a>
          <div>A free roof check within two days of any storm.</div>
          <div><a href="/biz/services/501">View</a><a href="/biz/services/501/edit">Edit</a>
            <a href="/forward_referral_card/9?resource=1">Refer</a></div></div></div></div>
    </div>
  </section></div>`;

const ownProfile = () => page(`${AL}/columbus-oh/summit-roofing?user=77`, OWN_PROFILE);

describe('their own Alignable profile', () => {
  it('reads it as the AI’s check reads it: About Us, who they serve and partner with, and the services', () => {
    const read = ALIGNABLE.ownProfile!.read(
      ownProfile(),
      `${AL}/columbus-oh/summit-roofing?user=77`,
    );
    expect(read).toEqual({
      platform: 'alignable',
      url: `${AL}/columbus-oh/summit-roofing?user=77`,
      name: 'Casey Owner',
      picture: 'A profile photo Alignable didn’t describe',
      bio: null,
      about:
        'Summit Roofing has fixed roofs across Columbus for twelve years, with free inspections after every storm.',
      intro: [
        'Title: Owner, Summit Roofing',
        'Ideal customer: Homeowners and landlords, Within 25 miles of Columbus, OH',
        // Its few words only say to add some: never read as theirs.
        'Ideal customer tags: Roof repair, Storm damage',
        'Ideal partner, in their words: Insurance agents and realtors who see storm damage first.',
        'Ideal partner tags: Insurance agents',
      ],
      featured: ['Storm inspections: A free roof check within two days of any storm.'],
      posts: [],
      recommendations: null,
    });
  });

  it('counts the recommendations it shows, none beside Alignable’s ask for one, and doesn’t guess otherwise', () => {
    const read = (extra: string) => {
      const doc = ownProfile();
      (doc.querySelector('main, [role="main"]') ?? doc.body).insertAdjacentHTML('beforeend', extra);
      return ALIGNABLE.ownProfile!.read(doc, `${AL}/columbus-oh/summit-roofing?user=77`)
        .recommendations;
    };
    expect(read('<section><h2>12 Recommendations</h2></section>')).toBe(12);
    expect(
      read('<section><a href="/biz/recs"><span>Recommendations (3)</span></a></section>'),
    ).toBe(3);
    expect(read('<section><span>1,204 recommendations</span></section>')).toBe(1204);
    // A profile with none shows only the ask (the owner's own, 0.71.0).
    expect(read('<span><a href="/biz/word_of_mouth">Ask for a recommendation</a></span>')).toBe(0);
  });

  it('lists the pages its Edit links open: About Us’s, their details’ and a service’s', () => {
    const doc = ownProfile();
    expect(readLooking(doc, doc.location.href, ALIGNABLE).edits).toEqual([
      `${AL}/biz/users/77/edit`,
      `${AL}/biz/profile/about_us`,
      `${AL}/biz/services/501/edit`,
    ]);
  });

  it('opens the Elevator Pitch, sees its box and Save, and closes it with nothing written or saved', async () => {
    const doc = ownProfile();
    let saved = 0;
    doc
      .querySelector('[data-testid="elevator-pitch-cta-button"]')!
      .addEventListener('click', () => {
        const dialog = doc.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `<h2>Elevator Pitch</h2><textarea aria-label="Elevator Pitch"></textarea>
        <button>Save</button><button>Cancel</button>`;
        dialog.querySelectorAll('button')[0]!.addEventListener('click', () => saved++);
        dialog.querySelectorAll('button')[1]!.addEventListener('click', () => dialog.remove());
        doc.body.append(dialog);
      });
    const tried = await ALIGNABLE.looks.pitch!.look(doc, doc.location.href);
    expect(tried).toMatchObject({
      step: 'pitch',
      works: true,
      found: { button: true, opened: true, box: true, save: 1, cancel: true, closed: true },
    });
    // Its outline while it was open: how what the AI writes will be put in.
    expect(tried.outline).toContain('dialog');
    expect(tried.outline).toContain('Elevator Pitch');
    expect(saved).toBe(0);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
    expect(doc.querySelector('textarea')).toBeNull();
  });

  it('says so when the Elevator Pitch opens no box to write in, and closes it by Escape', async () => {
    const doc = ownProfile();
    doc
      .querySelector('[data-testid="elevator-pitch-cta-button"]')!
      .addEventListener('click', () => {
        const dialog = doc.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `<h2>Record your Elevator Pitch</h2><button>Start recording</button>`;
        dialog.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Escape') dialog.remove();
        });
        doc.body.append(dialog);
      });
    expect(await ALIGNABLE.looks.pitch!.look(doc, doc.location.href)).toMatchObject({
      works: false,
      found: { opened: true, box: false, cancel: false, closed: true },
      missing: ['the Elevator Pitch opened no box to write in'],
    });
  }, 10_000);

  it('waits for the box an Elevator Pitch’s box over the page draws after it opens', async () => {
    // The owner's Check (0.66.0) looked while the box over the page was still empty.
    const doc = ownProfile();
    doc
      .querySelector('[data-testid="elevator-pitch-cta-button"]')!
      .addEventListener('click', () => {
        const dialog = doc.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `<svg></svg><svg></svg>`;
        doc.body.append(dialog);
        setTimeout(() => {
          dialog.innerHTML = `<textarea placeholder="Your elevator pitch"></textarea>
            <button>Save</button><button>Cancel</button>`;
          dialog
            .querySelector('button:last-child')!
            .addEventListener('click', () => dialog.remove());
        }, 600);
      });
    expect(await ALIGNABLE.looks.pitch!.look(doc, doc.location.href)).toMatchObject({
      works: true,
      found: { opened: true, box: true, save: 1, cancel: true, closed: true },
    });
  });

  it('opens My Ideal Customer’s words and closes them again', async () => {
    const doc = ownProfile();
    const part = doc.querySelector('[data-testid="ideal-customer-add-description"]')!;
    part.querySelector('button')!.addEventListener('click', () => {
      part.insertAdjacentHTML(
        'beforeend',
        `<div data-editor><textarea placeholder="Describe your ideal customer"></textarea>
          <button>Save</button><button>Cancel</button></div>`,
      );
      part
        .querySelector('[data-editor] button:last-child')!
        .addEventListener('click', () => part.querySelector('[data-editor]')!.remove());
    });
    expect(await ALIGNABLE.looks.ideal!.look(doc, doc.location.href)).toMatchObject({
      step: 'ideal',
      works: true,
      found: { opened: true, box: true, save: 1, cancel: true, closed: true },
    });
    expect(part.querySelector('textarea')).toBeNull();
  });

  it('finds About Us’s box and Save on its own page, writing nothing', () => {
    const doc = page(
      `${AL}/biz/profile/about_us`,
      `<main><form><label for="about">About Us</label><textarea id="about">We fix roofs.</textarea>
        <input id="site" type="text" placeholder="Website" /><button>Save Changes</button></form></main>`,
    );
    expect(ALIGNABLE.looks.about!.look(doc, doc.location.href)).toMatchObject({
      step: 'about',
      works: true,
      found: { boxes: 2, box: true, save: 1 },
    });
    expect(doc.querySelector('textarea')!.value).toBe('We fix roofs.');
    // A read of the page counts its boxes, so Check knows it's drawn.
    expect(readLooking(doc, doc.location.href, ALIGNABLE).boxes).toBe(2);
  });

  it('never presses About Us’s Edit on their profile, which emails them a code to go on, nor takes the gallery’s form for it', async () => {
    // The owner's Check (0.67.0): About Us's page leads back to the profile, where only the gallery's form was, and
    // its Edit opens a box asking for a code Alignable emails them (0.69.0).
    const doc = page(
      `${AL}/austin-tx/acme-roofing?user=7`,
      `<main><div><div>About Us</div><a href="/biz/profile/about_us?source=about_us_section"><div>Edit</div></a></div>
        <form><div data-testid="gallery-uploader-picker-dropzone"><input type="file" /></div>
          <label for="t">Title</label><input id="t" type="text" /><label for="d">Description</label>
          <textarea id="d" placeholder="Add description"></textarea><a>Cancel</a><input type="submit" /></form></main>`,
    );
    let pressed = false;
    doc.querySelector('a[href*="about_us_section"]')!.addEventListener('click', (e) => {
      e.preventDefault();
      pressed = true;
    });
    expect(await ALIGNABLE.looks.about!.look(doc, doc.location.href)).toMatchObject({
      step: 'about',
      works: true,
      found: { button: true, emailsCode: true },
    });
    expect(pressed).toBe(false);
  });

  it('finds About Us’s Save drawn as the form’s own submit, as the owner’s Check found it (0.66.0)', () => {
    const doc = page(
      `${AL}/biz/profile/about_us`,
      `<form><input type="hidden" name="authenticity_token" value="x" />
        <input id="name" type="text" placeholder="Business Name" />
        <textarea placeholder="Add description">We fix roofs.</textarea>
        <a>Cancel</a><input type="submit" value="Save" /></form>`,
    );
    expect(ALIGNABLE.looks.about!.look(doc, doc.location.href)).toMatchObject({
      step: 'about',
      works: true,
      found: { box: true, save: 1 },
    });
  });
});
