import { existsSync, readFileSync, statSync } from 'node:fs';
import type { NextConfig } from 'next';

/**
 * The browser extension this web app hands out (docs/outreach.md, decision 71): `build` and `dev` zip it into
 * public/downloads first (apps/extension/scripts/download.mjs), and the download button says its version and size.
 */
const EXTENSION_ZIP = 'public/downloads/hfos-social.zip';
const extension = JSON.parse(readFileSync('../extension/package.json', 'utf8')) as {
  version: string;
};

const nextConfig: NextConfig = {
  transpilePackages: ['@hfos/core', '@hfos/api-client'],
  // The core barrel re-exports every schema and libphonenumber; load only the modules a page imports.
  experimental: { optimizePackageImports: ['@hfos/core'] },
  poweredByHeader: false,
  env: {
    HFOS_EXTENSION_VERSION: extension.version,
    HFOS_EXTENSION_BYTES: existsSync(EXTENSION_ZIP) ? String(statSync(EXTENSION_ZIP).size) : '',
  },
};

export default nextConfig;
