#!/usr/bin/env node
/**
 * Every migration has a version of its own.
 *
 * Supabase keys `supabase_migrations.schema_migrations` by the leading timestamp alone, and the name beside it
 * is a label. So two files that begin with the same timestamp are one migration as far as the database is
 * concerned: the first to run is recorded, and the second is skipped — quietly, with no error anywhere, on
 * every environment for ever after.
 *
 * That is exactly what happened to `20261003000200`. Two branches picked the same number on the same day and
 * both merged; production recorded one of them and never ran the other, so a function the code had already
 * started calling did not exist and the page it was behind answered "Something went wrong on our side".
 *
 * Nothing else catches this. The tests run against a database built from these files, so a skipped migration
 * on a fresh stack is a missing object there too — but a collision between two branches only appears once both
 * have merged, which is after every check either of them ran. This is that check.
 *
 * It also refuses two files with the same **name**, which is the same accident from the other end: both
 * branches renumbered the very migration above, one to `…000300` and one to `…000400`, and main ended up
 * carrying it twice. Two versions, so the rule below was happy; one migration, so the database ran it twice
 * and its history stopped matching the folder.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'supabase', 'migrations');

const byVersion = new Map();
const byName = new Map();
for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const version = file.split('_')[0] ?? '';
  if (!/^\d{14}$/.test(version)) {
    console.error(
      `✗ ${file}\n  A migration starts with a 14-digit timestamp, then an underscore and a name.`,
    );
    process.exit(1);
  }
  const name = file.slice(version.length + 1);
  byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
  byName.set(name, [...(byName.get(name) ?? []), file]);
}

/** Says which files clashed, on whichever thing they clashed on, and stops. */
const refuse = (why, groups, remedy) => {
  console.error(`✗ ${why}\n`);
  for (const [key, files] of groups)
    console.error(`  ${key}\n${files.map((f) => `    ${f}`).join('\n')}`);
  console.error(`\n  ${remedy}`);
  process.exit(1);
};

const sameVersion = [...byVersion].filter(([, files]) => files.length > 1);
if (sameVersion.length > 0)
  refuse(
    'Two migrations cannot share a version. The database would run one and skip the rest.',
    sameVersion,
    'Renumber all but one of each group, above every version already there.',
  );

const sameName = [...byName].filter(([, files]) => files.length > 1);
if (sameName.length > 0)
  refuse(
    'Two migrations cannot share a name. One migration under two versions is run twice, and the ' +
      'database’s history stops matching this folder.',
    sameName,
    'Keep the one the hosted database has already recorded, and delete the rest.',
  );

console.log(`✓ ${byVersion.size} migrations, each with its own version and name.`);
