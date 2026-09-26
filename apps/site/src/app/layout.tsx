import type { Metadata } from 'next';
import { Hanken_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { Matomo } from '@/components/matomo';
import { OpinlyPixel } from '@/components/opinly';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { SupportChat } from '@/components/support-chat';
import { company, urls } from '@/content/site';
import './globals.css';

// One family. The product's JetBrains Mono is not loaded here: nothing on the site sets in mono, and a
// preloaded font competes with the page itself for a phone's first second.
const hanken = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-hanken', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(urls.site),
  title: {
    // Titles lead with what somebody would actually search for, and end with the name. The
    // headline on the page itself is still the human one; these are for the result list.
    default: 'AI receptionist and CRM for service businesses · HandsFreeOS',
    template: '%s · HandsFreeOS',
  },
  // No price: what is on sale changes by itself (0092), and a search result keeps this for weeks.
  description:
    'HandsFreeOS answers your calls and texts, books the job, sends the quote and chases the invoice — one system for small service businesses.',
  applicationName: 'HandsFreeOS',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'HandsFreeOS',
    url: urls.site,
    title: 'The CRM that doesn’t want you to use it',
    description:
      'It spots the lead, answers it, books the job, updates the record and brings you in when it matters. The less you use it, the better it’s working.',
    locale: 'en_US',
  },
  twitter: { card: 'summary_large_image' },
  authors: [{ name: company.legalName }],
  creator: company.legalName,
  publisher: company.legalName,
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-US" className={hanken.variable}>
      <body className="font-sans">
        <a
          href="#main"
          className="bg-accent text-white sr-only rounded-[10px] px-4 py-2 focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60]"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
        <SupportChat />
        <Matomo />
        <OpinlyPixel />
      </body>
    </html>
  );
}
