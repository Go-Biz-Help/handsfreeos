/**
 * Times written as text, and which time zones are valid, the same on every engine (M10, spike 1a). The phones'
 * Hermes writes "2:30 PM" with a narrow no-break space where V8's format() writes a plain one, and the engines
 * disagree about zone names ("GMT+5" is valid only on iPhones, "CST" is refused only on Android). Core turns Intl's
 * spaces into plain ones, and checks zones against its own list from tzdb. A phone's own time-zone data can also be
 * older than that list (an Android 16 emulator image has no America/Coyhaique), so core hands Intl a name the engine
 * has, with the same clock.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { zonedParts, zoneOffsetMinutes } from '../src/calendar/engine/zoned';
import {
  canonicalTimeZone,
  intlTimeZone,
  isValidTimeZone,
  plainSpaces,
  TIME_ZONE_ALIASES,
  TIME_ZONE_FALLBACKS,
  TIME_ZONES,
  timeZoneOr,
  TZDB_BASELINE,
  TZDB_VERSION,
} from '../src/intl/index';
import { localMinutes } from '../src/messaging/quiet-hours';
import { smsSegments } from '../src/messaging/sms';
import { dueWording, expiryPhrase } from '../src/money/index';
import { timezone } from '../src/schemas/common';
import { render } from '../src/workflows/templates';

afterAll(closeTestDbs);

const CHI = 'America/Chicago';
const AT = Date.parse('2026-09-16T19:30:00Z');
const CLOCK = { timeZone: CHI, hour: 'numeric', minute: '2-digit' } as const;

type Part = { readonly type: string; readonly value: string };
const joined = (parts: readonly Part[]) => parts.map((p) => p.value).join('');
/** Non-ASCII characters as \uXXXX, so an invisible difference shows in a failure. */
const escaped = (s: string) =>
  s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Runs `fn` with an Intl.DateTimeFormat whose format() keeps ICU's own spaces, as Hermes does on both phones. V8
 * hides the narrow no-break space in format() only, so its formatToParts shows what the phones write.
 */
function withPhoneIntl<T>(fn: () => T): T {
  const Real = Intl.DateTimeFormat;
  class PhoneDateTimeFormat extends Real {
    override format(date?: Date | number): string {
      return joined(this.formatToParts(date));
    }
  }
  const put = (value: unknown) =>
    Object.defineProperty(Intl, 'DateTimeFormat', { value, configurable: true, writable: true });
  put(PhoneDateTimeFormat);
  try {
    return fn();
  } finally {
    put(Real);
  }
}

describe('plain spaces in Intl text', () => {
  // formatToParts as Node 22.16 (ICU 77.1) gives it. Hermes writes the same characters into format() itself.
  const TIME_EN_US: Part[] = [
    { type: 'hour', value: '2' },
    { type: 'literal', value: ':' },
    { type: 'minute', value: '30' },
    { type: 'literal', value: '\u202f' },
    { type: 'dayPeriod', value: 'PM' },
  ];
  const TIME_ES_ES: Part[] = [
    { type: 'hour', value: '7' },
    { type: 'literal', value: ':' },
    { type: 'minute', value: '30' },
    { type: 'literal', value: '\u202f' },
    { type: 'dayPeriod', value: 'p.\u00a0m.' },
  ];
  const RANGE_EN_US: Part[] = [
    { type: 'hour', value: '2' },
    { type: 'literal', value: ':' },
    { type: 'minute', value: '30' },
    { type: 'literal', value: '\u2009–\u2009' },
    { type: 'hour', value: '4' },
    { type: 'literal', value: ':' },
    { type: 'minute', value: '00' },
    { type: 'literal', value: '\u202f' },
    { type: 'dayPeriod', value: 'PM' },
  ];
  const MONEY_FR_FR: Part[] = [
    { type: 'minusSign', value: '-' },
    { type: 'integer', value: '1' },
    { type: 'group', value: '\u202f' },
    { type: 'integer', value: '234' },
    { type: 'decimal', value: ',' },
    { type: 'fraction', value: '50' },
    { type: 'literal', value: '\u00a0' },
    { type: 'currency', value: '$US' },
  ];

  it('makes the narrow no-break space before AM and PM a plain one', () => {
    expect(plainSpaces(joined(TIME_EN_US))).toBe('2:30 PM');
    // The template filter's output on the iPhone simulator and the Android emulator.
    expect(plainSpaces('Lone Star HVAC at 2:30\u202fPM on Wed, Sep 16.')).toBe(
      'Lone Star HVAC at 2:30 PM on Wed, Sep 16.',
    );
  });

  it('makes no-break spaces plain: Spanish "p. m." and a French amount', () => {
    expect(plainSpaces(joined(TIME_ES_ES))).toBe('7:30 p. m.');
    expect(plainSpaces(joined(MONEY_FR_FR))).toBe('-1 234,50 $US');
  });

  it('makes the thin spaces around a range’s dash and a figure space plain', () => {
    expect(plainSpaces(joined(RANGE_EN_US))).toBe('2:30 – 4:00 PM');
    expect(plainSpaces('9\u20070')).toBe('9 0');
  });

  it('changes nothing else', () => {
    const text = 'Hi Maria,\n\tsee you  “today” 2:30–4:00 PM ☀ ';
    expect(plainSpaces(text)).toBe(text);
    expect(plainSpaces('')).toBe('');
  });

  it('gives the same text from V8’s format() and its formatToParts, which keeps U+202F', () => {
    const f = new Intl.DateTimeFormat('en-US', CLOCK);
    expect(plainSpaces(joined(f.formatToParts(AT)))).toBe(plainSpaces(f.format(AT)));
    const range = f.formatRange(AT, AT + 90 * 60_000);
    expect(plainSpaces(range)).toBe('2:30 – 4:00 PM');
  });
});

describe('a templated text with a time', () => {
  const TEMPLATE =
    "Hi {{person.first_name}}, it's Lone Star HVAC. Your AC tune-up is {{appointment.starts_at | date}} at {{appointment.starts_at | time}}. Reply C to confirm.";
  const values = { person: { first_name: 'Maria' }, appointment: { starts_at: new Date(AT) } };
  const TEXT =
    "Hi Maria, it's Lone Star HVAC. Your AC tune-up is Wed, Sep 16 at 2:30 PM. Reply C to confirm.";

  it('is one GSM-7 segment on the server', () => {
    const out = render(TEMPLATE, values, { timeZone: CHI });
    expect(out.text).toBe(TEXT);
    expect(smsSegments(out.text)).toMatchObject({ encoding: 'gsm7', segments: 1 });
  });

  it('is the same text and one segment where Intl writes U+202F, as on the phones', () => {
    const raw = withPhoneIntl(() => new Intl.DateTimeFormat('en-US', CLOCK).format(AT));
    expect(escaped(raw)).toBe('2:30\\u202fPM');
    const out = withPhoneIntl(() => render(TEMPLATE, values, { timeZone: CHI }));
    expect(escaped(out.text)).toBe(escaped(TEXT));
    expect(smsSegments(out.text)).toMatchObject({ encoding: 'gsm7', segments: 1 });
    // What a phone would have counted before: UCS-2, in two parts.
    expect(smsSegments(TEXT.replace('2:30 PM', raw))).toMatchObject({
      encoding: 'ucs2',
      segments: 2,
    });
  });
});

describe('the time-zone list', () => {
  it('is tzdb 2026d: 419 zones and 141 older names', () => {
    expect({
      version: TZDB_VERSION,
      zones: TIME_ZONES.length,
      aliases: Object.keys(TIME_ZONE_ALIASES).length,
    }).toEqual({ version: '2026d', zones: 419, aliases: 141 });
  });

  it('keeps the zones sorted and apart from the older names, each of which leads to a zone', () => {
    expect([...TIME_ZONES].sort()).toEqual(TIME_ZONES);
    expect(new Set(TIME_ZONES).size).toBe(TIME_ZONES.length);
    const zones = new Set(TIME_ZONES);
    const wrong = Object.entries(TIME_ZONE_ALIASES).filter(
      ([alias, zone]) => zones.has(alias) || !zones.has(zone),
    );
    expect(wrong).toEqual([]);
  });

  it('keeps each place, and reads older names as their current zone, in any letter case', () => {
    for (const zone of [CHI, 'UTC', 'Europe/Oslo', 'America/Coyhaique', 'Asia/Kolkata'])
      expect(canonicalTimeZone(zone)).toBe(zone);
    expect(
      Object.fromEntries(
        [
          'Asia/Calcutta',
          'America/Buenos_Aires',
          'US/Central',
          'US/Eastern',
          'Canada/Pacific',
          'Europe/Kiev',
          'America/Godthab',
          'Pacific/Enderbury',
          'Iceland',
          'Pacific/Yap',
          'Etc/UTC',
          'Etc/GMT',
          'GMT',
          'Etc/GMT+0',
          'Zulu',
          'america/chicago',
          'utc',
          'ASIA/CALCUTTA',
        ].map((name) => [name, canonicalTimeZone(name)]),
      ),
    ).toEqual({
      'Asia/Calcutta': 'Asia/Kolkata',
      'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
      'US/Central': CHI,
      'US/Eastern': 'America/New_York',
      'Canada/Pacific': 'America/Vancouver',
      'Europe/Kiev': 'Europe/Kyiv',
      'America/Godthab': 'America/Nuuk',
      'Pacific/Enderbury': 'Pacific/Kanton',
      Iceland: 'Atlantic/Reykjavik',
      'Pacific/Yap': 'Pacific/Chuuk',
      'Etc/UTC': 'UTC',
      'Etc/GMT': 'UTC',
      GMT: 'UTC',
      'Etc/GMT+0': 'UTC',
      Zulu: 'UTC',
      'america/chicago': CHI,
      utc: 'UTC',
      'ASIA/CALCUTTA': 'Asia/Kolkata',
    });
    expect(isValidTimeZone('US/Central')).toBe(true);
  });

  it('refuses abbreviations, fixed offsets and anything else, whatever an engine says', () => {
    const accepted = [
      'CST',
      'PST',
      'IST',
      'EST',
      'MST',
      'HST',
      'CET',
      'EST5EDT',
      'CST6CDT',
      'GMT+5',
      'UTC+5',
      'GMT+05:30',
      'Etc/GMT+5',
      'Etc/GMT-14',
      'Etc/Unknown',
      'Factory',
      'localtime',
      'America/Chicgo',
      'Mars/Olympus',
      '',
      ' America/Chicago',
      'America/Chicago ',
    ].filter((name) => isValidTimeZone(name));
    expect(accepted).toEqual([]);
    for (const value of [undefined, null, 42, {}]) expect(canonicalTimeZone(value)).toBeNull();
  });

  it('has every zone Node reports, so a browser’s own zone is on it', () => {
    const missing = Intl.supportedValuesOf('timeZone').filter((name) => !isValidTimeZone(name));
    expect(missing).toEqual([]);
  });

  it('formats every zone on Node, and every older name with its zone’s clock since 1971', () => {
    const at = Date.parse('2026-09-16T12:00:00Z');
    const unformatted = TIME_ZONES.filter((zone) => {
      try {
        return zonedParts(at, zone).year !== 2026;
      } catch {
        return true;
      }
    });
    expect(unformatted).toEqual([]);

    const instants: number[] = [];
    for (let year = 1971; year <= 2037; year++)
      instants.push(Date.UTC(year, 0, 15, 12), Date.UTC(year, 6, 15, 12));
    const drift: string[] = [];
    for (const [alias, zone] of Object.entries(TIME_ZONE_ALIASES))
      for (const instant of instants)
        if (zoneOffsetMinutes(instant, alias) !== zoneOffsetMinutes(instant, zone))
          drift.push(`${alias} (${zone}) at ${new Date(instant).toISOString()}`);
    expect(drift).toEqual([]);
  });

  it('is known to Postgres, which checks calendar and schedule zones and reads business days', async () => {
    const known = new Set(
      (
        await rows<{ name: string }>(testDbs().admin.db, sql`select name from pg_timezone_names`)
      ).map((r) => r.name),
    );
    expect(TIME_ZONES.filter((zone) => !known.has(zone))).toEqual([]);
  });
});

describe('the timezone input', () => {
  it('stores an older name as its current zone', () => {
    expect(timezone.parse(' US/Central ')).toBe(CHI);
    expect(timezone.parse('asia/calcutta')).toBe('Asia/Kolkata');
    expect(timezone.parse(CHI)).toBe(CHI);
  });

  it('refuses abbreviations and offsets', () => {
    for (const name of ['CST', 'GMT+5', 'Etc/GMT+5', 'EST']) {
      const result = timezone.safeParse(name);
      expect(result.success, name).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toEqual(['Unknown time zone.']);
    }
  });
});

describe('a visitor’s own zone on a public page', () => {
  const NOW = Date.parse('2026-09-16T15:00:00Z');

  it('is read as its current zone, and anything off the list falls back instead of failing', () => {
    expect(timeZoneOr('Asia/Calcutta', 'UTC')).toBe('Asia/Kolkata');
    expect(timeZoneOr(CHI, 'UTC')).toBe(CHI);
    for (const reported of ['Etc/Unknown', 'CST', 'GMT+05:30', 'Etc/GMT+5', '', undefined, null])
      expect(timeZoneOr(reported, 'America/Denver')).toBe('America/Denver');
  });

  it('keeps an invoice’s due words and an estimate’s expiry working where Intl refuses the zone', () => {
    // "Etc/Unknown" is ICU's name when a browser can't tell the computer's zone, and V8 refuses to format in it.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: 'Etc/Unknown' })).toThrow(RangeError);
    const zone = timeZoneOr('Etc/Unknown', 'UTC');
    expect(dueWording('2026-09-18', NOW, zone)).toBe('Due Fri');
    expect(expiryPhrase('2026-09-30', NOW, zone)).toBe('good until Wed, Sep 30');
  });
});

// ---- A zone the engine's time-zone data doesn't have ----

const DAY_MS = 86_400_000;

/** A zone's UTC offset in minutes, straight from Node's Intl (not through core). */
function nodeOffset(zone: string): (at: number) => number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
  return (at) => {
    const name = f.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (!m) throw new Error(`Not an offset: ${name}`);
    const minutes = m[1] ? Number(m[2]) * 60 + Number(m[3]) : 0;
    return m[1] === '-' ? -minutes : minutes;
  };
}

/**
 * Runs `fn` on an engine whose time-zone data lacks the zones `lacks` picks: Intl.DateTimeFormat throws RangeError
 * for them, as Hermes does on a phone. Core's modules are loaded afresh inside, so nothing is remembered from Node.
 */
async function onOlderEngine<T>(
  lacks: (zone: string) => boolean,
  fn: (core: {
    intlTimeZone: typeof intlTimeZone;
    zonedParts: typeof zonedParts;
    localMinutes: typeof localMinutes;
    render: typeof render;
    probes: () => number;
  }) => Promise<T> | T,
): Promise<T> {
  const Real = Intl.DateTimeFormat;
  let probes = 0;
  class OlderEngineDateTimeFormat extends Real {
    constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      const zone = options?.timeZone;
      if (zone !== undefined && Object.keys(options ?? {}).length === 1) probes++;
      if (zone !== undefined && lacks(zone))
        throw new RangeError(`Invalid time zone specified: ${zone}`);
      super(locales, options);
    }
  }
  const put = (value: unknown) =>
    Object.defineProperty(Intl, 'DateTimeFormat', { value, configurable: true, writable: true });
  vi.resetModules();
  put(OlderEngineDateTimeFormat);
  try {
    const engine = await import('../src/intl/engine-zones');
    const zoned = await import('../src/calendar/engine/zoned');
    const quiet = await import('../src/messaging/quiet-hours');
    const templates = await import('../src/workflows/templates');
    return await fn({
      intlTimeZone: engine.intlTimeZone,
      zonedParts: zoned.zonedParts,
      localMinutes: quiet.localMinutes,
      render: templates.render,
      probes: () => probes,
    });
  } finally {
    put(Real);
    vi.resetModules();
  }
}

/** Where core hands Intl a zone without `intlTimeZone`: "file:line" for each such call in `text`. */
function intlCallsSkippingEngineZone(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Intl\.DateTimeFormat\s*\(|\.toLocale(?:Date|Time)?String\s*\(/g)) {
    let depth = 1;
    let end = m.index + m[0].length;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')') depth--;
    }
    const args = text.slice(m.index + m[0].length, end);
    const dateFormat = m[0].startsWith('Intl');
    const skips = dateFormat
      ? !/timeZone:\s*intlTimeZone\(/.test(args)
      : /timeZone/.test(args) && !/timeZone:\s*intlTimeZone\(/.test(args);
    if (skips) out.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
  }
  return out;
}

describe('a zone this engine’s time-zone data doesn’t have', () => {
  it('has fallbacks for the zones tzdb 2016a didn’t have, each an older name or a zone on the list', () => {
    expect(TZDB_BASELINE).toBe('2016a');
    expect(Object.keys(TIME_ZONE_FALLBACKS)).toEqual([
      'America/Ciudad_Juarez',
      'America/Coyhaique',
      'America/Nuuk',
      'America/Punta_Arenas',
      'Asia/Atyrau',
      'Asia/Barnaul',
      'Asia/Famagusta',
      'Asia/Qostanay',
      'Asia/Tomsk',
      'Asia/Yangon',
      'Europe/Astrakhan',
      'Europe/Kirov',
      'Europe/Kyiv',
      'Europe/Saratov',
      'Europe/Ulyanovsk',
      'Pacific/Kanton',
    ]);
    const zones = new Set(TIME_ZONES);
    const odd = Object.entries(TIME_ZONE_FALLBACKS).flatMap(([zone, names]) => [
      ...(zones.has(zone) ? [] : [zone]),
      ...names.filter((name) => !zones.has(name) && TIME_ZONE_ALIASES[name] !== zone),
    ]);
    expect(odd).toEqual([]);
    expect(TIME_ZONE_FALLBACKS['America/Coyhaique']).toEqual([
      'America/Punta_Arenas',
      'America/Cayenne',
    ]);
    expect(TIME_ZONE_FALLBACKS['Europe/Kyiv']).toEqual(['Europe/Kiev']);
  });

  it('keeps each fallback on its zone’s clock on Node, daily from two years ago to five years ahead', () => {
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS / 2;
    const drift: string[] = [];
    for (const [zone, names] of Object.entries(TIME_ZONE_FALLBACKS)) {
      const expected = nodeOffset(zone);
      for (const name of names) {
        const actual = nodeOffset(name);
        for (let at = today - 2 * 365 * DAY_MS; at <= today + 5 * 365 * DAY_MS; at += DAY_MS)
          if (actual(at) !== expected(at)) {
            drift.push(`${name} for ${zone} on ${new Date(at).toISOString().slice(0, 10)}`);
            break;
          }
      }
    }
    expect(drift).toEqual([]);
  });

  it('hands Intl the zone itself where the engine has it', () => {
    expect(intlTimeZone('America/Coyhaique')).toBe('America/Coyhaique');
    expect(intlTimeZone(CHI)).toBe(CHI);
    expect(intlTimeZone('US/Central')).toBe('US/Central');
  });

  it('tries the zone’s older names, then zones with its clock, and asks the engine once per zone', async () => {
    const missing = new Set([
      'America/Coyhaique',
      'America/Punta_Arenas',
      'Europe/Kyiv',
      'US/Central',
    ]);
    await onOlderEngine(
      (zone) => missing.has(zone),
      (core) => {
        expect(core.intlTimeZone('America/Coyhaique')).toBe('America/Cayenne');
        expect(core.probes()).toBe(3);
        expect(core.intlTimeZone('America/Coyhaique')).toBe('America/Cayenne');
        expect(core.probes()).toBe(3);
        expect(core.intlTimeZone('Europe/Kyiv')).toBe('Europe/Kiev');
        expect(core.intlTimeZone('US/Central')).toBe(CHI);
      },
    );
    await onOlderEngine(
      (zone) => zone === 'America/Coyhaique',
      (core) => expect(core.intlTimeZone('America/Coyhaique')).toBe('America/Punta_Arenas'),
    );
  });

  it('shows the zone’s clock through core’s calendar, quiet hours and templates on that engine', async () => {
    const instants = ['2026-01-15T12:00:00Z', '2026-07-15T03:30:00Z', '2029-11-02T23:59:00Z'].map(
      (iso) => Date.parse(iso),
    );
    const zone = 'America/Coyhaique';
    const expected = instants.map((at) => ({
      parts: zonedParts(at, zone),
      minutes: localMinutes(new Date(at), zone),
      text: render('{{at | date}} {{at | time}}', { at: new Date(at) }, { timeZone: zone }).text,
    }));
    const actual = await onOlderEngine(
      (name) => name === zone || name === 'America/Punta_Arenas',
      (core) =>
        instants.map((at) => ({
          parts: core.zonedParts(at, zone),
          minutes: core.localMinutes(new Date(at), zone),
          text: core.render('{{at | date}} {{at | time}}', { at: new Date(at) }, { timeZone: zone })
            .text,
        })),
    );
    expect(actual).toEqual(expected);
  });

  it('falls back to UTC, and says so once, where the engine knows none of them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await onOlderEngine(
        (zone) => zone !== 'UTC',
        (core) => {
          expect(core.intlTimeZone('America/Coyhaique')).toBe('UTC');
          expect(core.intlTimeZone('America/Coyhaique')).toBe('UTC');
          expect(
            core.zonedParts(Date.parse('2026-09-16T23:30:00Z'), 'America/Coyhaique'),
          ).toMatchObject({ day: 16, hour: 23, minute: 30 });
        },
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('America/Coyhaique');
      // Names that aren't zones at all never throw either.
      expect(intlTimeZone('__proto__')).toBe('UTC');
      expect(intlTimeZone('Etc/Unknown')).toBe('UTC');
    } finally {
      warn.mockRestore();
    }
  });

  it('hands every Intl call in core its zone through intlTimeZone', () => {
    const src = new URL('../src/', import.meta.url);
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => file.endsWith('.ts') && file !== 'intl/engine-zones.ts');
    const calling: string[] = [];
    const skipping: string[] = [];
    for (const file of files) {
      const text = readFileSync(new URL(file, src), 'utf8');
      if (/Intl\.DateTimeFormat\s*\(/.test(text)) calling.push(file);
      skipping.push(...intlCallsSkippingEngineZone(file, text));
    }
    expect(skipping).toEqual([]);
    expect(calling.sort()).toEqual([
      'calendar/engine/zoned.ts',
      'calendar/when.ts',
      'messaging/quiet-hours.ts',
      // The wallet's month key: what month a phone number's rent falls in, where the business is (M16).
      'money/usage-keys.ts',
      'workflows/templates.ts',
    ]);
    // The scan catches a call that skips it.
    expect(
      intlCallsSkippingEngineZone(
        'new.ts',
        "const a = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric' });\n" +
          "const b = at.toLocaleTimeString('en-US', { timeZone: zone });\n" +
          "const c = (1234).toLocaleString('en-US');",
      ),
    ).toEqual(['new.ts:1', 'new.ts:2']);
  });
});
