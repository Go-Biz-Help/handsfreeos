/**
 * The build HandsFreeOS hands out (docs/outreach.md, decision 60; scripts/release.mjs): the version the app says beside
 * the download is this package's, and the zip it links to is there, the size the release wrote. A version bumped
 * without `pnpm --filter @hfos/extension release` fails here, so the download never lags the code.
 */
import { readFileSync, statSync } from 'node:fs';
import { EXTENSION_RELEASE } from '@hfos/core/addons/outreach/extension-release';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const zip = new URL('../../web/public/downloads/hfos-social.zip', import.meta.url);

describe('the build HandsFreeOS hands out', () => {
  it('is this version, released', () => {
    expect(EXTENSION_RELEASE.version).toBe(pkg.version);
    expect(EXTENSION_RELEASE.path).toBe(`/downloads/hfos-social.zip?v=${pkg.version}`);
  });

  it('is in the web app, the size the release wrote, with manifest.json at its top', () => {
    const bytes = readFileSync(zip);
    expect(statSync(zip).size).toBe(EXTENSION_RELEASE.bytes);
    // A zip's first file starts the archive: the local header's name follows its 30 bytes.
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    const names = bytes.toString('latin1');
    expect(names).toContain('manifest.json');
    expect(names).toContain('background.js');
  });
});
