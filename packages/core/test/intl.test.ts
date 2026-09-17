/**
 * Times written as text, and which time zones are valid, the same on every engine (M10, spike 1a). The phones'
 * Hermes writes "2:30 PM" with a narrow no-break space where V8's format() writes a plain one, and the engines
 * disagree about zone names ("GMT+5" is valid only on iPhones, "CST" is refused only on Android). Core turns Intl's
 * spaces into plain ones, and checks zones against its own list from tzdb.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { zonedParts, zoneOffsetMinutes } from '../src/calendar/engine/zoned';
import {
  canonicalTimeZone,
  isValidTimeZone,
  plainSpaces,
  TIME_ZONE_ALIASES,
  TIME_ZONES,
  timeZoneOr,
  TZDB_VERSION,
} from '../src/intl/index';
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
    expect(() => dueWording('2026-09-18', NOW, 'Etc/Unknown')).toThrow(RangeError);
    const zone = timeZoneOr('Etc/Unknown', 'UTC');
    expect(dueWording('2026-09-18', NOW, zone)).toBe('Due Fri');
    expect(expiryPhrase('2026-09-30', NOW, zone)).toBe('good until Wed, Sep 30');
  });
});
