import type { Metadata } from 'next';
import { Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { SupportChat } from '@/components/support-chat';
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
    // Titles lead with what somebody would actually search for, and end with the name. The
    // headline on the page itself is still the human one; these are for the result list.
    default: 'AI receptionist and CRM for service businesses · HandsFreeOS',
    template: '%s · HandsFreeOS',
  },
  description:
    'HandsFreeOS answers your calls and texts, books the job, sends the quote and chases the invoice — one system for small service businesses, from $99 a month.',
  applicationName: 'HandsFreeOS',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'HandsFreeOS',
    url: urls.site,
    title: 'Your business keeps answering while you’re on the job',
    description:
      'Calls, texts, email, calendar, quotes and invoices in one place — with an AI teammate that answers new leads in seconds.',
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
    <html lang="en-US" className={`${hanken.variable} ${jetbrains.variable}`}>
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
      </body>
    </html>
  );
}
