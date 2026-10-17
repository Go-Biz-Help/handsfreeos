/**
 * LinkedIn's newer layout, as the owner's page outlines of 16 Oct 2026 showed it (HANDSFREEOS_SOCIAL_NETWORKS_
 * IMPLEMENTATION_PLAN.md, "The owner's LinkedIn test"), on the two pages rebuilt from those outlines with made-up
 * people: test/fixtures/linkedin-feed-2026-10.html (his feed just after he liked its first post) and
 * test/fixtures/linkedin-own-profile-2026-10.html (his own profile, scrolled to its foot). Each is taken as written
 * and again with a bare box around every element:
 *
 * - noting: a like on a person's post, once and to them, told by what changes on its reaction button and never by
 *   its words; a like taken back, and a company's, a showcase page's, a promoted, a group's (its author unlinked) or
 *   your own post's, never; a reshare's like to the one who wrote it, not who reposted it; a reaction picked from the
 *   menu beside the button; a comment's like; a comment sent with its button, a button LinkedIn's words don't name,
 *   or Enter, once; a Reply under the box, or the post's Send link, never one;
 * - reading the feed's posts, with their authors, headlines, words, links and counts; the runner's like, its comment
 *   and who engaged on the newer layout;
 * - your own profile: its name, headline, photo and banner, the whole About, every role under Experience, and no
 *   Featured or posts; and, as LinkedIn drew it for the owner's Check LinkedIn of 17 Oct 2026, its About and
 *   Experience as empty places it fills only a moment after each comes into view, waited on before the read; and the
 *   headline put in through its newer box (Edit profile's link, Headline a writing box named by the line above it);
 * - the outline: LinkedIn's words for the controls the readers now rely on, and never a name.
 */
import { describe, expect, it, vi } from 'vitest';
import { linkedin } from '../src/networks';
import type { Noticed } from '../src/networks/kit';
import { ENTER_LOOK_MS, LIKE_LOOK_MS, linkedInNoticer } from '../src/networks/linkedin/actions';
import { likeTheirPost, theirPosts, writeComment } from '../src/networks/linkedin/auto';
import { readComments, readReactions } from '../src/networks/linkedin/compose';
import { loadNote, ownProfileNote } from '../src/jobs/report';
import {
  headlineOf,
  loadWholeProfile,
  readOwnProfile,
  writeHeadline,
} from '../src/networks/linkedin/own-profile';
import { readPage } from '../src/networks/linkedin/page';
import type { ProfileRef } from '../src/networks/linkedin/types';
import { boxEverything, load } from './load';

const LI = 'https://www.linkedin.com';
const FEED = `${LI}/feed/`;
const OWN = `${LI}/in/chris-gee-12/?isSelfProfile=true`;
const FEED_PAGE = 'linkedin-feed-2026-10.html';
const OWN_PAGE = 'linkedin-own-profile-2026-10.html';
const NOW = new Date('2026-10-16T12:00:00Z');

// Each test builds LinkedIn's whole newer feed or profile in jsdom, and half of them with a box around every element:
// seconds of work on a busy CI runner, past vitest's 5 to start with.
vi.setConfig({ testTimeout: 30_000 });

const byName = (username: string): ProfileRef => ({
  id: null,
  username,
  url: `${LI}/in/${username}/`,
});

const SHAPES = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

const page = (fixture: string, url: string, boxed: boolean) => {
  const doc = load(fixture, url);
  return boxed ? boxEverything(doc) : doc;
};

/** The post whose menu says who wrote it. */
function postBy(doc: Document, name: string): Element {
  const menu = doc.querySelector(`[aria-label="Open control menu for post by ${name}"]`);
  if (!menu) throw new Error(`No post by ${name}`);
  return menu.closest('[role="listitem"]')!;
}

/** A post's reaction button, as the page draws it: the first button whose label says its state. */
function reactionButton(post: Element): Element {
  return post.querySelector('button[aria-label^="Reaction button state"]')!;
}

/** What LinkedIn does to a reaction button when a reaction is given or taken back: its label and its count. */
function show(button: Element, label: string, count: number | null) {
  button.setAttribute('aria-label', label);
  const spans = [...button.querySelectorAll('span')].filter((s) => /^\d+$/.test(s.textContent!));
  const number = spans[spans.length - 1];
  if (count === null) number?.remove();
  else if (number) number.textContent = String(count);
  else button.insertAdjacentHTML('beforeend', `<span>${count}</span>`);
}

/** The step a noticed click notes now, or once its page says it went. */
function noted(noticed: Noticed | null) {
  if (!noticed || noticed.kind === 'answer' || noticed.kind === 'seen') return null;
  return noticed.kind === 'step' ? noticed.step : noticed.went() ? noticed.step : null;
}

/** A click whose page shows only a moment later what it did. */
function later(noticed: Noticed | null) {
  if (noticed?.kind !== 'maybe') throw new Error(`Not a maybe: ${JSON.stringify(noticed)}`);
  return noticed;
}

// -------------------------------------------------------------------------------------------------- noting

describe.each(SHAPES)('noting your steps on LinkedIn’s newer feed, %s', (_, boxed) => {
  const feed = () => page(FEED_PAGE, FEED, boxed);

  describe('a like', () => {
    it('is noted once a person’s post shows it, to them, by what changed on its button', () => {
      const doc = feed();
      const noticer = linkedInNoticer();
      const button = reactionButton(postBy(doc, 'Sam Lee'));
      const pressed = later(noticer.click(button.querySelector('svg')!, doc, FEED));
      expect(pressed.afterMs).toBe(LIKE_LOOK_MS);
      expect(pressed.step).toEqual({
        kind: 'like',
        to: { name: 'Sam Lee', profile: byName('sam-lee-77') },
        group: null,
        // The newer feed shows no link to the post.
        postUrl: null,
        thread: null,
        replying: null,
      });
      // LinkedIn hasn't shown it yet: nothing went.
      expect(pressed.went()).toBe(false);
      show(button, 'Reaction button state: like', 60);
      expect(pressed.went()).toBe(true);
      // Pressed again, it's taken back: not a second like.
      const again = later(noticer.click(button, doc, FEED));
      show(button, 'Reaction button state: no reaction', 59);
      expect(again.went()).toBe(false);
    });

    it('is told by what changed, never by the button’s words', () => {
      const doc = feed();
      const button = reactionButton(postBy(doc, 'Priya Raman'));
      const avery = reactionButton(postBy(doc, 'Avery Lane'));
      // Words the extension has never seen, the same on every post's button.
      for (const each of doc.querySelectorAll('button[aria-label^="Reaction button state"]'))
        each.setAttribute('aria-label', 'Réagir');
      const byCount = later(linkedInNoticer().click(button, doc, FEED));
      show(button, 'Réagir', 423);
      expect(byCount.went()).toBe(true);
      expect(byCount.step.to).toEqual({
        name: 'Priya Raman',
        profile: byName('priya-raman-remodels'),
      });
      // No count to go by: its label, now unlike the others', says one was given.
      const byLabel = later(linkedInNoticer().click(avery, doc, FEED));
      show(avery, 'Réaction : J’aime', null);
      expect(byLabel.went()).toBe(true);
      expect(byLabel.step.to.name).toBe('Avery Lane');
    });

    it('is noted when LinkedIn draws the whole post again with it', () => {
      const doc = feed();
      const post = postBy(doc, 'Sam Lee');
      const pressed = later(linkedInNoticer().click(reactionButton(post), doc, FEED));
      const again = post.cloneNode(true) as Element;
      show(reactionButton(again), 'Reaction button state: like', 60);
      post.replaceWith(again);
      expect(pressed.went()).toBe(true);
    });

    it('is never one taken back: the post you liked, liked no more', () => {
      const doc = feed();
      const button = reactionButton(postBy(doc, 'Marisol Vega'));
      const pressed = later(linkedInNoticer().click(button, doc, FEED));
      expect(pressed.step.to).toEqual({
        name: 'Marisol Vega',
        profile: byName('marisol-vega-roofing'),
      });
      show(button, 'Reaction button state: no reaction', 54);
      expect(pressed.went()).toBe(false);
    });

    it('goes to whoever wrote a reshare, not who reposted it', () => {
      const doc = feed();
      const button = reactionButton(postBy(doc, 'Riley Ann Brooks'));
      const pressed = later(linkedInNoticer().click(button, doc, FEED));
      expect(pressed.step.to).toEqual({
        name: 'Riley Ann Brooks',
        profile: byName('riley-ann-brooks'),
      });
      show(button, 'Reaction button state: like', 34);
      expect(pressed.went()).toBe(true);
    });

    it('is never noted on a company’s, a showcase page’s, a promoted or a group’s post', () => {
      const doc = feed();
      const noticer = linkedInNoticer();
      for (const by of [
        // A company's ad.
        'FieldPro Software',
        // A company's post, reposted by a member above the line.
        'Rio Grande Plumbing',
        // A showcase page's ad, a member above the line.
        'SalesForward Pro Tips',
        // A member's post that LinkedIn was paid to show.
        'Elena Ruiz',
        // Group posts: their authors are named, not linked; the member above the line only commented.
        'Nina Alvarez',
        'Hugo Brandt',
      ])
        expect(noticer.click(reactionButton(postBy(doc, by)), doc, FEED), by).toBeNull();
    });

    it('is never noted on your own post', () => {
      const doc = feed();
      // Without the top bar's name to go by: your profile is the one beside Start a post.
      doc.querySelector('header img')!.setAttribute('alt', '');
      const post = postBy(doc, 'Sam Lee');
      expect(linkedInNoticer().click(reactionButton(post), doc, FEED)).not.toBeNull();
      for (const link of post.querySelectorAll('a[href*="/in/sam-lee-77/"]'))
        link.setAttribute('href', '/in/chris-gee-12/');
      expect(linkedInNoticer().click(reactionButton(post), doc, FEED)).toBeNull();
    });

    it('is noted when picked from the reactions menu, by what the button shows after', () => {
      const doc = feed();
      const noticer = linkedInNoticer();
      const post = postBy(doc, 'Sam Lee');
      const menu = post.querySelector('[aria-label="Open reactions menu"]')!;
      // The menu opens: nothing yet.
      expect(noticer.click(menu, doc, FEED)).toBeNull();
      // LinkedIn draws its reactions over the page, in words the extension needn't know.
      doc.body.insertAdjacentHTML(
        'beforeend',
        '<div role="dialog"><button type="button" aria-label="Applaudir"><img alt="" src="c.svg" /></button></div>',
      );
      const pick = later(noticer.click(doc.querySelector('[aria-label="Applaudir"]')!, doc, FEED));
      show(reactionButton(post), 'Reaction button state: celebrate', 60);
      expect(pick.went()).toBe(true);
      expect(pick.step.to.name).toBe('Sam Lee');
      // Opened and left: nothing changed, nothing noted.
      expect(noticer.click(menu, doc, FEED)).toBeNull();
      expect(noted(noticer.click(doc.body, doc, FEED))).toBeNull();
    });

    it('notes a comment’s like to whoever wrote the comment', () => {
      const doc = feed();
      const button = doc
        .querySelector('[role="button"] [role="img"][aria-label^="Reaction button state"]')!
        .closest('[role="button"]')!;
      const pressed = later(linkedInNoticer().click(button, doc, FEED));
      expect(pressed.step).toMatchObject({
        kind: 'like',
        to: { name: 'Owen Park', profile: byName('owen-park-roofing') },
      });
      expect(pressed.went()).toBe(false);
      button
        .querySelector('[role="img"]')!
        .setAttribute('aria-label', 'Reaction button state: like');
      button.querySelector('span span')!.textContent = '1';
      expect(pressed.went()).toBe(true);
    });
  });

  describe('a comment', () => {
    const box = (doc: Document) =>
      doc.querySelector('[role="textbox"][aria-label="Text editor for creating comment"]')!;
    const write = (doc: Document, words: string) => {
      box(doc).querySelector('p')!.textContent = words;
    };
    const empty = (doc: Document) =>
      box(doc).querySelector('p')!.replaceChildren(doc.createElement('br'));
    /** The box's own buttons: an emoji's, a GIF's and a photo's, as the outline showed them. */
    const buttons = (doc: Document) =>
      ['Add an emoji', 'Add a GIF', 'Add photo'].map((label) =>
        doc.querySelector(`button[aria-label="${label}"]`)!,
      );
    /** The one LinkedIn adds after them once there's writing: what it says is a guess, so it's written here. */
    const addSend = (doc: Document, html: string) => {
      const photo = buttons(doc)[2]!;
      photo.insertAdjacentHTML('afterend', html);
      return photo.nextElementSibling!;
    };

    it('is noted once Enter empties the box, to whoever wrote the post', () => {
      const doc = feed();
      write(doc, 'We do the same walk-through after every storm.');
      const pressed = later(linkedInNoticer().enter(box(doc).querySelector('p')!, doc, FEED));
      expect(pressed.afterMs).toBe(ENTER_LOOK_MS);
      expect(pressed.step).toEqual({
        kind: 'comment',
        to: { name: 'Marisol Vega', profile: byName('marisol-vega-roofing') },
        group: null,
        postUrl: null,
        thread: null,
        replying: null,
      });
      expect(JSON.stringify(pressed.step)).not.toContain('walk-through');
      expect(pressed.went()).toBe(false);
      empty(doc);
      expect(pressed.went()).toBe(true);
    });

    it('is noted at once with a Comment button, and Enter just before isn’t noted again', () => {
      const doc = feed();
      const noticer = linkedInNoticer();
      write(doc, 'Great checklist.');
      const send = addSend(
        doc,
        '<button type="button" aria-label="Comment"><span>Comment</span></button>',
      );
      const entered = later(noticer.enter(box(doc), doc, FEED));
      expect(noted(noticer.click(send, doc, FEED))).toMatchObject({
        kind: 'comment',
        to: { name: 'Marisol Vega' },
      });
      empty(doc);
      expect(entered.went()).toBe(false);
    });

    it('is noted with a button whose words it doesn’t know, once the box empties; its other buttons send nothing', () => {
      const doc = feed();
      const noticer = linkedInNoticer();
      write(doc, 'Saving this one.');
      const send = addSend(
        doc,
        '<button type="button" aria-label="Envoyer"><svg aria-hidden="true"></svg></button>',
      );
      // The emoji's opens a menu; the photo's leaves the writing where it is.
      const [emoji, , photo] = [...buttons(doc)];
      expect(noticer.click(emoji!, doc, FEED)).toBeNull();
      const pictured = later(noticer.click(photo!, doc, FEED));
      expect(pictured.went()).toBe(false);
      const sent = later(noticer.click(send, doc, FEED));
      expect(sent.step).toMatchObject({ kind: 'comment', to: { name: 'Marisol Vega' } });
      empty(doc);
      expect(sent.went()).toBe(true);
      // Only the last press before it emptied.
      expect(pictured.went()).toBe(false);
    });

    it('is never a comment’s Reply, with writing in the post’s box above it, nor the post’s Send', () => {
      const doc = feed();
      const noticer = linkedInNoticer();
      write(doc, 'Not sent yet.');
      const reply = doc.querySelector('button[aria-label="Reply"]')!;
      expect(noticer.click(reply, doc, FEED)).toBeNull();
      const share = postBy(doc, 'Marisol Vega').querySelector('a[aria-label="Send"]')!;
      expect(noticer.click(share.querySelector('svg')!, doc, FEED)).toBeNull();
    });
  });
});

// ------------------------------------------------------------------------------------------------- reading

describe.each(SHAPES)('reading LinkedIn’s newer feed, %s', (_, boxed) => {
  it('reads every post once, with its author, their headline, its words, link and counts', () => {
    const result = readPage(page(FEED_PAGE, FEED, boxed), FEED, NOW);
    expect(
      result.posts?.map((post) => ({
        by: post.author?.name,
        profile: post.author?.profile?.username ?? null,
        company: post.company?.url ?? null,
        when: post.when,
        headline: post.headline,
        url: post.url,
        reactions: post.reactions,
        comments: post.comments,
      })),
    ).toEqual([
      {
        by: 'Marisol Vega',
        profile: 'marisol-vega-roofing',
        company: null,
        when: '1d',
        headline: 'Owner at Vega Roofing | Storm damage and roof replacement across Central Texas',
        url: null,
        reactions: 55,
        comments: 9,
      },
      {
        by: 'FieldPro Software',
        profile: null,
        company: `${LI}/company/fieldpro-software/`,
        when: null,
        headline: null,
        url: null,
        reactions: 79,
        comments: 2,
      },
      {
        by: 'Sam Lee',
        profile: 'sam-lee-77',
        company: null,
        when: '5d',
        headline:
          'Owner at Lee Heating & Air | HVAC repair and installs for Pflugerville and Round Rock homes',
        url: null,
        reactions: 59,
        comments: 9,
      },
      {
        by: 'Priya Raman',
        profile: 'priya-raman-remodels',
        company: null,
        when: '1d',
        headline:
          'Kitchen and bath remodeler in Austin | 20 years of cabinets, tile and happy clients | Licensed and insured',
        url: null,
        reactions: 422,
        comments: 140,
      },
      {
        // Taylor Reed commented on it; Nina Alvarez wrote it, in a group, named but not linked. The group's link
        // names the post.
        by: 'Nina Alvarez',
        profile: null,
        company: null,
        when: '1d',
        headline: null,
        url: `${LI}/feed/update/urn:li:activity:7380000000000000611/`,
        reactions: 754,
        comments: 36,
      },
      {
        // Reposted by Morgan Ellis.
        by: 'Rio Grande Plumbing',
        profile: null,
        company: `${LI}/company/rio-grande-plumbing/`,
        when: '12h',
        headline: null,
        url: null,
        reactions: 239,
        comments: 23,
      },
      {
        by: 'SalesForward Pro Tips',
        profile: null,
        company: `${LI}/showcase/salesforward-pro-tips/`,
        when: null,
        headline: null,
        url: null,
        reactions: 888,
        comments: 27,
      },
      {
        by: 'Avery Lane',
        profile: 'averylane',
        company: null,
        when: '2m',
        headline:
          'Landscape designer helping Austin homeowners build gardens that survive a Texas summer without much water',
        url: null,
        // Nobody yet: the bar shows no numbers.
        reactions: null,
        comments: null,
      },
      {
        by: 'Hugo Brandt',
        profile: null,
        company: null,
        when: '11h',
        headline: null,
        url: `${LI}/feed/update/urn:li:activity:7380000000000000622/`,
        reactions: 4,
        comments: null,
      },
      {
        by: 'Riley Ann Brooks',
        profile: 'riley-ann-brooks',
        company: null,
        when: '15h',
        headline:
          'Owner of Brooks HVAC | Heating and cooling for Austin homes since 2012 | Hiring technicians and apprentices now',
        url: null,
        reactions: 33,
        comments: 2,
      },
      {
        // Promoted by a company: no time.
        by: 'Elena Ruiz',
        profile: 'elena-ruiz-tx',
        company: null,
        when: null,
        headline:
          'Solar sales lead at SolarBridge | Helping Texas homeowners cut their power bills',
        url: null,
        reactions: 24,
        comments: 1,
      },
    ]);
  });

  it('reads a post’s whole words from its text box, without its “…more”, its video or its comments', () => {
    const [marisol, , sam] = readPage(page(FEED_PAGE, FEED, boxed), FEED, NOW).posts ?? [];
    expect(marisol!.text.split('\n')).toEqual([
      'Hail season is here, and most roof claims we see start with damage nobody noticed.',
      'Hi, I’m Marisol Vega and this is why.',
      'After every storm we walk the roof, the gutters and the attic before writing anything.',
      'Here is what we look for first:',
      '1. Granules in the gutters, which means the shingles are wearing.',
      '2. Dents on the soft metals: vents, flashing and the gutter itself. They tell you how big the hail was.',
      '3. Soft spots in the decking near the valleys, where water sits longest and rot starts before you see a stain.',
      '4. Lifted or creased shingles on the side that faced the wind.',
      '5. Water stains on the attic sheathing, always.',
      'None of these take more than an hour to check, and all of them matter.',
      'Insurance adjusters see dozens of roofs a week. If you can show them photos of each one, the claim goes faster.',
      'Homeowners: take photos of your roof every spring, before storms come.',
      'Roofers: send your customers a short checklist after every job so they know what to watch for next season.',
      'We put ours on the fridge magnet we leave behind, and it brings us more calls than any ad.',
      'If you’re in Central Texas and not sure what you’re looking at, send me a photo and I’ll tell you.',
      'No charge, no pressure, no sales pitch.',
      'Stay safe out there this season, everyone.',
      'Full checklist on our site: vegaroofing.example/checklist',
    ]);
    expect(sam!.text).toBe(
      'Big news: after nine years running the business from my truck, we just opened our first shop with Lee Heating.\nNine years ago I started Lee Heating with one van, a ladder and a phone that rang at all hours. Today we opened a real shop with room for six trucks, a training bay for our apprentices and a front desk so customers can finally talk to a person instead of my voicemail. Thank you to every customer who trusted a one-man crew, and to the team who made this possible.\nleeheating.example/jobs',
    );
  });
});

describe('the runner and the helpful post on LinkedIn’s newer feed', () => {
  it.each(SHAPES)('likes a post of theirs by its bar’s reaction button, %s', async (_, boxed) => {
    const doc = page(FEED_PAGE, FEED, boxed);
    const sam = byName('sam-lee-77');
    expect(theirPosts(doc, FEED, sam).map((found) => found.post.liked)).toEqual([false]);
    const button = reactionButton(postBy(doc, 'Sam Lee'));
    button.addEventListener('click', () => show(button, 'Reaction button state: like', 60));
    expect(await likeTheirPost(doc, FEED, sam, { index: 0, url: null })).toEqual({
      result: 'done',
      postUrl: null,
    });
    // One liked already is left alone.
    expect(
      await likeTheirPost(doc, FEED, byName('marisol-vega-roofing'), { index: 0, url: null }),
    ).toEqual({ result: 'already', postUrl: null });
  });

  it('comments in the post’s own box with its Comment, and leaves it to you when no button says so', async () => {
    for (const comment of [true, false]) {
      const doc = load(FEED_PAGE, FEED);
      const box = doc.querySelector('[aria-label="Text editor for creating comment"]')!;
      doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
        box.querySelector('p')!.textContent = text ?? '';
        return true;
      };
      if (comment) {
        const buttons =
          box.parentElement!.parentElement!.parentElement!.querySelector('div:last-child')!;
        buttons.insertAdjacentHTML(
          'beforeend',
          '<button type="button" aria-label="Comment"><span>Comment</span></button>',
        );
        buttons.lastElementChild!.addEventListener('click', () => {
          box.querySelector('p')!.replaceChildren(doc.createElement('br'));
        });
      }
      expect(await writeComment(doc, 'We do this walk-through too.')).toBe(
        comment ? 'done' : 'none',
      );
    }
  });

  it.each(SHAPES)(
    'reads who commented, and who reacted from the count, never you, %s',
    async (_, boxed) => {
      const doc = page(FEED_PAGE, FEED, boxed);
      expect(readComments(doc, FEED)).toEqual([
        {
          name: 'Owen Park',
          profile: byName('owen-park-roofing'),
          comment: expect.stringMatching(/^We did exactly this for my parents’ house/),
        },
        {
          name: 'Lena Ortiz',
          profile: byName('lena-ortiz-adjuster'),
          comment: 'Saved: vegaroofing.example/checklist Thanks!',
        },
      ]);
      const count = [...doc.querySelectorAll('a[href="/feed/"]')].find((a) =>
        /^55\s*reactions$/.test(a.textContent!.replace(/\s+/g, ' ').trim()),
      )!;
      count.addEventListener('click', () =>
        doc.body.insertAdjacentHTML(
          'beforeend',
          `<div role="dialog"><a href="/in/taylor-reed-5/"><span>Taylor Reed</span></a>
         <a href="/in/chris-gee-12/"><span>Chris Gee</span></a>
         <button type="button" aria-label="Dismiss"></button></div>`,
        ),
      );
      expect(await readReactions(doc, FEED)).toEqual([
        { name: 'Taylor Reed', profile: byName('taylor-reed-5'), comment: null },
      ]);
    },
  );
});

// ----------------------------------------------------------------------------------------- your own profile

describe.each(SHAPES)('your own profile in LinkedIn’s newer layout, %s', (_, boxed) => {
  const own = () => page(OWN_PAGE, OWN, boxed);
  const ABOUT = [
    'I help plumbers, roofers, cleaners and other home service businesses answer every call and turn more of them into booked jobs. For twelve years I ran sales teams at answering services, and I saw the same thing everywhere: good businesses losing work because nobody picked up, nobody called back, or the follow-up stopped after one try. Gee Consulting exists to fix exactly that, one business at a time.',
    'We set up simple systems that answer, follow up and book, so owners can stay on the tools. Most clients see more booked jobs within the first month, without hiring anyone new or buying expensive software they will never use. Everything we build is yours to keep.',
    'If you run a home service business in Texas and your phone rings more than you can answer, let’s talk. Book a 15-minute call and I’ll show you exactly where your leads are going, what that costs you each month, and the three changes that usually fix it fastest. No pitch, just the numbers.',
  ].join('\n');
  const HEADLINE =
    'Helping home service businesses answer every lead and book more jobs | Founder at Gee Consulting | Speaker on missed calls, follow-up and local growth';

  it('reads its name, headline, photo, banner, the whole About and every role, with nothing pressed', () => {
    const doc = own();
    const pressed: string[] = [];
    doc.addEventListener('click', (event) => pressed.push(String(event.target)), true);
    expect(readOwnProfile(doc, OWN)).toEqual({
      platform: 'linkedin',
      url: `${LI}/in/chris-gee-12/`,
      name: 'Chris Gee',
      picture: 'A profile photo LinkedIn didn’t describe',
      cover: 'A banner image LinkedIn didn’t describe',
      bio: HEADLINE,
      // Its "Top skills" below isn't the About.
      about: ABOUT,
      intro: [
        'Founder at Gee Consulting LLC · Jan 2019 - Present · 6 yrs 10 mos',
        'Board Member and Advisor at Callwise · Jun 2023 - Present · 2 yrs 5 mos',
        'Director of Sales and Partnerships at BrightLine Answering · Mar 2012 - Dec 2018 · 6 yrs 10 mos',
        'Account Executive, Small Business at Prairie Telecom · Jun 2008 - Feb 2012 · 3 yrs 9 mos',
        // A company with two roles: its name once, the roles listed under it.
        'Chair, Growth Committee at Austin Business Network · Jan 2020 - Dec 2024 · 5 yrs',
        'Member, Events Committee at Austin Business Network · Sep 2016 - Dec 2019 · 3 yrs 4 mos',
      ],
      // None featured, and "You haven’t posted yet" under Activity.
      featured: [],
      posts: [],
    });
    expect(pressed).toEqual([]);
  });

  it('reads only what’s drawn: with nothing below Activity yet, no roles, and never the About as a post', () => {
    const doc = own();
    // As a window hidden behind another had it: LinkedIn draws the sections below Activity only on screen.
    const activity = [...doc.querySelectorAll('h2')]
      .find((h) => h.textContent!.trim() === 'Activity')!
      .closest('section')!;
    for (const section of [...doc.querySelectorAll('section')])
      if (
        activity.compareDocumentPosition(section) &
        doc.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING
      )
        section.remove();
    expect(readOwnProfile(doc, OWN)).toMatchObject({ about: ABOUT, intro: [], posts: [] });
  });

  it('reads it as a profile too: you, your place, your first role and its company', () => {
    expect(readPage(own(), OWN, NOW).profile).toEqual({
      name: 'Chris Gee',
      profile: byName('chris-gee-12'),
      headline: HEADLINE,
      location: 'Round Rock, Texas, United States',
      about: ABOUT,
      role: {
        title: 'Founder',
        company: 'Gee Consulting LLC',
        dates: 'Jan 2019 - Present · 6 yrs 10 mos',
      },
      company: {
        name: 'Gee Consulting LLC',
        company: { id: 'gee-consulting-atx', url: `${LI}/company/gee-consulting-atx/` },
      },
      degree: null,
      connection: 'self',
      followFirst: false,
      mutualConnections: null,
    });
  });

  it('tells the photo and the banner apart by their labels, whichever comes first', () => {
    const doc = own();
    // The other way round: the first picture labelled with your name, the second as the background.
    for (const label of doc.querySelectorAll(
      'main [aria-label="Background image"], main [alt="Background image"]',
    ))
      label.setAttribute(label.hasAttribute('alt') ? 'alt' : 'aria-label', 'Chris Gee');
    doc
      .querySelector('main div[aria-label="Chris Gee"]')!
      .setAttribute('aria-label', 'Background image');
    expect(readOwnProfile(doc, OWN)).toMatchObject({
      picture: 'A profile photo LinkedIn didn’t describe',
      cover: 'A banner image LinkedIn didn’t describe',
    });
  });

  it('says there’s no photo when it’s LinkedIn’s stand-in for none', () => {
    const doc = own();
    doc
      .querySelector('main div[aria-label="Chris Gee"] img')!
      .setAttribute('src', 'https://static.licdn.com/aero-v1/sc/h/ghost-person.svg');
    expect(readOwnProfile(doc, OWN)).toMatchObject({ picture: null });
  });
});

// --------------------------------------------------------------------- putting the headline in, the newer box

describe('putting the headline in through LinkedIn’s newer box', () => {
  const NEW = 'I help plumbers and roofers answer every lead | Founder, Gee Consulting';
  const OLD =
    'Helping home service businesses answer every lead and book more jobs | Founder at Gee Consulting | Speaker on missed calls, follow-up and local growth';

  /**
   * The owner's Put this one in of 17 Oct 2026: the pencil (Edit profile) opens the box over the page; Headline is a
   * writing box named by the line above it, which takes typing as Chrome does; Save puts it under the name and closes
   * the box.
   */
  function editable() {
    const doc = load(OWN_PAGE, OWN);
    const typed: string[] = [];
    doc.querySelector('[aria-label="Edit profile"]')!.addEventListener('click', (event) => {
      event.preventDefault();
      const from = load('linkedin-edit-intro-2026-10.html', OWN);
      const outlet = doc.importNode(from.getElementById('modal-outlet')!, true);
      doc.body.append(outlet);
      const writing = outlet.querySelector('[role="textbox"]')!;
      for (const field of outlet.querySelectorAll('input'))
        field.addEventListener('input', () => typed.push('an input'));
      doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
        typed.push('headline');
        writing.textContent = text ?? '';
        return true;
      };
      [...outlet.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Save')!
        .addEventListener('click', () => {
          const under = [...doc.querySelectorAll('main *')].find(
            (e) => e.children.length === 0 && e.textContent?.replace(/\s+/g, ' ').trim() === OLD,
          )!;
          under.textContent = writing.textContent;
          outlet.remove();
        });
    });
    return { doc, typed };
  }

  it('presses Edit profile, writes only in the box named Headline, presses Save and sees it under the name', async () => {
    const { doc, typed } = editable();
    expect(headlineOf(doc, OWN)).toBe(OLD);
    expect(await writeHeadline(doc, OWN, NEW)).toBe('done');
    expect(headlineOf(doc, OWN)).toBe(NEW);
    expect(typed).toEqual(['headline']);
  });
});

// ------------------------------------------------------------------------- your own profile, drawn as it's seen

describe('your own profile in LinkedIn’s newer layout, drawn only as its places come into view', () => {
  const headingOf = (doc: Document, words: string) =>
    [...doc.querySelectorAll('h2')].find((h) => h.textContent!.trim() === words)!;

  /**
   * The owner's Check LinkedIn of 17 Oct 2026: the top and Activity drawn, and an empty place where About goes and one
   * where Experience goes, each filled `fillMs` after it comes into view (never, with null).
   */
  function drawnAsSeen(fillMs: number | null) {
    const doc = load(OWN_PAGE, OWN);
    const parts = [
      headingOf(doc, 'About').closest('section')!.parentElement!,
      headingOf(doc, 'Experience').closest('section')!,
    ];
    const seen: Element[] = [];
    for (const part of parts) {
      const place = doc.createElement('section');
      place.innerHTML = '<div><div></div><div><div></div></div><div><div></div></div></div>';
      part.replaceWith(place);
      (place as HTMLElement).scrollIntoView = () => {
        seen.push(place);
        if (fillMs !== null) setTimeout(() => place.isConnected && place.replaceWith(part), fillMs);
      };
    }
    return { doc, seen };
  }
  const waits = { pauseMs: 0, lookMs: 5, placeMs: 400, totalMs: 2_000 };

  it('keeps each place in view till LinkedIn draws it, then reads the whole About and every role', async () => {
    const { doc, seen } = drawnAsSeen(30);
    // Read straight away, the places are all there is.
    expect(readOwnProfile(doc, OWN)).toMatchObject({ about: null, intro: [] });
    const load = await loadWholeProfile(doc, waits);
    expect(seen).toHaveLength(2);
    expect(load).toMatchObject({ places: 2, left: 0 });
    const read = readOwnProfile(doc, OWN);
    expect(read.about).toMatch(/^I help plumbers, roofers, cleaners/);
    expect(read.intro).toHaveLength(6);
    expect(loadNote(ownProfileNote(read), load).note).not.toMatch(/empty/);
  });

  it('gives up on a place that’s never drawn, says so in its note, and keeps the outline', async () => {
    const { doc } = drawnAsSeen(null);
    const load = await loadWholeProfile(doc, waits);
    expect(load).toMatchObject({ places: 2, left: 2 });
    const note = loadNote(ownProfileNote(readOwnProfile(doc, OWN)), load);
    expect(note).toMatchObject({
      found: { roles: 0, placesBefore: 2, placesLeft: 2 },
      note: 'Not read: About, Experience, Featured, any posts. LinkedIn left 2 parts of the page empty.',
      outline: true,
    });
  });
});

// ------------------------------------------------------------------------------------------------ the outline

describe('the outline of LinkedIn’s newer pages', () => {
  const outline = (fixture: string, url: string) => {
    const doc = load(fixture, url);
    return linkedin.outline(doc, url, { version: '0.46.0', found: linkedin.readPage(doc, url) });
  };
  const feed = outline(FEED_PAGE, FEED);
  const own = outline(OWN_PAGE, OWN);

  it('shows LinkedIn’s words on the controls the readers now go by', () => {
    expect(feed).toContain('Found: 11 posts');
    for (const words of [
      'button aria-label="Reaction button state: like" type="button"',
      'button aria-label="Reaction button state: no reaction" type="button"',
      'button aria-label="Open reactions menu" aria-expanded="false" type="button"',
      'span "Feed post"',
      'aria-label="Text editor for creating comment"',
      '"commented on this"',
      '"reposted this"',
      '"Promoted by"',
      'button aria-label="Hide post by [2 words]" type="button"',
    ])
      expect(feed).toContain(words);
    for (const words of [
      'a aria-label="Edit profile" href="/in/{1}/edit/intro/"',
      'svg role="img" aria-label="Background image" aria-hidden="false"',
      'h2 "Experience"',
      'p "You haven’t posted yet"',
      'href="/in/{1}/?isSelfProfile=true"',
    ])
      expect(own).toContain(words);
  });

  it('never holds a name or what anyone wrote', () => {
    for (const [name, text] of [
      ['feed', feed],
      ['own profile', own],
    ] as const)
      for (const secret of [
        'Chris',
        'Gee',
        'Marisol',
        'Vega',
        'Sam Lee',
        'Owen',
        'Lena',
        'Priya',
        'Nina',
        'Riley',
        'Brooks',
        'Elena',
        'Hugo',
        'Quinn',
        'Taylor',
        'Morgan',
        'Avery',
        'Callwise',
        'BrightLine',
        'Prairie',
        'Hail',
        'water heater',
        'roof',
        'chris-gee',
        'marisol',
        '7380000000000000611',
        'ACoAA',
      ])
        expect(text, `${name}: ${secret}`).not.toContain(secret);
  });
});
