import { existsSync, readFileSync, statSync } from 'node:fs';
import type { NextConfig } from 'next';

/**
 * The browser extension this web app hands out (docs/outreach.md, decisions 71 and 189): `build` and `dev` zip it into
 * public/downloads first (apps/extension/scripts/download.mjs), and the download button says its version, when that
 * version was made (apps/extension/release.json, which the extension's `stamp` script writes) and its size.
 */
const EXTENSION_ZIP = 'public/downloads/hfos-social.zip';
const extension = JSON.parse(readFileSync('../extension/package.json', 'utf8')) as {
  version: string;
};
const release = JSON.parse(readFileSync('../extension/release.json', 'utf8')) as {
  version: string;
  updatedAt: string;
};

const nextConfig: NextConfig = {
  transpilePackages: ['@hfos/core', '@hfos/api-client'],
  // The core barrel re-exports every schema and libphonenumber; load only the modules a page imports.
  experimental: { optimizePackageImports: ['@hfos/core'] },
  poweredByHeader: false,
  env: {
    HFOS_EXTENSION_VERSION: extension.version,
    // Only this version's: a version changed without its stamp says no time, never an older version's.
    HFOS_EXTENSION_UPDATED: release.version === extension.version ? release.updatedAt : '',
    HFOS_EXTENSION_BYTES: existsSync(EXTENSION_ZIP) ? String(statSync(EXTENSION_ZIP).size) : '',
  },
};

export default nextConfig;
