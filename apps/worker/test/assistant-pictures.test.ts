/**
 * Pictures and links for the Assistant (the owner, 2026-11-24: build Sherri's order form from a screenshot, or from a
 * link to a page with the form on it), without a database: what the model is shown, how a picture is made ready for
 * it, how the price list reads to the form builder, and how a linked page's forms are read.
 */
import type { AiFormPriceList } from '@hfos/core/server';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { priceListForModel } from '../src/forms/builder';
import { linkAddress, readPageForms } from '../src/forms/page-forms';
import { picturesForModel } from '../src/assistant/routes';
import { modelMessages } from '../src/assistant/runtime';
import type { SafeFetch } from '../src/http/safe-fetch';

const PICTURE = { mediaType: 'image/jpeg' as const, data: 'AAAA' };

describe('what the Assistant’s model is shown', () => {
  it('shows the newest question’s pictures before its words, and only mentions older ones', () => {
    const messages = modelMessages(
      [
        { role: 'user', text: 'Make this form', pictures: 2, actions: [] },
        { role: 'assistant', text: 'Done.', pictures: 0, actions: [] },
        { role: 'user', text: '', pictures: 1, actions: [] },
      ],
      [PICTURE],
    );
    expect(messages[0]).toEqual({
      role: 'user',
      content: expect.stringMatching(
        /^Make this form\n\(2 pictures came with this\. They aren’t kept/,
      ),
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'image', ...PICTURE },
        { type: 'text', text: '(They sent only this, with no words.)' },
      ],
    });
  });

  it('sends plain words when no picture came', () => {
    expect(modelMessages([{ role: 'user', text: 'Hi', pictures: 0, actions: [] }])).toEqual([
      { role: 'user', content: 'Hi' },
    ]);
  });
});

describe('a picture sent with a question', () => {
  it('is turned into a JPEG no bigger than the model reads', async () => {
    const png = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const [out] = await picturesForModel([{ data: png.toString('base64') }]);
    expect(out!.mediaType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(out!.data, 'base64')).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1568 });
  });

  it('refuses one that can’t be opened, saying which', async () => {
    const good = (
      await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
        .jpeg()
        .toBuffer()
    ).toString('base64');
    await expect(
      picturesForModel([{ data: good }, { data: 'bm90IGEgcGljdHVyZQ==' }]),
    ).rejects.toMatchObject({
      rule: 'picture_unreadable',
      message: expect.stringContaining('Picture 2'),
    });
  });
});

const PRICE_LIST: AiFormPriceList = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'T-shirt',
    priceCents: 1200,
    options: [
      {
        id: 'o_size0001',
        name: 'Size',
        choices: [
          { id: 'v_youths01', label: 'Youth S', priceCents: 0 },
          { id: 'v_adult2xl', label: 'Adult 2XL', priceCents: 200 },
        ],
      },
    ],
  },
];

describe('the price list, for the form builder', () => {
  it('names each product and each choice with its full price', () => {
    const text = priceListForModel(PRICE_LIST);
    expect(text).toContain('T-shirt=00000000-0000-4000-8000-000000000001 $12');
    expect(text).toContain('Youth S=v_youths01 $12, Adult 2XL=v_adult2xl $14');
    expect(priceListForModel([])).toBe('This business has nothing on its price list yet.');
  });
});

describe('the forms on a linked page', () => {
  const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
    (async (url: string) => ({
      status,
      headers,
      body,
      bytes: Buffer.from(body),
      finalUrl: url,
      truncated: false,
    })) as unknown as SafeFetch;

  it('makes a typed address whole, and refuses what isn’t one', () => {
    expect(linkAddress('sherris.test/order#top')).toBe('https://sherris.test/order');
    expect(linkAddress('http://sherris.test')).toBe('http://sherris.test/');
    expect(linkAddress('not a link')).toBeNull();
    expect(linkAddress('localhost')).toBeNull();
    expect(linkAddress('ftp://sherris.test')).toBeNull();
  });

  it('reads the page’s forms, and the forms framed on it after them', async () => {
    const outer = `<h2>Contact</h2><form><label>Name</label><input name="n"><label>Phone</label><input type="tel" name="p"></form>
      <iframe src="https://forms.example.test/order"></iframe>`;
    const framed = `<form><label>Size</label><select name="s"><option>S</option><option>M</option></select></form>`;
    const fetchUrl = (async (url: string) =>
      page(url.includes('forms.example') ? framed : outer)(url)) as SafeFetch;
    const read = await readPageForms(fetchUrl, 'https://sherris.test/contact');
    expect(read.forms.map((f) => [f.number, f.url])).toEqual([
      [1, 'https://sherris.test/contact'],
      [2, 'https://forms.example.test/order'],
    ]);
    expect(read.forms[1]!.outline).toContain('[dropdown, name "s": S | M]');
  });

  it('says what to send instead when a page has no form it can read', async () => {
    await expect(
      readPageForms(
        page('<div id="root"></div><script src="/app.js"></script>'),
        'https://typeform.test',
      ),
    ).rejects.toMatchObject({
      rule: 'link_unreadable',
      message: expect.stringContaining('screenshot'),
    });
    await expect(readPageForms(page('Gone', 404), 'https://sherris.test/x')).rejects.toMatchObject({
      message: expect.stringContaining('isn’t there'),
    });
    await expect(
      readPageForms(
        page('<p>Checking</p>', 403, { 'cf-mitigated': 'challenge' }),
        'https://sherris.test',
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('robot check from Cloudflare') });
  });
});
