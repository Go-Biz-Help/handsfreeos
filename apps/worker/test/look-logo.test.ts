import { gzipSync } from 'node:zlib';
import { hslOf, isColorful, LOOK_PROBLEMS } from '@hfos/core/server';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { LOGO_LIMITS, LogoError, makeLogo, svgIsSafe, tooLight } from '../src/look/logo';
import { dataPicture, logoCandidates, structuredLogos, themeColorOf } from '../src/look/website';
import { renderEmailHtml } from '../src/email/render';
import { emailLogoSize, publicLookOf } from '../src/look/public';

/**
 * Making a business's logo from a picture (look/logo.ts) and finding it on a website's start page
 * (look/website.ts): the PNG everyone sees, the colour it stands for, the pictures refused and why, and which
 * pictures on a page are its logo.
 */

const clear = { r: 0, g: 0, b: 0, alpha: 0 };

/** A coloured block on a background, as a logo's picture. */
const block = (o: {
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly margin?: number;
  readonly background?: typeof clear | string;
}) => {
  const margin = o.margin ?? 0;
  return sharp({
    create: {
      width: o.width + margin * 2,
      height: o.height + margin * 2,
      channels: 4,
      background: o.background ?? clear,
    },
  }).composite([
    {
      input: {
        create: { width: o.width, height: o.height, channels: 4, background: o.color },
      },
      left: margin,
      top: margin,
    },
  ]);
};

const problemOf = async (data: Buffer) => {
  try {
    await makeLogo(data);
  } catch (e) {
    expect(e).toBeInstanceOf(LogoError);
    expect((e as LogoError).message).toBe(LOOK_PROBLEMS[(e as LogoError).problem]);
    return (e as LogoError).problem;
  }
  throw new Error('expected the picture to be refused');
};

describe('making a logo', () => {
  it('trims the plain margins off, keeps its size, and finds its colour', async () => {
    const png = await block({ width: 400, height: 120, color: '#b42318', margin: 90 })
      .png()
      .toBuffer();
    const logo = await makeLogo(png);
    expect({ width: logo.width, height: logo.height }).toEqual({ width: 400, height: 120 });
    expect(logo.color).toBe('#b42318');
    const meta = await sharp(logo.png).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({
      format: 'png',
      width: 400,
      height: 120,
    });
  });

  it('fits a big picture inside 800 × 400, and trims a white background as well as a clear one', async () => {
    const jpeg = await block({
      width: 2000,
      height: 1000,
      color: '#0f766e',
      margin: 200,
      background: '#ffffff',
    })
      .jpeg({ quality: 92 })
      .toBuffer();
    const logo = await makeLogo(jpeg);
    expect(logo.width).toBeLessThanOrEqual(LOGO_LIMITS.maxWidth);
    expect(logo.height).toBeLessThanOrEqual(LOGO_LIMITS.maxHeight);
    expect(Math.abs(logo.width / logo.height - 2)).toBeLessThan(0.05);
    expect(isColorful(logo.color!)).toBe(true);
    expect(Math.abs(hslOf(logo.color!).h - hslOf('#0f766e').h)).toBeLessThan(10);
  });

  it('draws an SVG big enough to look sharp, whatever size it says it is', async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50" height="20" viewBox="0 0 100 40">' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#2d69d8"/><stop offset="1" stop-color="#2d69d8"/></linearGradient></defs>' +
        '<rect id="r" x="10" y="5" width="80" height="30" fill="url(#g)"/><use xlink:href="#r"/></svg>',
    );
    const logo = await makeLogo(svg);
    expect(logo.width).toBeGreaterThanOrEqual(600);
    expect(logo.color).toBe('#2d69d8');
  });

  it('takes a GIF’s first frame and a WebP', async () => {
    const gif = await block({ width: 300, height: 100, color: '#7c3aed' }).gif().toBuffer();
    expect((await makeLogo(gif)).width).toBe(300);
    const webp = await block({ width: 300, height: 100, color: '#7c3aed' })
      .webp({ lossless: true })
      .toBuffer();
    expect((await makeLogo(webp)).color).toBe('#7c3aed');
  });

  it('says why a picture can’t be a logo', async () => {
    expect(
      await problemOf(await block({ width: 40, height: 40, color: '#b42318' }).png().toBuffer()),
    ).toBe('tooSmall');
    expect(await problemOf(Buffer.from('not a picture at all'))).toBe('unreadable');
    expect(
      await problemOf(await block({ width: 300, height: 100, color: '#b42318' }).tiff().toBuffer()),
    ).toBe('unreadable');
    expect(
      await problemOf(
        await sharp({ create: { width: 200, height: 200, channels: 4, background: clear } })
          .png()
          .toBuffer(),
      ),
    ).toBe('unreadable');
    expect(await problemOf(Buffer.alloc(5 * 1024 * 1024 + 1))).toBe('tooBig');
    expect(
      await problemOf(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
        ),
      ),
    ).toBe('unsafeSvg');
    expect(
      await problemOf(gzipSync(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))),
    ).toBe('unsafeSvg');
    expect(await problemOf(Buffer.from('<html><body>Not a logo</body></html>'))).toBe('unreadable');
  });

  it('refuses a white logo, made for a dark header, that wouldn’t show on a white page', async () => {
    expect(
      await problemOf(await block({ width: 300, height: 100, color: '#ffffff' }).png().toBuffer()),
    ).toBe('tooLight');
    expect(
      await problemOf(
        await sharp({ create: { width: 300, height: 100, channels: 3, background: '#fdfdfd' } })
          .png()
          .toBuffer(),
      ),
    ).toBe('tooLight');
    // Dark words on white show, however much white there is between them; on a see-through background, a mostly
    // white logo doesn't.
    const pixels = (white: number, dark: number, see: number) =>
      Uint8Array.from([
        ...Array.from({ length: white }, () => [255, 255, 255, 255]).flat(),
        ...Array.from({ length: dark }, () => [25, 29, 37, 255]).flat(),
        ...Array.from({ length: see }, () => [0, 0, 0, 0]).flat(),
      ]);
    expect(tooLight(pixels(95, 5, 0))).toBe(false);
    expect(tooLight(pixels(95, 5, 40))).toBe(true);
    expect(tooLight(pixels(60, 40, 40))).toBe(false);
  });
});

describe('a safe SVG', () => {
  const svg = (inner: string, head = '') =>
    `${head}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`;

  it('is a plain picture that points only at its own parts and carries its own pictures', () => {
    expect(svgIsSafe(svg('<rect width="10" height="10" fill="#2d69d8"/>'))).toBe(true);
    expect(svgIsSafe(svg('<rect id="a"/><use href="#a"/><rect fill="url( \'#g\' )"/>'))).toBe(true);
    expect(svgIsSafe(svg('<image href="data:image/png;base64,iVBORw0KGgo="/>'))).toBe(true);
    expect(
      svgIsSafe(
        svg(
          '<rect/>',
          '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n]>',
        ),
      ),
    ).toBe(true);
  });

  it('never runs anything, fetches anything or expands into more of itself', () => {
    for (const unsafe of [
      svg('<script>alert(1)</script>'),
      svg('<rect onload="alert(1)"/>'),
      svg('<foreignObject><div>hi</div></foreignObject>'),
      svg('<image href="https://tracker.example/pixel.png"/>'),
      svg('<image xlink:href="file:///etc/passwd"/>'),
      svg('<use href="other.svg#a"/>'),
      svg('<rect fill="url(https://evil.example/x.svg#p)"/>'),
      svg('<style>@import url(#a);</style>'),
      svg('<a href="javascript:alert(1)"><rect/></a>'),
      svg('<rect/>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>'),
      svg('<rect/>', '<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>'),
    ])
      expect(svgIsSafe(unsafe), unsafe).toBe(false);
  });
});

describe('the logo on a website', () => {
  const PAGE = 'https://www.lonestarhvac.com/';

  it('tries its structured data, its header, its icons, then its footer, never other companies’ logos', () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon.ico">
      <link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
      <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"HVACBusiness","logo":{"@type":"ImageObject","url":"https://cdn.example/lonestar.svg"}}]}</script>
      </head><body>
      <header><a href="https://lonestarhvac.com/"><img src="/img/home-mark.png" alt="Lone Star HVAC"></a>
      <img src="/img/google-reviews-logo.png" alt="Google reviews">
      <div class="site-logo"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/lazy-logo.webp" alt=""></div>
      </header>
      <main><img src="/img/van.jpg" alt="Our van"><img class="footer-logo" src="/img/bbb-logo.png" alt="BBB"></main>
      <footer><img src="/img/logo-white.png" alt="Lone Star logo"></footer>
      </body></html>`;
    expect(logoCandidates(html, PAGE)).toEqual([
      'https://cdn.example/lonestar.svg',
      'https://www.lonestarhvac.com/img/home-mark.png',
      'https://www.lonestarhvac.com/img/lazy-logo.webp',
      'https://www.lonestarhvac.com/apple-touch-icon.png',
      'https://www.lonestarhvac.com/icon-192.png',
      'https://www.lonestarhvac.com/img/logo-white.png',
    ]);
  });

  it('reads srcsets, <base> and data: pictures', () => {
    const html = `<base href="https://assets.example/site/">
      <img class="logo" srcset="logo-1x.png 1x, logo-2x.png 2x">
      <img alt="Logo" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E">`;
    const found = logoCandidates(html, PAGE);
    expect(found[0]).toBe('https://assets.example/site/logo-2x.png');
    expect(dataPicture(found[1]!)?.toString()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(dataPicture('data:image/png;base64,iVBORw0KGgo=')).toEqual(
      Buffer.from('iVBORw0KGgo=', 'base64'),
    );
    expect(dataPicture('data:text/html,<b>hi</b>')).toBeNull();
  });

  it('reads structured data forgivingly', () => {
    expect(
      structuredLogos(
        '<script type="application/ld+json">{"logo": "https://x.example/a.png"}</script><script type="application/ld+json">{not json</script>',
      ),
    ).toEqual(['https://x.example/a.png']);
    expect(structuredLogos('<p>No structured data</p>')).toEqual([]);
  });

  it('takes the website’s own colour from its theme colour, when it has colour in it', () => {
    expect(themeColorOf('<meta name="theme-color" content="#0F766E">')).toBe('#0f766e');
    expect(themeColorOf('<meta name="theme-color" content="#f60">')).toBe('#ff6600');
    expect(themeColorOf('<meta name="theme-color" content="rgb(45, 105, 216)">')).toBe('#2d69d8');
    expect(themeColorOf('<meta name="theme-color" content="#ffffff">')).toBeNull();
    expect(
      themeColorOf(
        '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#7c3aed"><meta name="theme-color" content="#b42318">',
      ),
    ).toBe('#b42318');
    expect(themeColorOf('<p>no colour</p>')).toBeNull();
  });
});

describe('the logo customers see', () => {
  const WS = '00000000-0000-4000-8000-000000000001';
  const ID = '00000000-0000-4000-8000-000000000002';
  const settings = {
    look: {
      logo: {
        path: `${WS}/logo/${ID}.png`,
        width: 800,
        height: 200,
        from: 'upload',
        at: '2026-10-07T12:00:00.000Z',
      },
      color: { hex: '#f5c518', from: 'logo', at: '2026-10-07T12:00:00.000Z' },
    },
  };

  it('is at Storage’s public address, with the business’s colour', () => {
    expect(publicLookOf(settings, 'https://abc.supabase.co/')).toEqual({
      logo: {
        url: `https://abc.supabase.co/storage/v1/object/public/brand/${WS}/logo/${ID}.png`,
        width: 800,
        height: 200,
      },
      color: '#f5c518',
    });
    expect(publicLookOf(settings, null)).toEqual({ logo: null, color: '#f5c518' });
    expect(publicLookOf({}, 'https://abc.supabase.co')).toEqual({ logo: null, color: null });
  });

  it('heads an automatic email, 48 pixels high, its links in the colour made readable on white', () => {
    expect(emailLogoSize({ width: 800, height: 200 })).toEqual({ width: 192, height: 48 });
    expect(emailLogoSize({ width: 800, height: 100 })).toEqual({ width: 240, height: 30 });
    expect(emailLogoSize({ width: 30, height: 20 })).toEqual({ width: 30, height: 20 });
    const look = publicLookOf(settings, 'https://abc.supabase.co');
    const html = renderEmailHtml('Your invoice: https://app.example/i/1', {
      name: 'Bee & Co "Plumbing"',
      look,
    });
    expect(html).toContain(
      `<img src="https://abc.supabase.co/storage/v1/object/public/brand/${WS}/logo/${ID}.png" alt="Bee &amp; Co &quot;Plumbing&quot;" width="192" height="48"`,
    );
    const link = /<a href="https:\/\/app\.example\/i\/1" style="color:(#[0-9a-f]{6})">/.exec(
      html,
    )?.[1];
    expect(link).toBeDefined();
    expect(link).not.toBe('#f5c518');
    // A person's own email stays plain.
    const plain = renderEmailHtml('See https://app.example/i/1');
    expect(plain).not.toContain('<img');
    expect(plain).toContain('style="color:#2f5bd3"');
  });
});
