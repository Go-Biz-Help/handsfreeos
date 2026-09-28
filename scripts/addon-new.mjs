#!/usr/bin/env node
/**
 * `pnpm addon:new <id> [--name "Property Management"] [--summary "…"] [--category operations] [--dry-run]`
 *
 * Starts an add-on from addons/_template (docs/addon-architecture.md): its manifest and server half in core, its
 * worker half, its migration and its test, and one line in each list that registers it. What it writes compiles and
 * passes the catalogue's checks as it stands. The add-on starts in `development`, so it's offered to nobody until
 * its manifest says otherwise.
 *
 * It refuses an id that isn't 2 to 16 lowercase letters, is reserved, is one of core's namespaces, or is taken, and
 * writes nothing at all if any file it would write is already there.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const TEMPLATE = join(ROOT, 'addons', '_template');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

// packages/core/src/addons/manifest.ts: RESERVED_ADDON_IDS and ADDON_CATEGORIES.
const RESERVED = new Set([
  'addon',
  'addons',
  'app',
  'auth',
  'core',
  'org',
  'platform',
  'private',
  'public',
  'support',
  'system',
  'test',
  'workspace',
]);
const CATEGORIES = [
  'sales',
  'marketing',
  'operations',
  'finance',
  'industry',
  'productivity',
  'ai',
];

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

function parse(argv) {
  const out = { id: null, name: null, summary: null, category: 'operations', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--name' || a === '--summary' || a === '--category') {
      const value = argv[++i];
      if (value === undefined) fail(`${a} needs a value.`);
      out[a.slice(2)] = value;
    } else if (a.startsWith('--')) fail(`Unknown option ${a}.`);
    else if (out.id === null) out.id = a;
    else fail(`One id at a time (got ${out.id} and ${a}).`);
  }
  return out;
}

/** The namespaces core's own commands and queries use (`crm`, `person`, …): an add-on can't take one. */
function coreNamespaces() {
  const names = new Set();
  for (const dir of ['commands', 'queries']) {
    const path = join(ROOT, 'packages', 'core', 'src', dir);
    for (const file of readdirSync(path)) {
      if (!file.endsWith('.ts')) continue;
      for (const m of readFileSync(join(path, file), 'utf8').matchAll(/name: '([a-z_]+)\./g))
        names.add(m[1]);
    }
  }
  return names;
}

/** A version above every migration there, from the clock when it can be. */
function nextMigrationVersion() {
  const versions = readdirSync(MIGRATIONS)
    .map((f) => f.split('_')[0])
    .filter((v) => /^\d{14}$/.test(v))
    .map(BigInt);
  const top = versions.reduce((a, b) => (b > a ? b : a), 0n);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const now = BigInt(
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`,
  );
  return String(now > top ? now : top + 100n);
}

/** Adds `entry` to the array `exportName` in `file`, and `importLine` after its last import. */
function register(file, exportName, entry, importLine) {
  let s = readFileSync(file, 'utf8');
  const start = s.indexOf(`export const ${exportName}`);
  if (start < 0) fail(`${relative(ROOT, file)} has no ${exportName}.`);
  const open = s.indexOf('[', s.indexOf('=', start));
  const close = s.indexOf('];', open);
  const entries = s
    .slice(open + 1, close)
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (entries.includes(entry)) fail(`${relative(ROOT, file)} already lists ${entry}.`);
  entries.push(entry);
  s = `${s.slice(0, open)}[\n${entries.map((e) => `  ${e},`).join('\n')}\n]${s.slice(close + 1)}`;
  const lastImport = s.lastIndexOf('\nimport ');
  const at = lastImport < 0 ? 0 : s.indexOf(';\n', lastImport) + 2;
  s = `${s.slice(0, at)}${importLine}\n${s.slice(at)}`;
  return s;
}

const input = parse(process.argv.slice(2));
const id = input.id;
if (!id) fail('Usage: pnpm addon:new <id> [--name "Its Name"] [--summary "…"] [--category …]');
if (!/^[a-z]{2,16}$/.test(id)) fail(`"${id}" must be 2 to 16 lowercase letters.`);
if (RESERVED.has(id)) fail(`"${id}" is reserved.`);
if (coreNamespaces().has(id)) fail(`"${id}" is one of core's namespaces.`);
if (!CATEGORIES.includes(input.category))
  fail(`--category must be one of ${CATEGORIES.join(', ')}.`);

const name = input.name ?? id.charAt(0).toUpperCase() + id.slice(1);
const summary = input.summary ?? `${name} for HandsFreeOS.`;
for (const [what, text, max] of [
  ['--name', name, 60],
  ['--summary', summary, 160],
])
  if (!text.trim() || text.length > max || /['\\`\n]/.test(text))
    fail(
      `${what} must be 1–${max} characters, with ’ rather than ' (and no backslash or backtick).`,
    );

const constName = `${id}Addon`;
const permissions = [
  {
    key: `${id}.use`,
    label: `Use ${name}`,
    description: `Everything ${name} does.`,
    defaultRoles: ['admin', 'member'],
  },
];
const values = {
  __ID__: id,
  __NAME__: name,
  __SUMMARY__: summary,
  __CATEGORY__: input.category,
  __CONST__: constName,
  __DIRECTORY__: summary.replace(/\.$/, '').toLowerCase(),
  __PERMISSIONS_JSON__: JSON.stringify(permissions).replaceAll("'", "''"),
};
const render = (template) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(key, value),
    readFileSync(join(TEMPLATE, template), 'utf8'),
  );

const files = [
  ['core/manifest.ts.tpl', `packages/core/src/addons/${id}/manifest.ts`],
  ['core/server.ts.tpl', `packages/core/src/addons/${id}/server.ts`],
  ['core/test.ts.tpl', `packages/core/test/addons/${id}.test.ts`],
  ['worker/index.ts.tpl', `apps/worker/src/addons/${id}/index.ts`],
  ['migration.sql.tpl', `supabase/migrations/${nextMigrationVersion()}_addon_${id}.sql`],
];
for (const [, to] of files) if (existsSync(join(ROOT, to))) fail(`${to} is already there.`);
if (readdirSync(MIGRATIONS).some((f) => f.endsWith(`_addon_${id}.sql`)))
  fail(`A migration for ${id} is already there.`);

const registrations = [
  [
    'packages/core/src/addons/catalog.ts',
    'ADDON_CATALOG',
    constName,
    `import { ${constName} } from './${id}/manifest';`,
  ],
  [
    'packages/core/src/addons/modules.ts',
    'ADDON_SERVER_MODULES',
    `${constName}Server`,
    `import { ${constName}Server } from './${id}/server';`,
  ],
  [
    'apps/worker/src/addons/modules.ts',
    'ADDON_WORKER_MODULES',
    `${constName}Worker`,
    `import { ${constName}Worker } from './${id}/index';`,
  ],
];
const edits = registrations.map(([file, list, entry, importLine]) => [
  file,
  register(join(ROOT, file), list, entry, importLine),
]);

if (input.dryRun) {
  console.log(`Would start ${name} (${id}):`);
  for (const [, to] of files) console.log(`  write  ${to}`);
  for (const [file] of edits) console.log(`  list   ${file}`);
  process.exit(0);
}

for (const [from, to] of files) {
  mkdirSync(dirname(join(ROOT, to)), { recursive: true });
  writeFileSync(join(ROOT, to), render(from));
}
for (const [file, text] of edits) writeFileSync(join(ROOT, file), text);

const touched = [...files.map(([, to]) => to), ...edits.map(([file]) => file)].filter(
  (f) => !f.endsWith('.sql'),
);
try {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'prettier'), ['--write', ...touched], {
    cwd: ROOT,
    stdio: 'ignore',
  });
} catch {
  console.warn('  (prettier did not run: format the files before committing)');
}

console.log(`✓ Started ${name} (${id}), in development: offered to nobody yet.\n`);
for (const [, to] of files) console.log(`  ${to}`);
for (const [file] of edits) console.log(`  ${file} (listed)`);
console.log(`
Next:
  node scripts/supabase.mjs migration up --local     its permissions and schema, locally
  pnpm --filter @hfos/core exec vitest run test/addons/${id}.test.ts
  Then read docs/addon-architecture.md: its kinds of records, its own tables, its screens and its AI tools.`);
