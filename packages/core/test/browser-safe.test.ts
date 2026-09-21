/**
 * Nothing the browser imports may reach a database driver.
 *
 * `@hfos/core` is bundled into the web app — middleware, server components and client components alike — while
 * `@hfos/core/server` is not. One value import of `sql` from `@hfos/db/client` anywhere in the first graph
 * drags the whole Postgres driver in, and the build dies with `Can't resolve 'fs'`, `'net'`, `'tls'` and
 * `'perf_hooks'` pointing at a file that looks perfectly innocent.
 *
 * It happened: `money/wallet-gate.ts` was exported from the browser-safe `money` barrel and broke every
 * deploy until somebody read a build log. **Nothing else could have caught it** — the import is valid
 * TypeScript, lint has no opinion, and every test here runs in Node where `fs` resolves fine. Only bundling
 * for a browser fails, which is slow, remote, and after the fact.
 *
 * So this walks the import graph from the browser entry and refuses a value import of a server-only module.
 * `import type` is fine and deliberately allowed: types vanish at build time, which is why the rule is so easy
 * to break — `import { sql, type Tx }` and `import type { Tx }` look the same at a glance and only one of them
 * is safe.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');

/** Packages that only exist on a server. Importing any of them for a value pulls Node built-ins in. */
const SERVER_ONLY = [/^@hfos\/db\/client$/, /^node:/, /^postgres$/];

/** Everything an ES module imports, split into the ones that survive the build and the ones that do not. */
function importsOf(file: string): { specifier: string; typeOnly: boolean }[] {
  const src = readFileSync(file, 'utf8');
  const out: { specifier: string; typeOnly: boolean }[] = [];
  // `import ... from 'x'`, `export ... from 'x'`, and the `import type` / `export type` forms of each.
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const clause = m[3] ?? '';
    // `import { type Tx }` is type-only too, but `import { sql, type Tx }` is not — so a clause counts as
    // erased only when every single name in it is marked.
    const names = clause
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const braced = clause.trim().startsWith('{');
    const allTypes = braced && names.length > 0 && names.every((n) => n.startsWith('type '));
    out.push({ specifier: m[4]!, typeOnly: Boolean(m[2]) || allTypes });
  }
  return out;
}

/** Resolve a relative import the way the bundler does, trying the file then its directory's index. */
function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')])
    if (existsSync(candidate)) return candidate;
  return null;
}

/** Every file reachable from an entry, and the first offending import found in each. */
function walk(entry: string): { file: string; specifier: string }[] {
  const seen = new Set<string>();
  const bad: { file: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const imp of importsOf(file)) {
      if (!imp.typeOnly && SERVER_ONLY.some((r) => r.test(imp.specifier)))
        bad.push({ file: file.slice(SRC.length + 1), specifier: imp.specifier });
      const next = resolveLocal(file, imp.specifier);
      if (next) queue.push(next);
    }
  }
  return bad;
}

describe('the browser entry', () => {
  it('never reaches a database driver, whatever it imports', () => {
    // Each entry is "file · what it imported". Moving the file to ../server.ts is almost always the fix.
    expect(walk(join(SRC, 'index.ts')).map((b) => `${b.file} · ${b.specifier}`)).toEqual([]);
  });

  it('sees the import that actually broke the build, so this test is worth having', () => {
    // The server entry legitimately does what the browser entry may not — proof the walk finds it rather than
    // passing because it looks at nothing.
    const found = walk(join(SRC, 'server.ts'));
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((b) => b.specifier)).toContain('@hfos/db/client');
  });
});
