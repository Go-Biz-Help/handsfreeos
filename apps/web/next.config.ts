import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@hfos/core', '@hfos/api-client'],
  poweredByHeader: false,
};

export default nextConfig;
