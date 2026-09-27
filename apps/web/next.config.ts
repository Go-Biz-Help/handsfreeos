import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@hfos/core', '@hfos/api-client'],
  // The core barrel re-exports every schema and libphonenumber; load only the modules a page imports.
  experimental: { optimizePackageImports: ['@hfos/core'] },
  poweredByHeader: false,
};

export default nextConfig;
