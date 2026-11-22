/**
 * The download the web app hands out (docs/outreach.md, decision 71; scripts/download.mjs): run from a web app's
 * folder, it builds the extension for the HandsFreeOS that web app's settings name and zips it into its
 * public/downloads, with manifest.json at the top as Load unpacked needs; without the sign-in settings it stops. And
 * when this version was made (release.json, decision 189; scripts/stamp.mjs), which the download's button says.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/download.mjs', import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

let web: string;
beforeEach(() => {
  web = mkdtempSync(join(tmpdir(), 'hfos-web-'));
});
afterEach(() => rmSync(web, { recursive: true, force: true }));

/** Runs the script from the stand-in web app, with none of this shell's own web settings. */
function run(mode: string, settings: string, env: Record<string, string> = {}) {
  writeFileSync(join(web, '.env.local'), settings);
  const own = Object.entries(process.env).filter(([name]) => !name.startsWith('NEXT_PUBLIC_'));
  return spawnSync(process.execPath, [script, mode], {
    cwd: web,
    encoding: 'utf8',
    env: { ...Object.fromEntries(own), ...env },
  });
}

/** A zip's files by name, read from its central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(body) : body);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

const SETTINGS = [
  'NEXT_PUBLIC_API_URL=https://api.example.test',
  'NEXT_PUBLIC_WORKER_URL=https://hooks.example.test',
  'NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.example.test',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_from_the_web_app',
].join('\n');

describe('when this version was made', () => {
  it('is kept for this version, as a moment the download’s button can say', () => {
    const release = JSON.parse(
      readFileSync(new URL('../release.json', import.meta.url), 'utf8'),
    ) as { version: string; updatedAt: string };
    // After changing the version in package.json: `pnpm --filter @hfos/extension run stamp`.
    expect(release.version, 'release.json is another version’s: run the stamp script').toBe(
      version,
    );
    expect(release.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Number.isNaN(Date.parse(release.updatedAt))).toBe(false);
  });

  it('is stamped by the script, which sets the version too when it’s given one', () => {
    const root = mkdtempSync(join(tmpdir(), 'hfos-stamp-'));
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(
        fileURLToPath(new URL('../scripts/stamp.mjs', import.meta.url)),
        join(root, 'scripts/stamp.mjs'),
      );
      writeFileSync(
        join(root, 'package.json'),
        '{\n  "name": "x",\n  "version": "0.1.0",\n  "scripts": {}\n}\n',
      );
      const stamp = (...args: string[]) =>
        spawnSync(process.execPath, [join(root, 'scripts/stamp.mjs'), ...args], {
          encoding: 'utf8',
        });
      const read = (name: string) =>
        JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, string>;

      const before = Date.now();
      expect(stamp().status).toBe(0);
      expect(read('release.json')['version']).toBe('0.1.0');
      const at = Date.parse(read('release.json')['updatedAt']!);
      // To the second, so it may be up to a second before the moment it ran.
      expect(at).toBeGreaterThan(before - 1_000);
      expect(at).toBeLessThanOrEqual(Date.now());

      expect(stamp('0.2.0').status).toBe(0);
      expect(read('package.json')).toEqual({ name: 'x', version: '0.2.0', scripts: {} });
      expect(read('release.json')['version']).toBe('0.2.0');

      const wrong = stamp('newest');
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain('isn’t a version');
      expect(read('package.json')['version']).toBe('0.2.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the download the web app hands out', { timeout: 60_000 }, () => {
  it('is this version, for the HandsFreeOS the web app talks to, with manifest.json at the top', () => {
    const made = run('production', SETTINGS);
    expect(made.status, made.stderr).toBe(0);
    const zip = readFileSync(join(web, 'public/downloads/hfos-social.zip'));
    // The first file starts the archive, and it's at the top: no folder in its name.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const files = unzip(zip);
    expect([...files.keys()].every((name) => !name.startsWith('/'))).toBe(true);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      version: string;
      host_permissions: string[];
    };
    expect(manifest.version).toBe(version);
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        'https://api.example.test/*',
        'https://hooks.example.test/*',
        'https://abc.supabase.example.test/*',
      ]),
    );
    const background = files.get('background.js')!.toString('utf8');
    expect(background).toContain('sb_publishable_from_the_web_app');
    // A deploy's opens the setup on HandsFreeOS itself.
    expect(background).toContain('https://app.handsfreeos.com');
  });

  it('takes the environment over the files, as Next.js does, and is the same zip each time', () => {
    const first = run('development', SETTINGS, {
      NEXT_PUBLIC_API_URL: 'https://other.example.test',
    });
    expect(first.status, first.stderr).toBe(0);
    const zip = readFileSync(join(web, 'public/downloads/hfos-social.zip'));
    const background = unzip(zip).get('background.js')!.toString('utf8');
    expect(background).toContain('https://other.example.test');
    expect(background).toContain('http://localhost:3000');
    run('development', SETTINGS, { NEXT_PUBLIC_API_URL: 'https://other.example.test' });
    expect(readFileSync(join(web, 'public/downloads/hfos-social.zip')).equals(zip)).toBe(true);
  });

  it('stops without the sign-in settings, saying which', () => {
    const made = run('production', 'NEXT_PUBLIC_API_URL=https://api.example.test');
    expect(made.status).toBe(1);
    expect(made.stderr).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  });
});
