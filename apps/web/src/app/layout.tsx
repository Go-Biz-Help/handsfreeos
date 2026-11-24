import type { Metadata } from 'next';
import { Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { SignedInExtras } from '@/components/signed-in-extras';
import { Toaster } from '@/components/ui/toaster';
import { parseTheme, THEME_COOKIE, themeAttr } from '@/lib/theme';
import './globals.css';

const hanken = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-hanken', display: 'swap' });
// Not preloaded: a root layout's font is preloaded on every page, and 40 KB of it went to every booking page, form
// and invoice, which have nothing in it. A screen that shows a number or a code in it fetches it then (once: it's
// kept after), and `swap` shows the fallback meanwhile.
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
  preload: false,
});

export const metadata: Metadata = {
  title: { default: 'HandsFreeOS', template: '%s · HandsFreeOS' },
  description: 'Run the routine parts of your business and get brought in when it matters.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="en"
      data-theme={themeAttr(theme)}
      className={`${hanken.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans text-sm">
        {children}
        <Toaster />
        <SignedInExtras />
      </body>
    </html>
  );
}
