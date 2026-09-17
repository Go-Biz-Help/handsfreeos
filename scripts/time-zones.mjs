#!/usr/bin/env node
/**
 * Core's list of time zones, generated from a pinned tzdb release, so a phone, the web and the server agree on which
 * zones are valid. Intl can't be asked: its answers differ by engine (iPhones accept "GMT+5", Android refuses "CST",
 * V8 reads "CST" as Chicago).
 *
 *   node scripts/time-zones.mjs    fetch the release below from IANA, check its SHA-256, write the list
 *
 * Writes packages/core/src/intl/time-zone-names.ts. To move to a newer tzdb, take the tarball's name and SHA-256
 * from https://data.iana.org/time-zones/releases/, set VERSION and SHA256, run this, and update the size snapshot
 * in packages/core/test/time-zones.test.ts. Nothing is saved but the list.
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
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import * as prettier from 'prettier';

const VERSION = '2026d';
const SOURCE = `https://data.iana.org/time-zones/releases/tzdata${VERSION}.tar.gz`;
const SHA256 = '0cb2aa8e333c3dc049badc42a0c61f21987b8cd44e107fa900bad764aacc7767';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'packages/core/src/intl/time-zone-names.ts');

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

// ------------------------------------------------------------------------------------------------ reading tzdb

async function fetchRelease() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`${SOURCE} answered ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(gz).digest('hex');
  if (sha !== SHA256)
    throw new Error(`${SOURCE} has SHA-256 ${sha}, not the pinned ${SHA256}. Nothing was written.`);
  return untar(gunzipSync(gz));
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
/** The zone names in a .tab file's third column. */
const tabNames = (text) =>
  text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t')[2]);

// ------------------------------------------------------------------------------------------------ building the list

function buildList(files) {
  const file = (name) => {
    const text = files.get(name);
    if (text === undefined) throw new Error(`tzdata${VERSION} has no ${name} file`);
    return text;
  };
  const version = file('version').trim();
  if (version !== VERSION) throw new Error(`The release says it is ${version}, not ${VERSION}`);

  const zones = new Set([
    'UTC',
    ...REGIONS.flatMap((f) => zoneNames(file(f))),
    ...tabNames(file('zone.tab')),
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

// ------------------------------------------------------------------------------------------------ writing it

/** A paragraph as comment lines of at most 116 characters. */
function commentLines(text) {
  const lines = [];
  let line = ' *';
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > 116) {
      lines.push(line);
      line = ' *';
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
 * Source: ${SOURCE}
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

async function main() {
  const list = buildList(await fetchRelease());
  const options = (await prettier.resolveConfig(OUT)) ?? {};
  writeFileSync(OUT, await prettier.format(render(list), { ...options, filepath: OUT }));
  const counts = [
    `${list.zones.length} zones`,
    `${list.aliases.length} aliases`,
    `${list.refused.length} tzdb names refused`,
  ];
  console.log(`wrote ${relative(root, OUT)}: tzdb ${list.version}, ${counts.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
