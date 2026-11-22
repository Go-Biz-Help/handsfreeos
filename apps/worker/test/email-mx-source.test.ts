import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { mxAtSource, mxFromServers, type MxRecord, type SourceDns } from '../src/email/dns';

/**
 * A receiving domain's MX records are asked of the domain's own name servers (M19), so a change made a minute ago
 * shows at the next look. A resolver keeps the old records for as long as they said to, up to a day at some DNS
 * hosts: a business that deleted its old host's MX records and clicked Check now was still told ours wasn't there.
 */
const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });
const OURS: MxRecord[] = [{ exchange: 'inbound.postmarkapp.com', priority: 10 }];
/** What a resolver still remembers: the old host's records, with ours beside them. */
const REMEMBERED: MxRecord[] = [
  { exchange: 'mx10.oldhost.example', priority: 10 },
  { exchange: 'mx20.oldhost.example', priority: 20 },
  ...OURS,
];

/** A stand-in DNS: each zone's name servers, each server's address, and what the servers and the resolver say. */
function source(opts: {
  ns: Record<string, string[] | Error>;
  addresses?: Record<string, string[] | Error>;
  atSource: MxRecord[] | Error;
  resolver?: MxRecord[] | Error;
}): SourceDns & { asked: string[] } {
  const asked: string[] = [];
  const answer = <T>(a: T[] | Error | undefined, none: string): T[] => {
    if (a instanceof Error) throw a;
    if (a === undefined) throw dnsError(none);
    return a;
  };
  return {
    asked,
    async ns(zone) {
      asked.push(`ns ${zone}`);
      return answer(opts.ns[zone], 'ENODATA');
    },
    async addresses(host) {
      return answer(
        (opts.addresses ?? { 'ns1.dnshost.example': ['192.0.2.1'] })[host],
        'ENOTFOUND',
      );
    },
    async mxAt(servers, host) {
      asked.push(`mx ${host} at ${servers.join(',')}`);
      return answer(opts.atSource, 'ENODATA');
    },
    async mx(host) {
      asked.push(`mx ${host} at the resolver`);
      return answer(opts.resolver ?? REMEMBERED, 'ENODATA');
    },
  };
}

describe('a domain’s MX records, from its own name servers', () => {
  it('asks the domain’s name servers, and never the resolver that remembers the old records', async () => {
    const src = source({
      ns: { 'lonestarhvac.com': ['ns1.dnshost.example', 'ns2.dnshost.example'] },
      addresses: {
        'ns1.dnshost.example': ['192.0.2.1'],
        'ns2.dnshost.example': ['192.0.2.2', '192.0.2.3'],
      },
      atSource: OURS,
    });
    expect(await mxAtSource('LoneStarHVAC.com.', src)).toEqual(OURS);
    expect(src.asked).toEqual([
      'ns lonestarhvac.com',
      'mx LoneStarHVAC.com. at 192.0.2.1,192.0.2.2,192.0.2.3',
    ]);
  });

  it('asks the servers of the name above, for a domain that is no zone of its own', async () => {
    const src = source({
      ns: { 'lonestarhvac.com': ['ns1.dnshost.example'] },
      atSource: OURS,
    });
    expect(await mxAtSource('mail.office.lonestarhvac.com', src)).toEqual(OURS);
    expect(src.asked).toEqual([
      'ns mail.office.lonestarhvac.com',
      'ns office.lonestarhvac.com',
      'ns lonestarhvac.com',
      'mx mail.office.lonestarhvac.com at 192.0.2.1',
    ]);
  });

  it('never asks the servers of a bare ending such as "com"', async () => {
    const src = source({ ns: { com: ['a.gtld-servers.example'] }, atSource: OURS });
    expect(await mxAtSource('lonestarhvac.com', src)).toEqual(REMEMBERED);
    expect(src.asked).toEqual(['ns lonestarhvac.com', 'mx lonestarhvac.com at the resolver']);
  });

  it('asks the resolver, as before, when the name servers can’t be found or don’t answer', async () => {
    const ns = { 'lonestarhvac.com': ['ns1.dnshost.example'] };
    // The resolver didn't say who the name servers are.
    const unknown = source({ ns: { 'lonestarhvac.com': dnsError('ETIMEOUT') }, atSource: OURS });
    expect(await mxAtSource('lonestarhvac.com', unknown)).toEqual(REMEMBERED);
    expect(unknown.asked).toEqual(['ns lonestarhvac.com', 'mx lonestarhvac.com at the resolver']);
    // Their addresses can't be found.
    const nowhere = source({ ns, addresses: {}, atSource: OURS });
    expect(await mxAtSource('lonestarhvac.com', nowhere)).toEqual(REMEMBERED);
    // They don't answer in time, or won't answer us.
    for (const code of ['ECANCELLED', 'ETIMEOUT', 'EREFUSED', 'ESERVFAIL'])
      expect(
        await mxAtSource('lonestarhvac.com', source({ ns, atSource: dnsError(code) })),
      ).toEqual(REMEMBERED);
  });

  // A server that no longer holds the domain (its DNS moved to another host) can say "none" too.
  it('takes only records from the name servers: "none" there is checked with the resolver', async () => {
    const ns = { 'lonestarhvac.com': ['ns1.dnshost.example'] };
    for (const none of [[], dnsError('ENODATA'), dnsError('ENOTFOUND')])
      expect(await mxAtSource('lonestarhvac.com', source({ ns, atSource: none }))).toEqual(
        REMEMBERED,
      );
    // And when the resolver has none either, that is the answer.
    await expect(
      mxAtSource(
        'lonestarhvac.com',
        source({ ns, atSource: dnsError('ENODATA'), resolver: dnsError('ENODATA') }),
      ),
    ).rejects.toMatchObject({ code: 'ENODATA' });
  });
});

describe('asking name servers directly', () => {
  const open: dgram.Socket[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  /** A name server on this machine: answers every MX question with one record, or never answers. */
  async function nameServer(mode: 'answers' | 'silent'): Promise<string> {
    const socket = dgram.createSocket('udp4');
    open.push(socket);
    socket.on('message', (msg, from) => {
      if (mode === 'silent') return;
      // The question follows the 12-byte header: a name (length-prefixed labels, ending in 0), a type and a class.
      let end = 12;
      while (msg[end] !== 0) end += (msg[end] ?? 0) + 1;
      const question = msg.subarray(12, end + 5);
      const exchange = Buffer.concat([
        ...'inbound.postmarkapp.com'
          .split('.')
          .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
        Buffer.from([0]),
      ]);
      const data = Buffer.concat([Buffer.from([0, 10]), exchange]);
      socket.send(
        Buffer.concat([
          msg.subarray(0, 2),
          // An answer from the server that holds the zone (no recursion on offer), one question, one answer.
          Buffer.from([0x85, 0x00, 0, 1, 0, 1, 0, 0, 0, 0]),
          question,
          // The name again (a pointer to the question), MX, IN, a day to live, then preference 10 and the host.
          Buffer.from([0xc0, 0x0c, 0, 15, 0, 1, 0, 1, 0x51, 0x80, 0, data.length]),
          data,
        ]),
        from.port,
        from.address,
      );
    });
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    return `127.0.0.1:${socket.address().port}`;
  }

  it('reads the MX records those servers give', async () => {
    expect(await mxFromServers([await nameServer('answers')], 'lonestarhvac.com')).toEqual(OURS);
  });

  it('gives up on servers that never answer, at the deadline', async () => {
    const started = Date.now();
    await expect(
      mxFromServers([await nameServer('silent')], 'lonestarhvac.com', 200),
    ).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(Date.now() - started).toBeLessThan(1400);
  });
});
