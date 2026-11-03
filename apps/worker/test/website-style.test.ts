import { FormDesign } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import {
  designFromStyle,
  formFontFor,
  googleFontsOf,
  rulesOf,
  websiteStyleOf,
} from '../src/look/style';

/**
 * Match my website (look/style.ts): a website's button colour, words, font and corners, read from its HTML and CSS
 * the way site builders write them, and the form design that follows.
 */

describe('reading a website’s look', () => {
  /** The way GoDaddy's builder writes a page: made-up class names, and its copy of Google Fonts. */
  const godaddy = `<!doctype html><html><head>
    <link rel="stylesheet" href="//img1.wsimg.com/gfonts/css?family=Montserrat:400,700|Lato:400&amp;display=swap">
    <style>
      .x{font-family:'Lato', arial, sans-serif;color:rgb(27, 27, 27);background-color:rgb(255, 255, 255)}
      .c1-a{background-color:rgb(232, 93, 4)}
      .c1-b{color:rgb(255, 255, 255)}
      .c1-c{border-radius:4px}
      .c1-a:hover{background-color:rgb(10, 10, 10)}
      .c1-n{color:rgb(27, 27, 27)}
      @media (min-width: 768px){.c1-d{font-size:16px}}
    </style></head>
    <body class="x">
      <a data-ux="ButtonPrimary" class="x-el c1-a c1-b c1-c" href="/quote">Get a quote</a>
      <a data-ux="ButtonPrimary" class="x-el c1-a c1-b c1-c" href="/call">Call us</a>
      <a data-ux="Link" class="c1-n" href="/about">About</a>
      <p class="c1-n">We install solar panels.</p>
    </body></html>`;

  it('reads a GoDaddy page: its buttons by their made-up classes, its words and its font', () => {
    const style = websiteStyleOf(godaddy, []);
    expect(style).toEqual({
      button: '#e85d04',
      buttonText: '#ffffff',
      background: '#ffffff',
      text: '#1b1b1b',
      font: { name: 'Lato', google: true },
      corners: 'slight',
    });
  });

  it('reads a hand-made site: .btn rules, the site’s own variables, and a pill button', () => {
    const html = `<html><head><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter&display=swap" rel="stylesheet"></head>
      <body><button class="btn btn-primary">Book now</button><a class="btn btn-primary" href="#">Call</a><p>Hi</p></body></html>`;
    const css = `
      :root { --brand: #0b6e4f; --ink: #222222; }
      body { color: var(--ink); background: #fafafa; font-family: "Playfair Display", Georgia, serif; }
      .btn { border-radius: 999px; padding: 8px 16px; }
      .btn-primary { background: var(--brand) url(x.png) no-repeat; color: #fff; }
      .btn-primary:focus { background: red; }
    `;
    expect(websiteStyleOf(html, [css])).toEqual({
      button: '#0b6e4f',
      buttonText: '#ffffff',
      background: '#fafafa',
      text: '#222222',
      font: { name: 'Playfair Display', google: true },
      corners: 'round',
    });
  });

  it('leaves out what it can’t be sure of: see-through and white buttons, unreadable words', () => {
    const html = `<body><button class="ghost">One</button><button class="plain">Two</button></body>`;
    const css = `.ghost{background-color:rgba(0,0,0,0.1)} .plain{background:#ffffff;color:#000}
      body{background:#ffffff;color:#fdfdfd}`;
    const style = websiteStyleOf(html, [css]);
    expect(style.button).toBeNull();
    expect(style.buttonText).toBeNull();
    // Near-white words on white: not the site's real words.
    expect(style.text).toBeNull();
    expect(style.font).toBeNull();
  });

  it('skips print and dark-mode-only rules, and comments', () => {
    const rules = rulesOf(`/* .a{color:red} */ @media print{.b{color:blue}}
      @media (prefers-color-scheme: dark){.c{color:green}} @media (min-width:1px){.d{color:#123456}}
      @font-face{font-family:X;src:url(x.woff2)} .e,.f > .g:hover{color:#000}`);
    expect(rules.map((r) => r.selectors.join(','))).toEqual(['.d', '.e,.f > .g:hover']);
    expect(rules[1]!.targets).toEqual(['.e']);
  });

  it('finds the Google fonts a page loads, from links, @imports and GoDaddy’s copy', () => {
    expect(
      googleFontsOf(
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Open+Sans:400,600|Roboto">',
        '@import url("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400&display=swap");',
      ),
    ).toEqual(['Open Sans', 'Roboto', 'DM Sans']);
  });
});

describe('the design it makes', () => {
  it('copies the buttons, words, font and corners, and leaves the background see-through', () => {
    const at = new Date('2026-11-02T21:30:00Z');
    const { patch, fontNote, found } = designFromStyle(
      {
        button: '#e85d04',
        buttonText: '#ffffff',
        background: '#ffffff',
        text: '#1b1b1b',
        font: { name: 'Lato', google: true },
        corners: 'slight',
      },
      'https://shopyoursolar.com/',
      at,
    );
    expect(found).toBe(4);
    expect(fontNote).toBeNull();
    const design = FormDesign.parse(patch);
    expect(design).toMatchObject({
      scheme: 'light',
      colors: { button: '#e85d04', buttonText: '#ffffff', background: null, text: '#1b1b1b' },
      font: 'Lato',
      corners: 'slight',
      matched: { site: 'https://shopyoursolar.com/', at: at.toISOString() },
    });
  });

  it('goes dark for a dark site, and stands a free font in for a paid one', () => {
    const { patch, fontNote } = designFromStyle(
      {
        button: '#ffcc00',
        buttonText: null,
        background: '#101010',
        text: '#eeeeee',
        font: { name: 'Proxima Nova', google: false },
        corners: null,
      },
      'https://example.com/',
      new Date(),
    );
    expect(patch.scheme).toBe('dark');
    expect(patch.font).toBe('Inter');
    expect(patch).not.toHaveProperty('corners');
    expect(fontNote).toBe(
      'Proxima Nova isn’t a free font, so the form uses Inter, the closest one.',
    );
    expect(formFontFor({ name: 'Adobe Garamond', google: false })).toEqual({
      name: 'Lora',
      stoodIn: true,
    });
  });
});
