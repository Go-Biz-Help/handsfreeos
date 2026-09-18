import type { Metadata } from 'next';
import { Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { company, urls } from '@/content/site';
import './globals.css';

const hanken = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-hanken', display: 'swap' });
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(urls.site),
  title: {
    default: 'HandsFreeOS — your business keeps answering while you are on the job',
    template: '%s · HandsFreeOS',
  },
  description:
    'One place for the calls, texts, email, calendar, quotes and invoices of a small service business, with an AI teammate that answers new leads in seconds and books them in.',
  applicationName: 'HandsFreeOS',
  openGraph: {
    type: 'website',
    siteName: 'HandsFreeOS',
    url: urls.site,
    title: 'Your business keeps answering while you are on the job',
    description:
      'Calls, texts, email, calendar, quotes and invoices in one place — with an AI teammate that answers new leads in seconds.',
  },
  twitter: { card: 'summary_large_image' },
  authors: [{ name: company.legalName }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${jetbrains.variable}`}>
      <body className="font-sans">
        <a
          href="#main"
          className="bg-accent text-on-solid sr-only rounded-[10px] px-4 py-2 focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60]"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
