/**
 * Add-ons never reach into each other, and the rest of the code reaches an add-on only through its layer's list
 * (docs/addon-architecture.md). An add-on works with others through core — their events, core's records, the
 * kernel — never by importing their code, so one can be turned off or taken out without breaking another. Outside
 * the add-ons' folders, only the lists that register them import them: core's catalogue and module list, the
 * worker's module list, the web's registry, and an add-on's own pages.
 *
 * Read from the files, with each relative import resolved, so a sibling import (`../rent/…`) is caught as surely as
 * an absolute one. With no add-ons yet it guards what comes; the synthetic cases below prove it bites.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../../..');
/** Each layer's add-on folders, and the files of that layer allowed to import them. */
const LAYERS = [
  {
    root: 'packages/core/src/addons',
    code: 'packages/core/src',
    lists: ['packages/core/src/addons/catalog.ts', 'packages/core/src/addons/modules.ts'],
  },
  {
    root: 'apps/worker/src/addons',
    code: 'apps/worker/src',
    lists: ['apps/worker/src/addons/modules.ts'],
  },
  {
    root: 'apps/web/src/addons',
    code: 'apps/web/src',
    lists: ['apps/web/src/addons/registry.ts'],
  },
] as const;
/** An add-on's own pages, which may import its web folder: app/app/w/[workspaceId]/a/<id>/… */
const PAGES = 'apps/web/src/app/app/w/[workspaceId]/a';

const IMPORT =
  /(?:\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?|\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

interface SourceFile {
  /** Relative to the repository. */
  readonly path: string;
  readonly source: string;
}

/** The add-on a repository path is inside, as `<layer root>/<id>`, or null. */
function addonOf(path: string): string | null {
  for (const { root } of LAYERS) {
    if (!path.startsWith(`${root}/`)) continue;
    const id = path.slice(root.length + 1).split('/')[0]!;
    // A folder, not one of the layer's own files (catalog.ts, registry.ts…), which imports name without extension.
    const layerFile =
      id.includes('.') ||
      ['.ts', '.tsx'].some((ext) => existsSync(join(REPO, root, `${id}${ext}`)));
    if (!layerFile && !id.startsWith('_')) return id;
  }
  return null;
}

/** An add-on page's add-on id, or null. */
function pageAddonOf(path: string): string | null {
  if (!path.startsWith(`${PAGES}/`)) return null;
  const id = path.slice(PAGES.length + 1).split('/')[0]!;
  return id.startsWith('[') ? null : id;
}

/** Where an import from `from` lands, relative to the repository: only relative and `@/` imports can land in a folder. */
function landing(from: string, specifier: string, alias: string | null): string | null {
  if (specifier.startsWith('.'))
    return relative(REPO, resolve(REPO, dirname(from), specifier))
      .split(sep)
      .join('/');
  if (alias && specifier.startsWith('@/')) return `${alias}/${specifier.slice(2)}`;
  return null;
}

/** Every import that crosses an add-on boundary, as `file → specifier`. */
function boundaryViolations(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const mine = addonOf(f.path);
    const myPage = pageAddonOf(f.path);
    const isList = LAYERS.some((l) => (l.lists as readonly string[]).includes(f.path));
    const alias = f.path.startsWith('apps/web/src/') ? 'apps/web/src' : null;
    for (const m of f.source.matchAll(IMPORT)) {
      const target = landing(f.path, m[1]!, alias);
      if (!target) continue;
      const theirs = addonOf(target);
      if (!theirs) continue;
      if (mine !== null) {
        // Inside an add-on: its own folders in any layer only.
        if (theirs !== mine) out.push(`${f.path} → ${m[1]}`);
      } else if (myPage !== null) {
        if (theirs !== myPage) out.push(`${f.path} → ${m[1]}`);
      } else if (!isList) out.push(`${f.path} → ${m[1]}`);
    }
  }
  return out;
}

function sourcesUnder(dir: string): SourceFile[] {
  const abs = join(REPO, dir);
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) => {
    const path = `${dir}/${d.name}`;
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : sourcesUnder(path);
    return /\.tsx?$/.test(d.name) && statSync(join(REPO, path)).isFile()
      ? [{ path, source: readFileSync(join(REPO, path), 'utf8') }]
      : [];
  });
}

describe('add-on boundaries', () => {
  it('hold across core, the worker and the web', () => {
    const files = LAYERS.flatMap((l) => sourcesUnder(l.code));
    expect(files.length).toBeGreaterThan(100);
    expect(boundaryViolations(files)).toEqual([]);
  });

  it('catch an add-on importing another, and core importing an add-on outside its lists', () => {
    const f = (path: string, source: string): SourceFile => ({ path, source });
    expect(
      boundaryViolations([
        f('packages/core/src/addons/pm/server.ts', "import { x } from '../rent/server';"),
        f(
          'apps/worker/src/addons/pm/index.ts',
          "import type { y } from '../../addons/rent/index';",
        ),
        f('apps/web/src/addons/pm/panel.tsx', "const p = import('@/addons/rent/panel');"),
        f('packages/core/src/commands/task.ts', "export { z } from '../addons/pm/manifest';"),
        f(
          'apps/web/src/app/app/w/[workspaceId]/a/pm/page.tsx',
          "import { L } from '@/addons/rent/list';",
        ),
      ]),
    ).toHaveLength(5);
    expect(
      boundaryViolations([
        f(
          'packages/core/src/addons/pm/server.ts',
          "import { m } from './manifest';\nimport { d } from '../server';",
        ),
        f('packages/core/src/addons/catalog.ts', "import { pmAddon } from './pm/manifest';"),
        f('apps/worker/src/addons/modules.ts', "import { pmWorker } from './pm/index';"),
        f('apps/web/src/addons/registry.ts', "const load = () => import('./pm/person-panel');"),
        f(
          'apps/web/src/app/app/w/[workspaceId]/a/pm/page.tsx',
          "import { L } from '@/addons/pm/list';",
        ),
      ]),
    ).toEqual([]);
  });
});
