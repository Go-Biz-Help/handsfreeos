/**
 * M17: the host's side of a business's own domain, with no database anywhere near it.
 *
 * What can be wrong about branded domains without a business ever being involved: what the fake host does
 * with each name, what the four magic names mean, and — the one that actually matters — that a domain is
 * only ever called working when its certificate is issued as well as its DNS found. It exists so the
 * database-backed suite, which cannot run everywhere, is not the only thing standing between a change here
 * and a business's booking page showing a browser warning.
 *
 * The magic names are the convention `buyNumber` and the fake carrier already use:
 *
 *   contains `taken`    already claimed somewhere else — refused, and never retried
 *   contains `slow`     the records are right, the certificate never issues
 *   contains `missing`  the records are never found
 *   contains `squat`    pointed here, but the business never publishes its claim token
 *   anything else       claimed, then working on the next look
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeHost } from '../src/hosting/fake';
import { HostError, isPermanentHostError, txtValues } from '../src/hosting/host';
import { forgetPublicOrigin, linksOn, publicOrigin } from '../src/hosting/origin';
import type { Tx } from '@hfos/db/client';

describe('the fake host', () => {
  it('claims a name and asks for two records, neither of them working yet', async () => {
    const host = createFakeHost();
    const added = await host.add('booking.lonestarhvac.com');
    expect(host.added).toEqual(['booking.lonestarhvac.com']);
    expect(added.status).toBe('verifying');
    expect(added.certificateReady).toBe(false);
    expect(added.verification?.host).toBe('_handsfreeos.booking.lonestarhvac.com');
    expect(added.cname?.host).toBe('booking.lonestarhvac.com');
    expect(added.error).toBeNull();
  });

  it('works on the next look, once', async () => {
    const host = createFakeHost();
    await host.add('booking.lonestarhvac.com');
    const state = await host.check('booking.lonestarhvac.com');
    expect(state.status).toBe('verified');
    expect(state.certificateReady).toBe(true);
    expect(state.error).toBeNull();
  });

  it('refuses a name somebody else holds, permanently', async () => {
    const host = createFakeHost();
    await expect(host.add('taken.example.com')).rejects.toBeInstanceOf(HostError);
    await expect(host.add('taken.example.com')).rejects.toSatisfy(isPermanentHostError);
    expect(host.added).toEqual([]);
  });

  it('a slow certificate is verified but not yet working — the distinction the whole feature turns on', async () => {
    const host = createFakeHost();
    await host.add('slow.example.com');
    const state = await host.check('slow.example.com');
    expect(state.status).toBe('verified');
    // Serving on this name now would show every customer a certificate warning.
    expect(state.certificateReady).toBe(false);
  });

  it('keeps saying it cannot see records that are not there, with something to act on', async () => {
    const host = createFakeHost();
    await host.add('missing.example.com');
    for (let i = 0; i < 3; i++) {
      const state = await host.check('missing.example.com');
      expect(state.status).toBe('verifying');
      expect(state.certificateReady).toBe(false);
      expect(state.error).toMatch(/DNS/);
    }
  });

  it('gives a name back, and then has never heard of it', async () => {
    const host = createFakeHost();
    await host.add('gone.example.com');
    await host.remove('gone.example.com');
    expect(host.removed).toEqual(['gone.example.com']);
    const state = await host.check('gone.example.com');
    expect(state.status).toBe('failed');
    expect(state.certificateReady).toBe(false);
  });

  it('does not mind being asked to remove a name it never had', async () => {
    const host = createFakeHost();
    await expect(host.remove('never.example.com')).resolves.toBeUndefined();
  });
});

describe('proving a name is the business’s own', () => {
  it('the fake finds the claim token, except on a name somebody is squatting', async () => {
    const host = createFakeHost();
    expect(await host.owns('_hfos-verify.booking.lonestarhvac.com', 'abc')).toBe(true);
    expect(await host.owns('_hfos-verify.squat.lonestarhvac.com', 'abc')).toBe(false);
  });

  it('reads a TXT record split into pieces as one value, and a name with none as none', async () => {
    const found = await txtValues('_hfos-verify.x.test', async () => [['ab', 'cd'], ['other']]);
    expect(found).toEqual(['abcd', 'other']);
    const none = Object.assign(new Error('no data'), { code: 'ENODATA' });
    expect(
      await txtValues('_hfos-verify.x.test', async () => {
        throw none;
      }),
    ).toEqual([]);
  });

  it('lets DNS having a bad minute be retried rather than read as "not theirs"', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEOUT' });
    await expect(
      txtValues('_hfos-verify.x.test', async () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);
  });
});

describe('linksOn', () => {
  const links = { webUrl: 'https://app.handsfreeos.com', keys: [Buffer.from('k')] };

  it('moves the origin and leaves the signing keys exactly where they were', () => {
    const on = linksOn(links, 'https://booking.lonestarhvac.com');
    expect(on.webUrl).toBe('https://booking.lonestarhvac.com');
    // The same keys, so a link already in somebody's texts still verifies on either name.
    expect(on.keys).toBe(links.keys);
  });

  it('gives back the same object when nothing moves, so the common case allocates nothing', () => {
    expect(linksOn(links, 'https://app.handsfreeos.com')).toBe(links);
  });

  it('never leaves a trailing slash to double up against the path', () => {
    expect(linksOn(links, 'https://booking.lonestarhvac.com/').webUrl).toBe(
      'https://booking.lonestarhvac.com',
    );
  });
});

describe('publicOrigin', () => {
  const OURS = 'https://app.handsfreeos.com';
  const ws = '11111111-1111-4111-8111-111111111111';

  /** Just enough of a `tx` to answer the one select this makes. */
  const txWith = (row: unknown, count = { n: 0 }) =>
    ({
      select: () => ({
        from: () => ({
          where: () => {
            count.n++;
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    }) as unknown as Tx;

  beforeEach(() => forgetPublicOrigin());

  it('is our address when the business has no domain', async () => {
    expect(await publicOrigin(txWith(null), ws, OURS)).toBe(OURS);
  });

  it('is their domain once it is verified and the certificate has issued', async () => {
    const row = { domain: 'booking.lonestarhvac.com', status: 'verified', certificateReady: true };
    expect(await publicOrigin(txWith(row), ws, OURS)).toBe('https://booking.lonestarhvac.com');
  });

  it('is our address while the certificate is still coming — the whole point of the split', async () => {
    const row = { domain: 'booking.lonestarhvac.com', status: 'verified', certificateReady: false };
    // Building a link on this name would send every customer to a browser warning.
    expect(await publicOrigin(txWith(row), ws, OURS)).toBe(OURS);
  });

  it('is our address for a domain still waiting on DNS', async () => {
    const row = {
      domain: 'booking.lonestarhvac.com',
      status: 'verifying',
      certificateReady: false,
    };
    expect(await publicOrigin(txWith(row), ws, OURS)).toBe(OURS);
  });

  it('reads once and then remembers, so a hundred reminders are one query', async () => {
    const count = { n: 0 };
    const row = { domain: 'booking.lonestarhvac.com', status: 'verified', certificateReady: true };
    const tx = txWith(row, count);
    for (let i = 0; i < 5; i++) await publicOrigin(tx, ws, OURS);
    expect(count.n).toBe(1);
  });

  it('forgets on demand, which is what stops a removed domain being used for another minute', async () => {
    const count = { n: 0 };
    const row = { domain: 'booking.lonestarhvac.com', status: 'verified', certificateReady: true };
    const tx = txWith(row, count);
    await publicOrigin(tx, ws, OURS);
    forgetPublicOrigin(ws);
    await publicOrigin(tx, ws, OURS);
    expect(count.n).toBe(2);
  });

  it('gives our address rather than throwing when the database will not answer', async () => {
    const angry = {
      select: () => ({
        from: () => ({
          where: () => Promise.reject(new Error('connection lost')),
        }),
      }),
    } as unknown as Tx;
    // A confirmation text going out on the wrong name beats one not going out at all.
    expect(await publicOrigin(angry, ws, OURS)).toBe(OURS);
  });
});
