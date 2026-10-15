/**
 * The manifest the build writes (scripts/build.mjs): Facebook's sites from install, as its kit says; LinkedIn's only
 * as an optional host permission, asked for when the person turns LinkedIn on, never a required one (Chrome would ask
 * everyone again on update) and never a content script of the manifest's own; and nothing of the extension's
 * web-accessible, since LinkedIn's pages look for extensions by the files they show.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { facebook, linkedin } from '../src/networks';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

interface Manifest {
  readonly version: string;
  readonly description: string;
  readonly permissions: readonly string[];
  readonly host_permissions: readonly string[];
  readonly optional_host_permissions?: readonly string[];
  readonly content_scripts: readonly { readonly matches: readonly string[] }[];
  readonly web_accessible_resources?: unknown;
}

let out: string;
let manifest: Manifest;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'hfos-extension-'));
  const made = spawnSync(process.execPath, [join(root, 'scripts/build.mjs'), `--out=${out}`], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(made.status, made.stderr).toBe(0);
  manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Manifest;
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the manifest', () => {
  it('is this version, and says what it does in the stores’ 132 characters', () => {
    expect(manifest.version).toBe(version);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it('has Facebook’s sites from install, as its kit says, with its script', () => {
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([...facebook.hosts]));
    expect(manifest.content_scripts.flatMap((script) => script.matches)).toEqual([
      ...facebook.hosts,
    ]);
  });

  it('asks for LinkedIn only when it’s turned on: optional, and never its script or a file it shows', () => {
    expect(manifest.optional_host_permissions).toEqual([...linkedin.hosts]);
    const everywhere = JSON.stringify([manifest.host_permissions, manifest.content_scripts]);
    expect(everywhere).not.toContain('linkedin');
    expect(manifest.web_accessible_resources).toBeUndefined();
    // Registering its script while it's on needs this, which Facebook's tabs already did.
    expect(manifest.permissions).toContain('scripting');
  });
});
