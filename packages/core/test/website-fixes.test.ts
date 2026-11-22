/**
 * "Email your web person" (the owner, 2026-11-12): the website's changes for texting approval, each in its own text
 * file. What a web person pastes from these files is what the carriers' reviewer reads, so the tests hold the parts
 * that matter: the carriers' exact phrases, the code to paste, the links, and the rules about the box.
 */
import { describe, expect, it } from 'vitest';
import { CARRIER_DISCLOSURE } from '../src/messaging/consent';
import {
  MOBILE_DATA_CLAUSE,
  policyAsText,
  privacyPolicy,
  termsOfService,
} from '../src/messaging/policies';
import {
  fixesForPath,
  fixesMissing,
  fixUnavailable,
  webPersonEmail,
  WEBSITE_FIX_IDS,
  WEBSITE_FIXES,
  websiteFixFiles,
  type WebsiteFixFacts,
} from '../src/messaging/website-fixes';
import {
  websiteFixFactsFrom,
  type KeptPolicy,
  type WebsiteFixSources,
} from '../src/messaging/web-person';

const SOURCES: WebsiteFixSources = {
  business: 'Shop Your Solar',
  siteSlug: 'shop-your-solar',
  legal: {
    policyUrl: null,
    termsUrl: null,
    business: {
      legalName: 'Shop Your Solar LLC',
      website: 'https://shopyoursolar.com',
      email: 'hello@shopyoursolar.com',
      phone: '(713) 555-0161',
      offers: false,
    },
  },
  optIn: {
    path: 'own_site',
    pageUrl: 'https://shopyoursolar.com/contact',
    otherPaths: [],
    displayName: null,
  },
  website: 'https://shopyoursolar.com',
  form: { id: '00000000-0000-4000-8000-000000000001', name: 'Contact form', slug: 'contact-form' },
  chat: { publicKey: 'wk_abc', hidden: false },
};
const ORIGINS = { app: 'https://app.handsfreeos.com', pages: 'https://go.shopyoursolar.com' };
const facts = (over: Partial<WebsiteFixSources> = {}): WebsiteFixFacts =>
  websiteFixFactsFrom({ ...SOURCES, ...over }, ORIGINS);
const fileOf = (f: WebsiteFixFacts, id: 'form' | 'chat') => websiteFixFiles(f, [id])[0]!.text;
/** The policy change is two files: the privacy policy, then the terms. */
const documentOf = (f: WebsiteFixFacts, name: 'privacy-policy.txt' | 'terms.txt') =>
  websiteFixFiles(f, ['policy']).find((file) => file.filename === name)!.text;
const OWN_PAGES = {
  ...SOURCES.legal,
  policyUrl: 'https://shopyoursolar.com/privacy',
  termsUrl: 'https://shopyoursolar.com/terms',
};
/** A privacy policy of the business's own, as texting approval handed it back: its words, and the part added. */
const KEPT: KeptPolicy = {
  sourceUrl: 'https://www.shopyoursolar.com/privacy/',
  blocks: [
    { kind: 'heading', text: 'Our privacy promise', gap: false, mark: null },
    { kind: 'paragraph', text: 'We keep your details to ourselves.', gap: false, mark: 'changed' },
    { kind: 'heading', text: 'Text messages', gap: true, mark: 'added' },
    { kind: 'paragraph', text: MOBILE_DATA_CLAUSE, gap: false, mark: 'added' },
  ],
  changes: [
    {
      action: 'replace',
      before: 'We may share your details with our marketing partners.',
      after: 'We keep your details to ourselves.',
      why: 'Carriers turn down a policy that shares phone numbers for marketing.',
    },
  ],
};

describe('each change is its own text file', () => {
  it('names the files, in order, for what was picked: the privacy policy and the terms each get one', () => {
    const files = websiteFixFiles(facts(), ['chat', 'form', 'policy']);
    expect(files.map((f) => f.filename)).toEqual([
      'add-the-form.txt',
      'privacy-policy.txt',
      'terms.txt',
      'add-the-chat.txt',
    ]);
    // What the command says it sent is the same list.
    expect(files.map((f) => f.filename)).toEqual(
      WEBSITE_FIX_IDS.flatMap((id) => WEBSITE_FIXES[id].filenames),
    );
    const policy = websiteFixFiles(facts(), ['policy']);
    expect(policy.map((f) => f.filename)).toEqual(['privacy-policy.txt', 'terms.txt']);
    expect(policy.map((f) => f.label)).toEqual(['Update the privacy policy', 'Update the terms']);
    expect(policy.every((f) => f.id === 'policy')).toBe(true);
  });

  it('our form: the code to paste, on the business’s own domain, for the page with the box', () => {
    const text = fileOf(facts(), 'form');
    expect(text).toContain(
      '<iframe src="https://go.shopyoursolar.com/f/shop-your-solar/contact-form?embed=1"',
    );
    // The line that fits the frame always loads from our own address.
    expect(text).toContain('<script src="https://app.handsfreeos.com/embed/v1/form.js" async>');
    expect(text).toContain('https://shopyoursolar.com/contact');
    // The 11 Nov lesson: a second, required texting box beside ours.
    expect(text).toContain('Add another tick box about texts');
    expect(text).toMatch(/WordPress: .*Custom HTML/);
  });

  it('a form of their own: the box’s words with the carriers’ phrases, the links, and the rules', () => {
    const text = fileOf(facts({ form: null }), 'form');
    expect(text).toContain('☐ Text me, Shop Your Solar');
    expect(text).toContain(CARRIER_DISCLOSURE);
    expect(text).toContain(
      'Link “Privacy policy” to https://app.handsfreeos.com/legal/shop-your-solar/privacy',
    );
    expect(text).toContain(
      'Link “Terms” to https://app.handsfreeos.com/legal/shop-your-solar/terms',
    );
    expect(text).toContain('The box starts empty');
    expect(text).toContain('It isn’t required');
    expect(text).not.toContain('Also text me offers');
  });

  it('a business that texts offers gets the second box under the first', () => {
    const text = fileOf(
      facts({
        form: null,
        legal: { ...SOURCES.legal, business: { ...SOURCES.legal.business, offers: true } },
      }),
      'form',
    );
    expect(text).toContain('☐ Also text me offers from Shop Your Solar');
    expect(text).toContain('Offers get their own box');
  });

  it('ours go whole, each in its own file, with where the link goes (the owner, 2026-11-22)', () => {
    const business = { name: 'Shop Your Solar', ...SOURCES.legal.business };
    const privacy = documentOf(facts(), 'privacy-policy.txt');
    expect(privacy).toContain(policyAsText(privacyPolicy(business)));
    expect(privacy).toContain(MOBILE_DATA_CLAUSE);
    expect(privacy).toContain('https://app.handsfreeos.com/legal/shop-your-solar/privacy');
    expect(privacy).toContain('in the footer of every page');
    const terms = documentOf(facts(), 'terms.txt');
    expect(terms).toContain(policyAsText(termsOfService(business)));
    expect(terms).toContain('https://app.handsfreeos.com/legal/shop-your-solar/terms');
    // Each file is one document: the terms aren't in the privacy policy's file.
    expect(privacy).not.toContain('The whole terms');
    expect(terms).not.toContain('The whole privacy policy');
  });

  it('with no page of ours to link, the whole document goes on a page of the site', () => {
    const noPage = facts({ siteSlug: null, legal: { ...OWN_PAGES, termsUrl: null } });
    const terms = documentOf(noPage, 'terms.txt');
    expect(terms).toContain('Add a terms page to the site with all of the words below');
    expect(terms).toContain('The whole terms');
  });

  it('their own, handed back whole: the page to replace, all of its words, and what changed', () => {
    const f = facts({ legal: OWN_PAGES, kept: { privacy: KEPT, terms: null } });
    const privacy = documentOf(f, 'privacy-policy.txt');
    // The page as the registration names it, though it was kept with www. and a slash.
    expect(privacy).toContain(
      'Replace everything on the privacy policy page at https://shopyoursolar.com/privacy',
    );
    expect(privacy).toContain('Our privacy promise\nWe keep your details to ourselves.');
    expect(privacy).toContain(`Text messages\n${MOBILE_DATA_CLAUSE}`);
    expect(privacy).toContain('One of its own lines changed too');
    expect(privacy).toContain('Was: We may share your details with our marketing partners.');
    expect(privacy).toContain('Now: We keep your details to ourselves.');
    expect(privacy).not.toContain('/legal/shop-your-solar/');
    // The terms were never handed back, so their file still gives the part to add.
    const terms = documentOf(f, 'terms.txt');
    expect(terms).toContain('Add this part to the terms at https://shopyoursolar.com/terms');
    expect(terms).not.toContain('The whole terms');
  });

  it('their own, not handed back (or made for another page): the part to add, word for word', () => {
    for (const kept of [
      undefined,
      { privacy: { ...KEPT, sourceUrl: 'https://shopyoursolar.com/old-privacy' }, terms: null },
      { privacy: { ...KEPT, blocks: [] }, terms: null },
    ]) {
      const privacy = documentOf(
        facts({ legal: OWN_PAGES, ...(kept ? { kept } : {}) }),
        'privacy-policy.txt',
      );
      expect(privacy).toContain(
        'Add this part to the privacy policy at https://shopyoursolar.com/privacy',
      );
      expect(privacy).toContain(MOBILE_DATA_CLAUSE);
      expect(privacy).not.toContain('Our privacy promise');
      expect(privacy).not.toContain('/legal/shop-your-solar/');
    }
  });

  it('a kept policy is left out once the business goes back to ours', () => {
    const privacy = documentOf(
      facts({ kept: { privacy: KEPT, terms: null } }),
      'privacy-policy.txt',
    );
    expect(privacy).not.toContain('Our privacy promise');
    expect(privacy).toContain('https://app.handsfreeos.com/legal/shop-your-solar/privacy');
  });

  it('the chat: one line for the footer, and a hidden chat says it stays hidden on purpose', () => {
    const text = fileOf(facts(), 'chat');
    expect(text).toContain(
      '<script async src="https://go.shopyoursolar.com/embed/v1/wk_abc.js"></script>',
    );
    expect(text).toContain('just before </body>');
    expect(text).toContain('press the chat button once');
    const hidden = fileOf(facts({ chat: { publicKey: 'wk_abc', hidden: true } }), 'chat');
    expect(hidden).toContain('stays hidden until texting is approved');
  });

  it('says why a change can’t be written yet, and leaves it out', () => {
    const noChat = facts({ chat: null });
    expect(fixUnavailable('chat', noChat)).toMatch(/Settings → Website chat/);
    expect(websiteFixFiles(noChat, ['chat', 'policy']).map((f) => f.id)).toEqual([
      'policy',
      'policy',
    ]);
    const noPolicy = facts({ siteSlug: null });
    expect(fixUnavailable('policy', noPolicy)).toMatch(/privacy policy isn’t set up yet/);
  });
});

describe('the email the files go with', () => {
  it('lists the files, carries the note, and says where replies go', () => {
    const files = websiteFixFiles(facts(), ['form', 'policy']);
    const mail = webPersonEmail({
      business: 'Shop Your Solar',
      recipientName: 'Dana Smith',
      sender: { name: 'Chris Lee', email: 'chris@example.com' },
      files,
      note: 'By Friday, please.',
    });
    expect(mail.subject).toBe('Website changes for Shop Your Solar’s texting approval');
    expect(mail.text).toMatch(/^Hi Dana,/);
    expect(mail.text).toContain('1. Add the sign-up form: add-the-form.txt');
    expect(mail.text).toContain('the website needs 3 changes');
    expect(mail.text).toContain('2. Update the privacy policy: privacy-policy.txt');
    expect(mail.text).toContain('3. Update the terms: terms.txt');
    expect(mail.text).toContain('A note from Chris Lee:\nBy Friday, please.');
    expect(mail.text).toContain(
      'Your reply goes to Chris Lee (chris@example.com) and to the HandsFreeOS team helping Shop Your Solar with this.',
    );
  });

  it('with nobody to name, it signs as the business and replies go to HandsFreeOS', () => {
    const mail = webPersonEmail({
      business: 'Shop Your Solar',
      sender: null,
      files: websiteFixFiles(facts(), ['policy']),
      note: 'By Friday, please.',
    });
    expect(mail.text).toContain('A note from Shop Your Solar:\nBy Friday, please.');
    expect(mail.text).toContain(
      'Your reply goes to the HandsFreeOS team helping Shop Your Solar with this.',
    );
    expect(mail.text).toMatch(/Thanks,\nShop Your Solar$/);
  });

  it('one file reads as one change', () => {
    const mail = webPersonEmail({
      business: 'Shop Your Solar',
      sender: { name: '', email: 'chris@example.com' },
      files: websiteFixFiles(facts(), ['chat']),
    });
    expect(mail.subject).toBe('Website change for Shop Your Solar’s texting approval');
    expect(mail.text).toMatch(/^Hi,/);
    expect(mail.text).toContain('Add the website chat: add-the-chat.txt');
    expect(mail.text).not.toContain('1. ');
  });
});

describe('which changes are ticked to start with', () => {
  it('the ones the checks found missing', () => {
    const checks = [
      { id: 'website' as const, ok: true },
      { id: 'policy' as const, ok: false },
      { id: 'terms' as const, ok: true },
      { id: 'opt_in_surface' as const, ok: false },
    ];
    expect(fixesMissing(checks, 'own_site')).toEqual(['form', 'policy']);
    expect(fixesMissing(checks, 'hosted')).toEqual(['policy', 'chat']);
    expect(fixesMissing([{ id: 'chat_on_site', ok: false }], 'hosted')).toEqual(['chat']);
    expect(fixesMissing([{ id: 'policy', ok: true }], 'own_site')).toEqual([]);
  });

  it('with no checks, what the way customers agree needs on the site', () => {
    expect(fixesForPath('own_site')).toEqual(['form', 'policy']);
    expect(fixesForPath('hosted')).toEqual(['chat', 'policy']);
    expect(fixesForPath(null)).toEqual(['policy']);
  });
});
