/**
 * The manifest the build writes (scripts/build.mjs): its own key, so Chrome gives it the same id from any folder;
 * every network's sites from install (decision 85), Facebook's with its script and the others' scripts never the
 * manifest's own (registered while each is on); and nothing of the extension's web-accessible, since LinkedIn's pages
 * look for extensions by the files they show.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alignable, facebook, instagram, linkedin } from '../src/networks';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

interface Manifest {
  readonly version: string;
  readonly key: string;
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

  it('has LinkedIn’s, Instagram’s and Alignable’s sites from install, never their script or a file it shows', () => {
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([...linkedin.hosts, ...instagram.hosts, ...alignable.hosts]),
    );
    expect(manifest.optional_host_permissions).toBeUndefined();
    const scripts = JSON.stringify(manifest.content_scripts);
    for (const site of ['linkedin', 'instagram', 'alignable']) expect(scripts).not.toContain(site);
    expect(manifest.web_accessible_resources).toBeUndefined();
    // Registering their script while each is on needs this, which Facebook's tabs already did.
    expect(manifest.permissions).toContain('scripting');
  });

  it('asks to know when the person is away from their computer, so a read that needs the screen waits for it', () => {
    // Decision 120: chrome.idle, which shows no warning when it's installed.
    expect(manifest.permissions).toContain('idle');
  });

  it('has its own key, so Chrome gives it the same id from whatever folder it’s loaded from', () => {
    // Chrome's id: the first 32 hex digits of the key's SHA-256, each as a letter from a to p.
    const id = [
      ...createHash('sha256')
        .update(Buffer.from(manifest.key, 'base64'))
        .digest('hex')
        .slice(0, 32),
    ]
      .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
      .join('');
    expect(id).toBe('gdgihcnpgggcaijdhnfnkfcfmhpmailc');
  });
});
