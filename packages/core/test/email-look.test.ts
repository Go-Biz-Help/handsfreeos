/**
 * How a business's emails look (design tools, part 5; core's look/email.ts and campaigns/email-blocks.ts): a plain
 * email stays plain; an automatic one gets real buttons and its small print; a layout adds the colour band, the logo
 * on the left or in the centre and the footer; a campaign in blocks draws its pictures, buttons, lines and spaces where
 * they were put; and the blocks' plain words are what a mail app that shows text only shows.
 */
import { describe, expect, it } from 'vitest';
import {
  EmailBlocks,
  emailBlocksFromText,
  emailBlocksOf,
  emailBlocksText,
  emailButtonOf,
  emailHtml,
  fillEmailBlocks,
  socialKindOf,
  socialUrlOf,
  type EmailBlock,
  type EmailBrand,
} from '../src/index';

const WS = '11111111-2222-4333-8444-555555555555';
const PIC = `${WS}/99999999-8888-4777-8666-555555555555.webp`;

const brand = (over: Partial<EmailBrand> = {}): EmailBrand => ({
  name: 'Lone Star HVAC',
  look: {
    logo: { url: 'https://s.example/logo.png', width: 800, height: 200 },
    color: '#c2410c',
    corners: 'round',
  },
  ...over,
});

const booking = [
  'Hi Sam,',
  'You’re booked for Tuesday at 10:00 AM.',
  'Change or cancel: https://app.example/b/1\nAdd it to your calendar: https://app.example/b/1/ics',
].join('\n\n');

describe('a plain email', () => {
  it('stays paragraphs and links: no buttons, and "--" is just words', () => {
    const html = emailHtml(`${booking}\n\n--\nUnsubscribe: https://x.example/u`);
    expect(html).not.toContain('<table');
    expect(html).toContain(
      '<a href="https://app.example/b/1" style="color:#2f5bd3">https://app.example/b/1</a>',
    );
    expect(html).toContain('--<br>Unsubscribe:');
  });
});

describe('an automatic email', () => {
  it('draws a line that is only words and an address as a button, the first filled and the rest outlined', () => {
    const html = emailHtml(booking, brand());
    expect(html).toMatch(
      /bgcolor="#c2410c"><a href="https:\/\/app\.example\/b\/1" [^>]*color:#ffffff[^>]*>Change or cancel<\/a>/,
    );
    expect(html).toMatch(/border:2px solid #c2410c"><a href="https:\/\/app\.example\/b\/1\/ics"/);
    expect(html).toContain('border-radius:22px');
    expect(html).not.toContain('Change or cancel:');
    // As before: the logo on the left at the top, no card.
    expect(html).toContain('<div style="margin:0 0 20px"><img src="https://s.example/logo.png"');
  });

  it('keeps a line with more than an address, or too many words, as words', () => {
    expect(emailButtonOf('Pay here: https://a.example/p')).toEqual({
      label: 'Pay here',
      url: 'https://a.example/p',
    });
    expect(emailButtonOf('Pay here: https://a.example/p today')).toBeNull();
    expect(emailButtonOf('https://a.example/p')).toBeNull();
    expect(emailButtonOf(`${'a'.repeat(41)}: https://a.example/p`)).toBeNull();
    expect(emailButtonOf(': https://a.example/p')).toBeNull();
  });

  it('puts what follows "--" in small grey print, its links as links', () => {
    const html = emailHtml(`${booking}\n\n--\nUnsubscribe: https://x.example/u`, brand());
    expect(html).toContain('font-size:12px');
    expect(html).toMatch(/Unsubscribe: <a href="https:\/\/x\.example\/u"/);
    expect(html.match(/<table/g)?.length).toBe(4);
  });

  it('escapes what it was given', () => {
    const html = emailHtml('Hi <b>Sam</b> & co\n\nGo "now": https://a.example/?a=1&b=2', {
      ...brand(),
      name: 'Bee & "Co"',
    });
    expect(html).toContain('Hi &lt;b&gt;Sam&lt;/b&gt; &amp; co');
    expect(html).toContain('href="https://a.example/?a=1&amp;b=2"');
    expect(html).toContain('>Go &quot;now&quot;</a>');
    expect(html).toContain('alt="Bee &amp; &quot;Co&quot;"');
  });
});

describe('the layout', () => {
  const contact = {
    address: ['12 Main St', 'Austin, TX 78701'],
    phone: '(512) 555-0134',
    website: 'https://www.lonestarhvac.com/',
    socials: [
      { kind: 'facebook' as const, url: 'https://facebook.com/lonestar' },
      { kind: 'instagram' as const, url: 'https://instagram.com/lonestar' },
    ],
  };

  it('draws a card with the band, the logo in the centre and the footer', () => {
    const html = emailHtml(
      `${booking}\n\n--\nWhy you get this.\nUnsubscribe: https://x.example/u\n\nLone Star HVAC\n12 Main St\nAustin, TX 78701`,
      brand({ layout: { band: true, logo: 'center', footer: true }, contact }),
    );
    expect(html).toContain('max-width:600px');
    expect(html).toContain('bgcolor="#c2410c">&nbsp;</td>');
    expect(html).toMatch(/<td align="center" style="padding:24px 28px 0"><img /);
    expect(html).toContain('12 Main St, Austin, TX 78701');
    expect(html).toContain('(512) 555-0134');
    expect(html).toContain('>lonestarhvac.com</a>');
    expect(html).toContain('>Facebook</a>');
    expect(html).toContain('>Instagram</a>');
    expect(html).toContain('border-radius:16px');
    // The small print isn't said twice: its name and address lines are left to the footer.
    expect(html.match(/12 Main St/g)?.length).toBe(1);
    expect(html).toContain('Why you get this.');
  });

  it('leaves out the band and the footer when they are off, and writes the name where there is no logo', () => {
    const html = emailHtml(
      booking,
      brand({
        look: { logo: null, color: null, corners: null },
        layout: { band: false, logo: 'left', footer: false },
        contact,
      }),
    );
    expect(html).not.toContain('&nbsp;</td>');
    expect(html).not.toContain('(512) 555-0134');
    expect(html).toMatch(
      /<td align="left" style="padding:24px 28px 0"><div [^>]*>Lone Star HVAC<\/div>/,
    );
    // No colour: HandsFreeOS's own blue, slight corners.
    expect(html).toContain('bgcolor="#2f5bd3"');
    expect(html).toContain('border-radius:8px');
  });
});

const blocks: EmailBlock[] = [
  { id: 'b1', kind: 'words', text: 'Hi {first_name},\n\nFall tune-ups are here.', align: 'center' },
  {
    id: 'b2',
    kind: 'picture',
    picture: { path: PIC, width: 1200, height: 800 },
    size: 'medium',
    align: 'right',
    words: 'Our van',
    link: 'https://lonestarhvac.com/fall',
  },
  {
    id: 'b3',
    kind: 'button',
    label: 'Book now',
    url: 'https://lonestarhvac.com/book',
    align: 'center',
  },
  { id: 'b4', kind: 'line' },
  { id: 'b5', kind: 'space', size: 'large' },
];

describe('a campaign in blocks', () => {
  it('draws each block where it was put', () => {
    const html = emailHtml(
      `${emailBlocksText(blocks)}\n\n--\nUnsubscribe: https://x.example/u`,
      brand({ layout: { band: false, logo: 'left', footer: false } }),
      { blocks, pictureUrl: (p) => `https://s.example/pictures/${p}` },
    );
    expect(html).toContain('<p style="margin:0 0 12px;text-align:center">Hi {first_name},</p>');
    // Medium is half the words' width (544 pixels), its shape kept.
    expect(html).toMatch(
      /<div style="margin:0 0 16px;text-align:right"><a href="https:\/\/lonestarhvac\.com\/fall"[^>]*><img src="https:\/\/s\.example\/pictures\/[^"]+" alt="Our van" width="272" height="181"/,
    );
    expect(html).toContain('>Our van</div>');
    expect(html).toMatch(/<td align="center"><table [^>]*align="center"[^>]*>.*>Book now<\/a>/);
    expect(html).toContain('<hr style=');
    expect(html).toContain('height:40px');
    expect(html).toMatch(/Unsubscribe: <a href="https:\/\/x\.example\/u"/);
  });

  it('never draws a picture wider than it is', () => {
    const small: EmailBlock[] = [
      {
        ...(blocks[1] as Extract<EmailBlock, { kind: 'picture' }>),
        size: 'full',
        picture: { path: PIC, width: 300, height: 100 },
      },
    ];
    const html = emailHtml('x', brand(), { blocks: small, pictureUrl: (p) => p });
    expect(html).toContain('width="300" height="100"');
  });

  it('gives plain words a mail app shows, with a button as its words and address', () => {
    expect(emailBlocksText(blocks)).toBe(
      'Hi {first_name},\n\nFall tune-ups are here.\n\nOur van\nhttps://lonestarhvac.com/fall\n\nBook now: https://lonestarhvac.com/book\n\n———',
    );
  });

  it('fills the first name into the words, the button and the line under a picture', () => {
    const filled = fillEmailBlocks(
      [
        ...blocks,
        {
          id: 'b6',
          kind: 'button',
          label: 'Yes {first_name}',
          url: 'https://a.example',
          align: 'left',
        },
      ],
      (t) => t.replaceAll('{first_name}', 'Sam'),
    );
    expect(filled[0]).toMatchObject({ text: 'Hi Sam,\n\nFall tune-ups are here.' });
    expect(filled[5]).toMatchObject({ label: 'Yes Sam' });
  });

  it('makes plain words into blocks, a line that is a button becoming one', () => {
    expect(emailBlocksFromText(booking)).toEqual([
      {
        id: 'b1',
        kind: 'words',
        text: 'Hi Sam,\n\nYou’re booked for Tuesday at 10:00 AM.',
        align: 'left',
      },
      {
        id: 'b2',
        kind: 'button',
        label: 'Change or cancel',
        url: 'https://app.example/b/1',
        align: 'left',
      },
      {
        id: 'b3',
        kind: 'button',
        label: 'Add it to your calendar',
        url: 'https://app.example/b/1/ics',
        align: 'left',
      },
    ]);
  });

  it('refuses an email of only pictures, an unsafe address, and reads kept blocks forgivingly', () => {
    expect(EmailBlocks.safeParse([blocks[1]]).success).toBe(false);
    expect(
      EmailBlocks.safeParse([{ id: 'b1', kind: 'button', label: 'Go', url: 'javascript:alert(1)' }])
        .success,
    ).toBe(false);
    expect(EmailBlocks.safeParse(blocks).success).toBe(true);
    expect(emailBlocksOf([blocks[0], { kind: 'nope' }, 'x'])).toEqual([blocks[0]]);
    expect(emailBlocksOf('x')).toBeNull();
    expect(emailBlocksOf([])).toBeNull();
  });
});

describe('social links', () => {
  it('are kept as https web addresses, named for their site', () => {
    expect(socialUrlOf('facebook.com/acme')).toBe('https://facebook.com/acme');
    expect(socialUrlOf('http://www.instagram.com/acme/')).toBe('https://www.instagram.com/acme/');
    expect(socialUrlOf('not a link')).toBeNull();
    expect(socialUrlOf('javascript:alert(1)')).toBeNull();
    expect(socialUrlOf('https://user:pw@facebook.com/x')).toBeNull();
    expect(socialUrlOf('localhost/x')).toBeNull();
    expect(socialKindOf('https://m.facebook.com/acme')).toBe('facebook');
    expect(socialKindOf('https://twitter.com/acme')).toBe('x');
    expect(socialKindOf('https://www.yelp.ca/biz/acme')).toBe('yelp');
    expect(socialKindOf('https://acme.com')).toBe('other');
    expect(socialKindOf('https://notfacebook.com/acme')).toBe('other');
  });
});
