#!/usr/bin/env node
/**
 * Core's list of time zones, and the names a phone with older time-zone data tries instead, generated from pinned tzdb
 * releases so a phone, the web and the server agree. Intl can't be asked which zones are valid: its answers differ by
 * engine (iPhones accept "GMT+5", Android refuses "CST", V8 reads "CST" as Chicago).
 *
 *   node scripts/time-zones.mjs    fetch the two releases below from IANA, check their SHA-256, write both files
 *
 * Writes packages/core/src/intl/time-zone-names.ts and time-zone-fallbacks.ts. To move to a newer tzdb, take the
 * tarball's name and SHA-256 from https://data.iana.org/time-zones/releases/, set VERSION and SHA256, run this, and
 * update the snapshots in packages/core/test/intl.test.ts. Nothing is saved but the two files.
 *
 * What the list holds:
 * - **Zones** stored as they are: every place with a Zone of its own in tzdb's region files, every name in zone.tab
 *   (each country's own name, such as Europe/Oslo, which tzdb links to Europe/Berlin because their clocks have
 *   agreed since 1970), and UTC.
 * - **Aliases**: every other name tzdb keeps for backward compatibility (Asia/Calcutta, America/Buenos_Aires,
 *   US/Central, Etc/UTC), each with the zone it's stored as. The target is tzdb's own: its backzone link when that
 *   names a zone above (Pacific/Yap is Pacific/Chuuk), else the "#=" note beside the link (Iceland is
 *   Atlantic/Reykjavik), else the link itself, followed until it reaches a zone. Etc/UTC, Etc/GMT and their links
 *   are UTC.
 * - **Refused**, by leaving them off: tzdb's abbreviations and POSIX-style names (EST, CET, EST5EDT) and its fixed
 *   offsets (Etc/GMT+5), like "CST" and "GMT+5", which were never in tzdb. They don't follow daylight saving the way
 *   a business's clocks do.
 *
 * The fallbacks are explained in the header this writes into time-zone-fallbacks.ts. Clocks are worked out here from
 * tzdb's own rules (readZic, clockOf), which agree with Node's ICU wherever the two have the same data.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import * as prettier from 'prettier';

const VERSION = '2026d';
const SHA256 = '0cb2aa8e333c3dc049badc42a0c61f21987b8cd44e107fa900bad764aacc7767';
/**
 * The oldest time-zone data a supported phone can have. Android 7.0 (API 24, the app's minimum) shipped in August 2016
 * with data from that year; iOS 16.4 is newer. 2016a is 2016's first release.
 */
const BASELINE = '2016a';
const BASELINE_SHA256 = '5efa6b324e64ef921ef700ac3273a51895f672684a30e342f68e47871c6a8cd1';
const sourceOf = (version) => `https://data.iana.org/time-zones/releases/tzdata${version}.tar.gz`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'packages/core/src/intl/time-zone-names.ts');
const FALLBACKS_OUT = join(root, 'packages/core/src/intl/time-zone-fallbacks.ts');

const REGIONS = [
  'africa',
  'antarctica',
  'asia',
  'australasia',
  'europe',
  'northamerica',
  'southamerica',
];
/** tzdb names that are abbreviations or POSIX-style rules rather than places. */
const ABBREVIATIONS = [
  'CET',
  'CST6CDT',
  'EET',
  'EST',
  'EST5EDT',
  'HST',
  'MET',
  'MST',
  'MST7MDT',
  'PST8PDT',
  'WET',
];
/** Fixed offsets from UTC (Etc/GMT+5 is five hours behind it). Etc/GMT+0 and its like are UTC. */
const OFFSET = /^Etc\/GMT[+-](?:[1-9]|1[0-4])$/;
/** tzdb's two zero-offset zones, both stored as UTC. */
const UTC_ZONES = ['Etc/UTC', 'Etc/GMT'];
/** How far either side of the release fallbacks must keep their zone's clock: two years before, five after. */
const YEARS_BEFORE = 2;
const YEARS_AFTER = 5;

// ------------------------------------------------------------------------------------------------ reading tzdb

async function fetchRelease(version, sha256) {
  const source = sourceOf(version);
  const res = await fetch(source);
  if (!res.ok) throw new Error(`${source} answered ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(gz).digest('hex');
  if (sha !== sha256)
    throw new Error(`${source} has SHA-256 ${sha}, not the pinned ${sha256}. Nothing was written.`);
  const files = untar(gunzipSync(gz));
  const file = (name) => {
    const text = files.get(name);
    if (text === undefined) throw new Error(`tzdata${version} has no ${name} file`);
    return text;
  };
  return { version, file, has: (name) => files.has(name) };
}

/** The regular files in a tar archive, by name. */
function untar(tar) {
  const files = new Map();
  const field = (header, from, length) =>
    header
      .subarray(from, from + length)
      .toString('utf8')
      .replace(/\0.*$/s, '')
      .trim();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    const name = field(header, 0, 100);
    if (!name) break;
    const size = parseInt(field(header, 124, 12) || '0', 8);
    const type = header[156];
    if (type === 0 || type === 48)
      files.set(name, tar.subarray(at + 512, at + 512 + size).toString('utf8'));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const zoneNames = (text) => [...text.matchAll(/^Zone\s+(\S+)/gm)].map((m) => m[1]);
/** `Link TARGET NAME #= TARGET1` lines. */
const links = (text) =>
  [...text.matchAll(/^Link\s+(\S+)\s+(\S+)(?:\s+#=\s*(\S+))?/gm)].map((m) => ({
    target: m[1],
    name: m[2],
    target1: m[3] ?? null,
  }));
/** A .tab file's rows as [zone name, first column]. */
const tabRows = (text) =>
  text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .map((columns) => [columns[2], columns[0]]);

/** When a release came out ('2026-09-11'), from the top of its NEWS. */
function releasedOn(release) {
  const m = new RegExp(`^Release ${release.version} - (\\d{4})-(\\d{2})-(\\d{2})`, 'm').exec(
    release.file('NEWS'),
  );
  if (!m) throw new Error(`tzdata${release.version}'s NEWS doesn't say when it was released`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// ------------------------------------------------------------------------------------------------ building the list

function buildList(release) {
  const { file } = release;
  const version = file('version').trim();
  if (version !== VERSION) throw new Error(`The release says it is ${version}, not ${VERSION}`);

  const zones = new Set([
    'UTC',
    ...REGIONS.flatMap((f) => zoneNames(file(f))),
    ...tabRows(file('zone.tab')).map(([name]) => name),
  ]);

  const extra = ['etcetera', 'backward'];
  const allNames = new Set([
    ...zones,
    ...extra.flatMap((f) => zoneNames(file(f))),
    ...extra.flatMap((f) => links(file(f)).map((l) => l.name)),
  ]);
  for (const name of ABBREVIATIONS)
    if (!allNames.has(name))
      throw new Error(`${name} is no longer in tzdb: take it off ABBREVIATIONS`);

  const linkOf = new Map(extra.flatMap((f) => links(file(f))).map((l) => [l.name, l]));
  const backzone = new Map(links(file('backzone')).map((l) => [l.name, l.target]));

  /** The zone an older name is stored as. */
  const current = (name) => {
    const seen = [];
    for (let at = name; ;) {
      if (UTC_ZONES.includes(at)) return 'UTC';
      if (zones.has(at)) return at;
      if (seen.includes(at)) throw new Error(`${name} links in a circle: ${seen.join(' → ')}`);
      seen.push(at);
      const link = linkOf.get(at);
      const next = [backzone.get(at), link?.target1, link?.target].find(
        (t) => t && (zones.has(t) || linkOf.has(t) || UTC_ZONES.includes(t)),
      );
      if (!next) throw new Error(`${name} doesn't lead to a zone (stopped at ${at})`);
      at = next;
    }
  };

  const aliases = new Map();
  for (const name of allNames) {
    if (zones.has(name) || ABBREVIATIONS.includes(name) || OFFSET.test(name)) continue;
    aliases.set(name, current(name));
  }
  return {
    version,
    zones: [...zones].sort(),
    aliases: [...aliases].sort(([a], [b]) => (a < b ? -1 : 1)),
    refused: [...allNames].filter((n) => ABBREVIATIONS.includes(n) || OFFSET.test(n)).sort(),
  };
}

// ------------------------------------------------------------------------------------------------ tzdb's clocks

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Rules are expanded up to this year, well past the latest instant compared. */
const LAST_RULE_YEAR = 2045;

const monthOf = (text) => {
  const i = MONTHS.findIndex((m) => text.startsWith(m));
  if (i < 0) throw new Error(`Not a month: ${text}`);
  return i;
};
const weekdayOf = (text) => {
  const i = WEEKDAYS.findIndex((d) => text.startsWith(d));
  if (i < 0) throw new Error(`Not a weekday: ${text}`);
  return i;
};

/** "2:00", "-1:00", "24:00", "0", "1:00u" as seconds, and when it's read: w wall clock, s standard time, u UT. */
function timeOf(text) {
  const m = /^(-)?(\d+)(?::(\d+))?(?::(\d+))?(?:\.\d+)?([wsugzd])?$/.exec(text);
  if (!m) throw new Error(`Not a time: ${text}`);
  const seconds = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  const suffix = m[5] === 'g' || m[5] === 'z' ? 'u' : (m[5] ?? 'w');
  return { seconds: m[1] ? -seconds : seconds, suffix };
}

/** The day an ON field names in a month ("lastSun", "Sun>=8", "Fri<=1", "15"); it may run into the next month. */
function dayOf(year, month, on) {
  if (/^\d+$/.test(on)) return Number(on);
  const last = /^last(\w+)$/.exec(on);
  if (last) {
    const lastDate = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const lastWeekday = new Date(Date.UTC(year, month, lastDate)).getUTCDay();
    return lastDate - ((lastWeekday - weekdayOf(last[1]) + 7) % 7);
  }
  const near = /^(\w+)([<>]=)(\d+)$/.exec(on);
  if (!near) throw new Error(`Not a day: ${on}`);
  const weekday = weekdayOf(near[1]);
  const n = Number(near[3]);
  const nWeekday = new Date(Date.UTC(year, month, n)).getUTCDay();
  return near[2] === '>=' ? n + ((weekday - nWeekday + 7) % 7) : n - ((nWeekday - weekday + 7) % 7);
}

/** The Zone, Link and Rule lines of zic input files. */
function readZic(release, fileNames) {
  const zones = new Map();
  const linkTargets = new Map();
  const rules = new Map();
  for (const fileName of fileNames) {
    let zone = null;
    for (const raw of release.file(fileName).split('\n')) {
      const fields = raw.replace(/#.*$/, '').trim().split(/\s+/).filter(Boolean);
      if (!fields.length) continue;
      if (fields[0] === 'Rule') {
        zone = null;
        const [, name, from, to, , month, on, at, save] = fields;
        const fromYear = /^mi/.test(from) ? 1800 : Number(from);
        const toYear = to === 'only' ? fromYear : /^ma/.test(to) ? Infinity : Number(to);
        if (!rules.has(name)) rules.set(name, []);
        rules.get(name).push({
          from: fromYear,
          to: toYear,
          month: monthOf(month),
          on,
          at: timeOf(at),
          save: timeOf(save).seconds,
        });
      } else if (fields[0] === 'Link') {
        zone = null;
        linkTargets.set(fields[2], fields[1]);
      } else if (fields[0] === 'Zone' || (zone && /^\s/.test(raw))) {
        if (fields[0] === 'Zone') zones.set(fields[1], (zone = []));
        const [stdoff, rulesField, , ...until] = fields[0] === 'Zone' ? fields.slice(2) : fields;
        zone.push({
          stdoff: timeOf(stdoff).seconds,
          rules:
            rulesField === '-'
              ? { kind: 'none' }
              : /^-?\d/.test(rulesField)
                ? { kind: 'fixed', save: timeOf(rulesField).seconds }
                : { kind: 'named', name: rulesField },
          until: until.length ? until : null,
        });
        if (!until.length) zone = null;
      } else {
        zone = null;
      }
    }
  }
  return { zones, linkTargets, rules, transitions: new Map() };
}

/**
 * A zone's clock under one release's rules: its UTC offset at any instant, the instants it changes, and when its
 * current rules (its last Zone line) began. Instants are seconds since 1970. Null when the release has no such name.
 */
function clockOf(data, name) {
  let target = name === 'UTC' ? 'Etc/UTC' : name;
  for (let i = 0; data.linkTargets.has(target) && i < 5; i++) target = data.linkTargets.get(target);
  const lines = data.zones.get(target);
  if (!lines) return null;

  const transitionsOf = (rulesName, stdoff) => {
    const key = `${rulesName}|${stdoff}`;
    let found = data.transitions.get(key);
    if (found) return found;
    const set = data.rules.get(rulesName);
    if (!set) throw new Error(`No rules named ${rulesName}`);
    const events = [];
    for (const rule of set)
      for (let year = rule.from; year <= Math.min(rule.to, LAST_RULE_YEAR); year++) {
        const midnight = Date.UTC(year, rule.month, dayOf(year, rule.month, rule.on)) / 1000;
        events.push({ local: midnight + rule.at.seconds, suffix: rule.at.suffix, save: rule.save });
      }
    events.sort((a, b) => a.local - b.local);
    let before = 0;
    found = events.map((e) => {
      const lead = e.suffix === 'u' ? 0 : e.suffix === 's' ? stdoff : stdoff + before;
      before = e.save;
      return { at: e.local - lead, save: e.save };
    });
    data.transitions.set(key, found);
    return found;
  };
  const saveIn = (line, t) => {
    if (line.rules.kind === 'none') return 0;
    if (line.rules.kind === 'fixed') return line.rules.save;
    const transitions = transitionsOf(line.rules.name, line.stdoff);
    let lo = 0;
    let hi = transitions.length - 1;
    let latest = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (transitions[mid].at <= t) {
        latest = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return latest < 0 ? 0 : transitions[latest].save;
  };

  let start = -Infinity;
  const spans = lines.map((line) => {
    let end = Infinity;
    if (line.until) {
      const [y, month = 'Jan', day = '1', time = '0'] = line.until;
      const year = Number(y);
      const m = monthOf(month);
      const at = timeOf(time);
      const local = Date.UTC(year, m, dayOf(year, m, day)) / 1000 + at.seconds;
      const standard = local - line.stdoff;
      end =
        at.suffix === 'u'
          ? local
          : at.suffix === 's'
            ? standard
            : standard - saveIn(line, standard - 1);
    }
    const span = { line, start, end };
    start = end;
    return span;
  });

  return {
    rulesSince: spans.length > 1 ? spans[spans.length - 1].start : -Infinity,
    offsetAt(t) {
      const span = spans.find((s) => t < s.end);
      return span.line.stdoff + saveIn(span.line, t);
    },
    changesIn(from, to) {
      const out = [];
      for (const { line, start: s, end: e } of spans) {
        if (e <= from || s >= to) continue;
        if (s > from) out.push(s);
        if (line.rules.kind === 'named')
          for (const { at } of transitionsOf(line.rules.name, line.stdoff))
            if (at > Math.max(from, s) && at < Math.min(to, e)) out.push(at);
      }
      return out;
    },
  };
}

/** Two clocks agree when they have the same offset at the start and at every instant either changes. */
function agree(a, b, from, to) {
  return [from, ...a.changesIn(from, to), ...b.changesIn(from, to)].every(
    (t) => a.offsetAt(t) === b.offsetAt(t),
  );
}

// ------------------------------------------------------------------------------------------------ the fallbacks

const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isoDate = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
/** The local date a zone's current rules began. */
const rulesDate = (clock) => isoDate(clock.rulesSince + clock.offsetAt(clock.rulesSince));
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function buildFallbacks(list, current, baseline) {
  const dataFiles = [...REGIONS, 'etcetera', 'backward'];
  const now = readZic(current, dataFiles);
  // The files a default build compiled then.
  const then = readZic(baseline, [
    ...dataFiles,
    ...(baseline.has('pacificnew') ? ['pacificnew'] : []),
  ]);
  const known = new Set([...then.zones.keys(), ...then.linkTargets.keys()]);

  const released = releasedOn(current);
  const from = Date.UTC(released.year - YEARS_BEFORE, released.month - 1, released.day) / 1000;
  const to = Date.UTC(released.year + YEARS_AFTER, released.month - 1, released.day) / 1000;
  const baselineReleased = releasedOn(baseline);
  const baselineDate =
    Date.UTC(baselineReleased.year, baselineReleased.month - 1, baselineReleased.day) / 1000;

  const countryOf = new Map(tabRows(current.file('zone.tab')));
  const representatives = new Set(tabRows(current.file('zonenow.tab')).map(([name]) => name));

  const nowClocks = new Map();
  const clockNow = (name) => {
    if (!nowClocks.has(name)) nowClocks.set(name, clockOf(now, name));
    return nowClocks.get(name);
  };

  const unknown = list.zones.filter((zone) => zone !== 'UTC' && !known.has(zone));
  const fallbacks = [];
  const without = [];
  for (const zone of unknown) {
    const clock = clockNow(zone);
    /** Known to the baseline, and its clock under the baseline's rules already matched this zone's. */
    const keptThen = (name) => {
      const old = known.has(name) ? clockOf(then, name) : null;
      return !!old && agree(old, clock, from, to);
    };
    const tries = [];

    // 1. Older names the baseline had, up to the first that kept the clock then.
    const older = list.aliases
      .filter(([name, target]) => target === zone && known.has(name))
      .map(([name]) => name)
      .sort((a, b) => Number(keptThen(b)) - Number(keptThen(a)) || ascending(a, b));
    for (const name of older) {
      tries.push({ name, why: 'older name' });
      if (keptThen(name)) break;
    }

    if (!tries.some((t) => keptThen(t.name))) {
      const sameClock = list.zones.filter(
        (other) => other !== zone && other !== 'UTC' && agree(clockNow(other), clock, from, to),
      );
      const sameCountry = (other) => countryOf.get(other) === countryOf.get(zone);
      // 3. Zones the baseline had, on rules older than it, keeping this clock under its rules and today's.
      const steady = sameClock
        .filter((other) => clockNow(other).rulesSince < baselineDate && keptThen(other))
        .sort(
          (a, b) =>
            Number(sameCountry(b)) - Number(sameCountry(a)) ||
            Number(representatives.has(b)) - Number(representatives.has(a)) ||
            ascending(clockNow(a).rulesSince, clockNow(b).rulesSince) ||
            ascending(a, b),
        );
      // 2. When none of those is in the same country: the one in its country that took up this clock first.
      if (!steady.some(sameCountry)) {
        const sibling = sameClock
          .filter((other) => sameCountry(other) && clockNow(other).rulesSince < clock.rulesSince)
          .sort(
            (a, b) => ascending(clockNow(a).rulesSince, clockNow(b).rulesSince) || ascending(a, b),
          )[0];
        if (sibling)
          tries.push({
            name: sibling,
            why: `same country and clock, on its current rules since ${rulesDate(clockNow(sibling))}`,
          });
      }
      if (steady[0])
        tries.push({
          name: steady[0],
          why: `same clock under ${BASELINE}'s rules too, on its current rules since ${rulesDate(clockNow(steady[0]))}`,
        });
    }
    if (tries.length) fallbacks.push([zone, tries]);
    else without.push(zone);
  }
  return { fallbacks, without, unknown, from, to, baselineDate };
}

// ------------------------------------------------------------------------------------------------ writing them

/** A paragraph as comment lines of at most 116 characters, the lines after the first indented by `hang`. */
function commentLines(text, hang = '') {
  const lines = [];
  let line = ' *';
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > 116) {
      lines.push(line);
      line = ` *${hang}`;
    }
    line += ` ${word}`;
  }
  return [...lines, line].join('\n');
}

function render(list) {
  const q = (s) => `'${s}'`;
  const offsets = list.refused.filter((n) => OFFSET.test(n));
  const abbreviations = list.refused.filter((n) => !OFFSET.test(n));
  const about = [
    'TIME_ZONES are the zones HandsFreeOS stores: every place in tzdb',
    "(its region files' zones and zone.tab's names) and UTC.",
    'TIME_ZONE_ALIASES are the older names browsers and phones still report,',
    "each with the zone it's stored as.",
    `Anything else is refused, including tzdb's own abbreviations (${abbreviations.join(', ')})`,
    `and its ${offsets.length} fixed offsets (Etc/GMT-14 to Etc/GMT+12).`,
    'Read them through intl/time-zones.ts. Browser-safe.',
  ];
  return `/**
 * Generated by scripts/time-zones.mjs from tzdb ${list.version}: don't edit.
 * Source: ${sourceOf(VERSION)}
 * SHA-256: ${SHA256}
 *
${commentLines(about.join(' '))}
 */

/** The tzdb release the list comes from. */
export const TZDB_VERSION = ${q(list.version)};

/** Every zone HandsFreeOS stores, sorted. */
export const TIME_ZONES: readonly string[] = [
${list.zones.map((z) => `  ${q(z)},`).join('\n')}
];

/** Older names, each with the zone it's stored as. */
export const TIME_ZONE_ALIASES: Readonly<Record<string, string>> = {
${list.aliases.map(([name, zone]) => `  ${q(name)}: ${q(zone)},`).join('\n')}
};
`;
}

function renderFallbacks(built) {
  const q = (s) => `'${s}'`;
  const span = `from ${isoDate(built.from)} to ${isoDate(built.to)}`;
  const paragraphs = [
    [
      `Intl on a phone reads the phone's own time-zone data, which can be older than tzdb ${VERSION}: Android 7.0, the`,
      'oldest the app supports, shipped data from 2016, and an Android 16 emulator image predates 2025b. Intl throws for',
      "a zone name its data doesn't have, so intl/engine-zones.ts tries the zone itself, then the names below in order,",
      'then UTC.',
    ],
    [
      `The zones below are the ${built.unknown.length} on core's list that tzdb ${BASELINE} (${isoDate(built.baselineDate)},`,
      "older than any supported phone's data) didn't have. For each, the script tries these, all worked out from tzdb's",
      `rules, where "keeps its clock" means the same UTC offset at every change ${span} (${WORDS[YEARS_BEFORE]} years`,
      `before ${VERSION} to ${WORDS[YEARS_AFTER]} after):`,
    ],
  ];
  const steps = [
    [
      `1. Its older names from tzdb's backward file that ${BASELINE} had, up to the first that already kept its clock`,
      `under ${BASELINE}'s rules (Europe/Kiev for Europe/Kyiv).`,
    ],
    [
      `2. When none did, and no zone from step 3 is in its country: the zone in its country that keeps its clock and`,
      "has been on its current rules longest, if they began before this zone's (America/Punta_Arenas for",
      "America/Coyhaique). Older phones may not have that one either, so step 3's zone follows it.",
    ],
    [
      `3. When none did: a zone ${BASELINE} had, on rules that began before ${BASELINE}, that keeps its clock under both`,
      `${BASELINE}'s rules and ${VERSION}'s, so a phone with any data in between shows the same clock. Same country`,
      "first, then the zone tzdb's zonenow.tab lists for that clock, then the one on its current rules longest, then",
      'by name.',
    ],
  ];
  const closing = [
    'packages/core/test/intl.test.ts checks every name here against its zone on Node: the same UTC offset daily from',
    'two years ago to five years ahead.',
    built.without.length
      ? `No name keeps the clock of ${built.without.join(', ')}: those show in UTC on a phone that doesn't know them.`
      : '',
    'Browser-safe.',
  ].filter(Boolean);

  const body = [
    ...paragraphs.map((p) => commentLines(p.join(' '))),
    steps.map((s) => commentLines(s.join(' '), '   ')).join('\n'),
    commentLines(closing.join(' ')),
  ].join('\n *\n');

  return `/**
 * Generated by scripts/time-zones.mjs from tzdb ${VERSION} and tzdb ${BASELINE}: don't edit.
 * Sources, each checked against its SHA-256:
 * - ${sourceOf(VERSION)}
 *   ${SHA256}
 * - ${sourceOf(BASELINE)}
 *   ${BASELINE_SHA256}
 *
${body}
 */

/** The tzdb release a phone's time-zone data is taken to be no older than. */
export const TZDB_BASELINE = ${q(BASELINE)};

/** For each zone a phone's data may not have, the names to try instead, in order. */
export const TIME_ZONE_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
${built.fallbacks
  .map(
    ([zone, tries]) =>
      `${tries.map((t) => `  // ${t.name}: ${t.why}.`).join('\n')}\n  ${q(zone)}: [${tries.map((t) => q(t.name)).join(', ')}],`,
  )
  .join('\n')}
};
`;
}

async function formatted(content, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(content, { ...options, filepath });
}

async function main() {
  const current = await fetchRelease(VERSION, SHA256);
  const baseline = await fetchRelease(BASELINE, BASELINE_SHA256);
  const list = buildList(current);
  const built = buildFallbacks(list, current, baseline);
  writeFileSync(OUT, await formatted(render(list), OUT));
  writeFileSync(FALLBACKS_OUT, await formatted(renderFallbacks(built), FALLBACKS_OUT));
  const counts = [
    `${list.zones.length} zones`,
    `${list.aliases.length} aliases`,
    `${list.refused.length} tzdb names refused`,
  ];
  console.log(`wrote ${relative(root, OUT)}: tzdb ${list.version}, ${counts.join(', ')}`);
  console.log(
    `wrote ${relative(root, FALLBACKS_OUT)}: ${built.fallbacks.length} of the ${built.unknown.length} zones ${BASELINE} didn't have`,
  );
  for (const [zone, tries] of built.fallbacks)
    console.log(`  ${zone} → ${tries.map((t) => t.name).join(', ')}`);
  if (built.without.length) console.log(`  no fallback: ${built.without.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
