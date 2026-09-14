import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeFetch, isBlockedAddress } from '../src/http/safe-fetch';

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const redirect = (status: number, location: string) => {
      res.writeHead(status, { location });
      res.end();
    };
    switch (req.url) {
      case '/hello':
        return res.end('hi');
      case '/big':
        return res.end('x'.repeat(5000));
      case '/slow':
        return void setTimeout(() => res.end('late'), 3000);
      case '/to-hello':
        return redirect(301, '/hello');
      case '/to-metadata':
        return redirect(302, 'https://169.254.169.254/latest/meta-data');
      case '/to-plain-http':
        return redirect(302, 'http://example.com/');
      case '/to-other-site':
        return redirect(302, 'https://example.org/');
      case '/loop':
        return redirect(302, '/loop');
      case '/echo': {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => res.end(`${req.method} ${req.headers['content-type']} ${body}`));
        return;
      }
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const refused = (code: string) => ({ name: 'SafeFetchError', code });

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    'fd00::1',
    'fe80::1%lo0',
    '64:ff9b::a00:1',
    'not-an-address',
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('allows %s', (a) =>
    expect(isBlockedAddress(a)).toBe(false),
  );
});

describe('safe fetch', () => {
  const fetchUrl = createSafeFetch();

  it('refuses plain http, passwords, one-word names and nonsense', async () => {
    await expect(fetchUrl('http://example.com/')).rejects.toMatchObject(refused('not_https'));
    await expect(fetchUrl('https://me:pw@example.com/')).rejects.toMatchObject(
      refused('invalid_url'),
    );
    await expect(fetchUrl('https://localhost/')).rejects.toMatchObject(refused('invalid_url'));
    await expect(fetchUrl('not a url')).rejects.toMatchObject(refused('invalid_url'));
  });

  it('refuses private addresses written as numbers, in every spelling', async () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://10.0.0.8/',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://0x7f000001/',
      'https://2130706433/',
      'https://127.1/',
    ])
      await expect(fetchUrl(url), url).rejects.toMatchObject(refused('blocked_address'));
  });

  it('refuses a name that resolves to a private address, even alongside a public one', async () => {
    const fetchVia = (addresses: { address: string; family: number }[]) =>
      createSafeFetch({ resolve: async () => addresses });
    await expect(
      fetchVia([{ address: '10.0.0.5', family: 4 }])('https://intranet.example/'),
    ).rejects.toMatchObject(refused('blocked_address'));
    await expect(
      fetchVia([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])('https://rebind.example/'),
    ).rejects.toMatchObject(refused('blocked_address'));
  });

  describe('against a fixture site', () => {
    const fixture = () => createSafeFetch({ testOrigins: [origin] });

    it('fetches, and follows a redirect on the same site', async () => {
      const res = await fixture()(`${origin}/to-hello`);
      expect(res).toMatchObject({ status: 200, body: 'hi', truncated: false });
      expect(res.finalUrl).toBe(`${origin}/hello`);
    });

    it('checks every redirect again', async () => {
      await expect(fixture()(`${origin}/to-metadata`)).rejects.toMatchObject(
        refused('blocked_address'),
      );
      await expect(fixture()(`${origin}/to-plain-http`)).rejects.toMatchObject(
        refused('not_https'),
      );
      await expect(fixture()(`${origin}/to-other-site`, { sameHost: true })).rejects.toMatchObject(
        refused('other_host'),
      );
      await expect(fixture()(`${origin}/loop`, { maxRedirects: 3 })).rejects.toMatchObject(
        refused('too_many_redirects'),
      );
    });

    it('keeps only the first maxBytes', async () => {
      const res = await fixture()(`${origin}/big`, { maxBytes: 100 });
      expect(res.body).toHaveLength(100);
      expect(res.truncated).toBe(true);
    });

    it('gives up after the timeout', async () => {
      await expect(fixture()(`${origin}/slow`, { timeoutMs: 200 })).rejects.toMatchObject(
        refused('timeout'),
      );
    });

    it('posts a body, and hands back a redirect instead of following it', async () => {
      const post = await fixture()(`${origin}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"a":1}',
      });
      expect(post.body).toBe('POST application/json {"a":1}');
      const moved = await fixture()(`${origin}/to-hello`, { method: 'POST', body: '' });
      expect(moved.status).toBe(301);
    });
  });
});
