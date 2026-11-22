#!/usr/bin/env node
/**
 * Notes when this version of the extension was made (release.json; docs/outreach.md, decision 189), which the
 * download in HandsFreeOS says beside its version as "Updated Nov 22, 1:20 AM", on each person's own clock
 * (apps/web/next.config.ts hands it to the button). Run it with every change of the version; test/download.test.ts
 * fails until release.json is this version's.
 *
 *   node scripts/stamp.mjs            package.json's version, made now
 *   node scripts/stamp.mjs 0.151.0    sets package.json's version first
 *
 * The moment is kept in the repo, never read from git or the build's clock: Vercel's copy of the repo is too shallow
 * to say when a file last changed, and every deploy builds the same extension again, so the build's own time would
 * say "updated" when nothing was.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageFile = join(root, 'package.json');
const asked = process.argv[2];

if (asked !== undefined && !/^\d+\.\d+\.\d+$/.test(asked)) {
  console.error(`“${asked}” isn’t a version. Give three numbers with dots between, like 0.151.0.`);
  process.exit(1);
}

let text = readFileSync(packageFile, 'utf8');
if (asked) {
  // Only the version's own line changes, so the file stays as Prettier keeps it.
  text = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${asked}$2`);
  writeFileSync(packageFile, text);
}
const { version } = JSON.parse(text);
// To the second, in UTC: the screens say it on each person's own clock.
const updatedAt = `${new Date().toISOString().slice(0, 19)}Z`;
writeFileSync(join(root, 'release.json'), `${JSON.stringify({ version, updatedAt }, null, 2)}\n`);
console.log(`HandsFreeOS Social ${version}, made ${updatedAt}.`);
