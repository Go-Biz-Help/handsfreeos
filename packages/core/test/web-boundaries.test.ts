/**
 * The web app's safety nets stay where they are (FE-1, FE-4, 0108). A page that throws, or one that isn't there,
 * is drawn inside the business's shell, and the root has a last resort of its own; and every add-on page opens
 * through the gate, so an add-on that is off shows as "not available here" instead of its data or a crash.
 *
 * The web has no test runner of its own, so this reads its files, as settings-map.test.ts does. A boundary deleted,
 * or an add-on page written without the gate, fails here rather than in front of a customer.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '../../../apps/web/src');
const APP = join(WEB, 'app');
const BUSINESS = join(APP, 'app/w/[workspaceId]');
const read = (file: string) => readFileSync(file, 'utf8');

/** Every file under a folder, at any depth. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('error boundaries', () => {
  it('give the root a last resort that brings its own document', () => {
    const page = read(join(APP, 'global-error.tsx'));
    expect(page.startsWith("'use client';")).toBe(true);
    expect(page).toContain('<html');
    expect(page).toContain('<body');
    expect(page).toContain('retry');
  });

  it('keep a business’s shell around a page that throws or isn’t there', () => {
    const error = read(join(BUSINESS, 'error.tsx'));
    expect(error.startsWith("'use client';")).toBe(true);
    // Try again loads the page afresh; a refused load is shown as off or not found, not as a breakage.
    expect(error).toContain('retry');
    expect(error).toContain('pageRefusalOf');
    expect(existsSync(join(BUSINESS, 'not-found.tsx'))).toBe(true);
  });
});

describe('add-on pages', () => {
  it('answer any address under /a/ that no add-on page does', () => {
    expect(existsSync(join(BUSINESS, 'a/[addonId]/[[...path]]/page.tsx'))).toBe(true);
  });

  it('all open through the gate', () => {
    const pages = filesUnder(join(BUSINESS, 'a')).filter((f) => f.endsWith('/page.tsx'));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(read(page), relative(WEB, page)).toMatch(/\baddonPage\(/);
  });
});

/**
 * Settings → Add-ons holds the owner's decisions (2026-09-28) on who does what with add-ons. The server refuses the
 * rest whatever the screen shows; these keep the screen from offering what it shouldn't.
 */
describe('the Add-ons page', () => {
  const page = () => read(join(BUSINESS, 'add-ons/page.tsx'));

  it('is for owners and admins, and its link at the foot of the menu shows only to them', () => {
    expect(page()).toMatch(/if \(!can\(permissions, 'addons\.manage'\)\) notFound\(\);/);
    expect(read(join(WEB, 'components/shell/nav-links.tsx'))).toMatch(
      /if \(can\(permissions \?\? \[\], 'addons\.manage'\)\)\s*items\.push\(\{\s*key: 'add-ons'/,
    );
    // No longer a Settings tab: the old address sends people to the page.
    expect(read(join(WEB, 'components/settings/settings-nav.tsx'))).not.toContain(
      "label: 'Add-ons'",
    );
    expect(read(join(BUSINESS, 'settings/add-ons/page.tsx'))).toMatch(
      /redirect\(`\/app\/w\/\$\{workspaceId\}\/add-ons\$\{which\}`\)/,
    );
  });

  it('offers deleting an add-on’s data to owners only', () => {
    expect(page()).toContain("canPurge={can(permissions, 'addons.purge')}");
  });

  it('draws an add-on’s own settings form inside its own boundary', () => {
    const sheet = read(join(WEB, 'components/settings/add-ons/addon-settings-sheet.tsx'));
    expect(sheet).toMatch(/<AddonBoundary[^>]*>[\s\S]*<Form[\s\S]*<\/AddonBoundary>/);
  });

  it('is suggested on Home only to people who manage add-ons', () => {
    expect(read(join(BUSINESS, 'page.tsx'))).toMatch(
      /'addons\.manage'\)\s*\?\s*api\s*\.POST\('\/v1\/queries\/addon\.suggestion'/,
    );
  });

  it('tells Home about a vote only to people who manage add-ons', () => {
    expect(read(join(BUSINESS, 'page.tsx'))).toMatch(
      /'addons\.manage'\)\s*\?\s*api\s*\.POST\('\/v1\/queries\/addon\.news'/,
    );
  });

  it('asks for the vote only after the page has checked who is asking', () => {
    expect(page()).toMatch(/notFound\(\);[\s\S]*\.POST\('\/v1\/queries\/addon\.roadmap'/);
  });
});
