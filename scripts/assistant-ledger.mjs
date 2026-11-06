#!/usr/bin/env node
/**
 * The Assistant's checklist (packages/core/src/assistant/ledger): every item on every screen, every level down, each
 * marked with how Ask HandsFreeOS covers it. Each area records the fingerprint of every screen file as it was when its
 * items were checked; fingerprints.json holds them as they are now. An item whose file changed since its check goes
 * back on the list, and so does a screen file no area has checked yet.
 *
 *   node scripts/assistant-ledger.mjs                       rewrite fingerprints.json from the screen files as they are
 *   node scripts/assistant-ledger.mjs status [area]          what isn't marked: new screens, changed since their check,
 *                                                            not yet, partly, and the audit's open gaps
 *   node scripts/assistant-ledger.mjs stamp <area> [file…]   after checking an area's items again: record its files
 *                                                            (or just these ones) as checked as they are now
 *
 * Deploys run the first one before building the API, so Admin → Assistant coverage always compares with the code that
 * is live. See "Keeping the Assistant able to do everything" in docs/operations.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, 'packages/core/src/assistant/ledger');
const NOW = join(LEDGER, 'fingerprints.json');

/** Where screens live: each page and component a person sees, on the web and the phone, add-ons' included. */
const SCREEN_DIRS = [
  'apps/web/src/app',
  'apps/web/src/components',
  'apps/web/src/addons',
  'apps/mobile/src',
];
/** Not screens: tests, and the bare building blocks (a button, a card) every screen draws with. */
const NOT_SCREENS = [
  /(^|\/)__tests__\//,
  /\.test\.tsx$/,
  /\.stories\.tsx$/,
  /^apps\/web\/src\/components\/ui\//,
  /^apps\/mobile\/src\/components\/ui\//,
];

const posix = (p) => p.split(sep).join('/');

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx')) out.push(posix(relative(ROOT, full)));
  }
  return out;
}

/** Every screen file, sorted. */
function screenFiles() {
  return SCREEN_DIRS.flatMap((d) => walk(join(ROOT, d), []))
    .filter((f) => !NOT_SCREENS.some((re) => re.test(f)))
    .sort();
}

/** A file's fingerprint: its content's hash, line endings aside. */
const fingerprint = (file) =>
  createHash('sha1')
    .update(readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex')
    .slice(0, 12);

const areaFiles = () =>
  readdirSync(LEDGER)
    .filter((f) => f.endsWith('.json') && f !== 'fingerprints.json')
    .sort();
const readArea = (name) => JSON.parse(readFileSync(join(LEDGER, name), 'utf8'));

/** Every screen file, and every other file an area's items live in (a page's loader, a phone screen's hooks). */
const current = () => {
  const files = new Set(screenFiles());
  for (const name of areaFiles())
    for (const f of Object.keys(readArea(name).files)) if (existsSync(join(ROOT, f))) files.add(f);
  return Object.fromEntries([...files].sort().map((f) => [f, fingerprint(f)]));
};

/** One key per line, sorted, so two branches that touch different screens merge without a conflict. */
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function status(only) {
  const now = current();
  const checked = new Set();
  let unmarked = 0;
  for (const name of areaFiles()) {
    const area = readArea(name);
    for (const f of Object.keys(area.files)) checked.add(f);
    if (only && area.area !== only) continue;
    const changed = Object.entries(area.files)
      .filter(([f, print]) => now[f] !== print)
      .map(([f]) => (f in now ? f : `${f} (gone)`));
    const changedSet = new Set(changed.map((f) => f.replace(/ \(gone\)$/, '')));
    const items = area.items.filter(
      (i) => i.covered === 'no' || i.covered === 'partly' || changedSet.has(i.file.split(':')[0]),
    );
    const open = (area.gaps ?? []).filter((g) => g.status === 'open');
    if (!changed.length && !items.length && !open.length) continue;
    unmarked += items.length;
    console.log(`\n${area.area}: ${area.title}`);
    if (changed.length)
      console.log(`  changed since checked on ${area.checkedOn}: ${changed.join(', ')}`);
    const by = (c) => area.items.filter((i) => i.covered === c).length;
    console.log(
      `  ${area.items.length} items: ${by('yes')} covered, ${by('partly')} partly, ${by('no')} not yet, ${by('never')} never, ${by('person')} the person's own; ${items.length} to check`,
    );
    if (open.length) console.log(`  open gaps: ${open.map((g) => g.id).join(', ')}`);
  }
  const fresh = Object.keys(now).filter((f) => !checked.has(f));
  if (!only && fresh.length) {
    console.log(`\nScreens no area has checked yet (${fresh.length}):`);
    for (const f of fresh) console.log(`  ${f}`);
  }
  console.log(`\n${unmarked} items to check${only ? ` in ${only}` : ''}.`);
}

function stamp(areaKey, files) {
  const name = `${areaKey}.json`;
  if (!existsSync(join(LEDGER, name))) {
    console.error(
      `No area called ${areaKey}. The areas: ${areaFiles()
        .map((f) => f.slice(0, -5))
        .join(', ')}.`,
    );
    process.exit(1);
  }
  const area = readArea(name);
  const targets = files.length ? files : Object.keys(area.files);
  for (const f of targets) {
    if (!existsSync(join(ROOT, f))) {
      delete area.files[f];
      console.log(`${f}: gone, so taken off ${areaKey}`);
    } else area.files[f] = fingerprint(f);
  }
  area.files = Object.fromEntries(
    Object.entries(area.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  area.checkedOn = new Date().toISOString().slice(0, 10);
  writeJson(join(LEDGER, name), area);
  console.log(`${areaKey}: ${targets.length} files recorded as checked on ${area.checkedOn}.`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) {
  const now = current();
  writeJson(NOW, now);
  console.log(`${relative(ROOT, NOW)}: ${Object.keys(now).length} screen files.`);
} else if (cmd === 'status') status(rest[0]);
else if (cmd === 'stamp' && rest[0]) stamp(rest[0], rest.slice(1));
else {
  console.error('Usage: node scripts/assistant-ledger.mjs [status [area] | stamp <area> [file…]]');
  process.exit(1);
}
