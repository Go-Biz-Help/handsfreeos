import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    // Blog pictures come from Opinly's CDN (src/lib/opinly/paths.ts), and only from this account's folder of it.
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.opinly.ai', pathname: '/MzKcn0zBiTOQe3-OH3lIx/**' },
    ],
  },
  async redirects() {
    return [
      // The store listings and older notes point at /app; keep every spelling working.
      { source: '/mobile', destination: '/app', permanent: true },
      { source: '/what-it-does', destination: '/features', permanent: true },
      { source: '/privacy-policy', destination: '/privacy', permanent: true },
      { source: '/terms-of-service', destination: '/terms', permanent: true },
      { source: '/contact', destination: '/support', permanent: true },
      // Founding spots are bought, not applied for (20261027012700): the application page is gone.
      { source: '/founding', destination: '/pricing', permanent: true },
      // The product lives on its own subdomain; a stray link here should still land somewhere useful.
      { source: '/login', destination: 'https://app.handsfreeos.com/sign-in', permanent: false },
      { source: '/sign-in', destination: 'https://app.handsfreeos.com/sign-in', permanent: false },
      { source: '/sign-up', destination: 'https://app.handsfreeos.com/sign-up', permanent: false },
      {
        source: '/delete-account',
        destination: 'https://app.handsfreeos.com/delete-account',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
